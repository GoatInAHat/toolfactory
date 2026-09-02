import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Operation, Project } from "../model.js";
import { surface, WEB_PATH } from "./web.js";

const echo: Operation = {
  name: "echo",
  description: "Return the text you pass in.",
  inputSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: { text: { type: "string", description: "Text to echo back" } },
    required: ["text"],
  },
  requires: [],
};
const shoot: Operation = {
  name: "shoot",
  description: "Take a screenshot <of the current tab>.",
  inputSchema: { type: "object" },
  requires: ["browser"],
};

function project(overrides: Partial<Project> = {}): Project {
  return {
    root: "/repo",
    tool: {
      schemaVersion: 1,
      identity: "package.json",
      binding: "typescript",
      surfaces: ["web", "mcp", "cli"],
      bundle: { runtime: "package" },
      tests: { examples: {} },
    },
    identity: { name: "hello", version: "0.1.0", description: "Say hello" },
    identityExtra: {},
    operations: [echo, shoot],
    toolfactoryVersion: "0.1.0",
    ...overrides,
  };
}

function embeddedData(html: string): Record<string, unknown> {
  const match = html.match(/<script id="tf-data" type="application\/json">([\s\S]*?)<\/script>/);
  if (!match) throw new Error("tf-data script tag not found");
  return JSON.parse(match[1]);
}

describe("web", () => {
  it("plans exactly one static file, self-contained enough to open from file://", () => {
    const files = surface.plan(project());
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ kind: "file", path: WEB_PATH });
  });

  it("embeds the portable operations and omits mcp-excluded ones with a reason", () => {
    const html = (surface.plan(project())[0] as { content: string }).content;
    const data = embeddedData(html);

    expect(data.tool).toEqual({ name: "hello", version: "0.1.0", description: "Say hello" });
    expect(data.cliAvailable).toBe(true);
    expect(data.mcpProtocolVersion).toBe("2026-07-28");

    const operations = data.operations as Array<{ name: string; inputSchema: unknown }>;
    expect(operations.map((o) => o.name)).toEqual(["echo"]);
    expect(operations[0].inputSchema).toEqual(echo.inputSchema);

    const excluded = data.excluded as Array<{ name: string; reason?: string }>;
    expect(excluded).toEqual([{ name: "shoot", reason: "excluded:mcp-no-host-capabilities" }]);
    // The page must say *why* an operation is missing, not just drop it silently.
    expect(html).toContain("not reachable over MCP");
  });

  it("shares the excluded/native verdict with every other MCP-only surface", () => {
    expect(surface.verdict?.(echo, project())).toEqual({ kind: "native" });
    expect(surface.verdict?.(shoot, project())).toEqual({
      kind: "excluded",
      reason: "excluded:mcp-no-host-capabilities",
    });
  });

  it("escapes '<' in embedded JSON so a description can't close the inline <script> tag early", () => {
    const html = (surface.plan(project())[0] as { content: string }).content;
    expect(html).not.toContain("</of the current tab>");
    // Round-trips back through JSON.parse to the original text.
    const excluded = embeddedData(html).excluded as Array<{ name: string }>;
    expect(excluded).toEqual([{ name: "shoot", reason: "excluded:mcp-no-host-capabilities" }]);
  });

  it("pins React consistently between the page's own import and the CDN bundles it imports", () => {
    const html = (surface.plan(project())[0] as { content: string }).content;
    // jsDelivr's `+esm` output re-exposes each package's own deps as further
    // /npm/<pkg>@<version>/+esm imports; RJSF's bundle resolves React to a version fixed at
    // that combination's build time. If this page's own React/ReactDOM import ever drifts
    // from that pinned version, two React copies load and RJSF's hooks break at runtime
    // ("Invalid hook call") — a failure Playwright would catch but a unit test can catch for
    // free by asserting the two import statements agree.
    const reactImport = html.match(/cdn\.jsdelivr\.net\/npm\/react@([\d.]+)\/\+esm/);
    const reactDomImport = html.match(/cdn\.jsdelivr\.net\/npm\/react-dom@([\d.]+)\/client\/\+esm/);
    expect(reactImport).not.toBeNull();
    expect(reactDomImport?.[1]).toBe(reactImport?.[1]);
    expect(html).toContain(`@rjsf/core@`);
    expect(html).toContain(`@rjsf/validator-ajv8@`);
  });

  it("says there are no operations yet instead of shipping an empty shell silently", () => {
    const html = (surface.plan(project({ operations: [] }))[0] as { content: string }).content;
    const data = embeddedData(html);
    expect(data.operations).toEqual([]);
    expect(html).toContain("No operations reach the web UI yet");
  });

  it("previews the CLI only when the cli surface is also selected", () => {
    const html = (
      surface.plan(project({ tool: { ...project().tool, surfaces: ["web", "mcp"] } }))[0] as {
        content: string;
      }
    ).content;
    expect(embeddedData(html).cliAvailable).toBe(false);
  });
});

/** Whether a real browser can be driven from this checkout: `playwright` is not a toolfactory
 * dependency (this surface is pure HTML/JS with no build step), so this only runs where a
 * developer or CI job has installed it locally. */
function hasPlaywright(): boolean {
  try {
    createRequire(import.meta.url).resolve("playwright");
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!hasPlaywright())("rendered in a real browser", () => {
  it("renders the echo form and previews the CLI invocation after submit", async () => {
    // A plain `require`, not a statically-typed `import`: `playwright` has no type
    // declarations reachable from this project (it is intentionally not a toolfactory
    // dependency), and a dynamic `import()` specifier is resolved by tsc even when the
    // branch that reaches it is skipped at runtime.
    // biome-ignore lint/suspicious/noExplicitAny: playwright is loaded only when present, untyped here on purpose
    const { chromium } = createRequire(import.meta.url)("playwright") as any;
    const executablePath = chromium.executablePath();
    if (!existsSync(executablePath)) {
      // playwright resolves but `npx playwright install` was never run here.
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), "toolfactory-web-"));
    const htmlPath = join(dir, "index.html");
    writeFileSync(htmlPath, (surface.plan(project())[0] as { content: string }).content);

    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      // Serve each jsDelivr module through Node's own fetch instead of the browser's network
      // stack: functionally identical bytes, but avoids depending on whatever the sandbox's
      // outbound network policy does with ~25 small parallel CDN requests.
      const cache = new Map<string, { body: Buffer; contentType: string }>();
      // biome-ignore lint/suspicious/noExplicitAny: playwright's Route type isn't available here
      await page.route("https://cdn.jsdelivr.net/**", async (route: any) => {
        const url = route.request().url();
        if (!cache.has(url)) {
          const response = await fetch(url);
          cache.set(url, {
            body: Buffer.from(await response.arrayBuffer()),
            contentType: response.headers.get("content-type") ?? "application/javascript",
          });
        }
        const cached = cache.get(url);
        if (!cached) throw new Error(`unreachable: ${url}`);
        await route.fulfill({ status: 200, contentType: cached.contentType, body: cached.body });
      });

      await page.goto(`file://${htmlPath}`);
      await page.waitForSelector('nav button:has-text("echo")', { timeout: 20_000 });

      const input = page.locator('input[id$="_text"]').first();
      await input.waitFor({ state: "visible", timeout: 20_000 });
      await input.fill("hello from vitest");
      await page.locator('button[type="submit"]').first().click();

      const cliPreview = page.locator(".preview pre").first();
      await cliPreview.waitFor({ state: "visible", timeout: 20_000 });
      expect(await cliPreview.textContent()).toBe(
        `hello echo --json '${JSON.stringify({ text: "hello from vitest" })}'`,
      );
    } finally {
      await browser.close();
    }
  }, 30_000);
});
