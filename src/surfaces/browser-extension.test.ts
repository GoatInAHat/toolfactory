import { describe, expect, it } from "vitest";
import type { Operation, PlannedFile, Project } from "../model.js";
import {
  surface as browserExtension,
  browserVerdict,
  HOST_DIR,
  permissions,
  WXT_PIN,
  zipName,
} from "./browser-extension.js";

const echo: Operation = { name: "echo", inputSchema: { type: "object" }, requires: [] };
const scrape: Operation = {
  name: "scrape",
  inputSchema: { type: "object" },
  requires: ["browser"],
};
const summarize: Operation = {
  name: "summarize",
  inputSchema: { type: "object" },
  requires: ["model"],
};

function fixture(overrides: Partial<Project["tool"]> = {}): Project {
  return {
    root: "/repo",
    tool: {
      schemaVersion: 1,
      identity: "plugin.json",
      binding: "typescript",
      surfaces: ["mcp", "web", "browser-extension"],
      bundle: { runtime: "package" },
      tests: { examples: { echo: { text: "hi" } } },
      ...overrides,
    },
    identity: {
      name: "hello.tool",
      version: "0.1.0",
      repository: "https://github.com/octo/hello",
    },
    identityExtra: {},
    operations: [echo, scrape, summarize],
    toolfactoryVersion: "0.1.0",
    packageManager: "npm",
  };
}

function planned(project: Project): Record<string, PlannedFile> {
  return Object.fromEntries(browserExtension.plan(project).map((file) => [file.path, file]));
}

function content(file: PlannedFile | undefined): string {
  if (file?.kind === "file") return file.content;
  if (file?.kind === "region") return file.regions.map((region) => region.content).join("");
  throw new Error("expected a whole or region file");
}

describe("browser-extension", () => {
  it("plans one WXT project: generated whole files, two regions the author owns, one merge", () => {
    const files = planned(fixture());
    expect(Object.keys(files).sort()).toEqual([
      `${HOST_DIR}/.gitignore`,
      `${HOST_DIR}/README.md`,
      `${HOST_DIR}/TARGETS.md`,
      `${HOST_DIR}/entrypoints/background.ts`,
      `${HOST_DIR}/entrypoints/example.content.ts`,
      `${HOST_DIR}/entrypoints/options/index.html`,
      `${HOST_DIR}/entrypoints/options/main.tsx`,
      `${HOST_DIR}/entrypoints/popup/index.html`,
      `${HOST_DIR}/entrypoints/popup/main.tsx`,
      `${HOST_DIR}/env.d.ts`,
      `${HOST_DIR}/package.json`,
      `${HOST_DIR}/tests/background.test.ts`,
      `${HOST_DIR}/tests/smoke.mjs`,
      `${HOST_DIR}/tsconfig.json`,
      `${HOST_DIR}/utils/mcp.ts`,
      `${HOST_DIR}/utils/page.css`,
      `${HOST_DIR}/utils/page.tsx`,
      `${HOST_DIR}/vitest.config.ts`,
      `${HOST_DIR}/web-ext-config.mjs`,
      `${HOST_DIR}/wxt.config.ts`,
    ]);
    // The manifest is never written here: WXT emits one per target out of these two inputs.
    expect(Object.keys(files)).not.toContain(`${HOST_DIR}/manifest.json`);
    expect(files[`${HOST_DIR}/package.json`]).toMatchObject({
      kind: "merge",
      patch: { name: "hello.tool-browser", devDependencies: { wxt: WXT_PIN } },
    });
    expect(files[`${HOST_DIR}/entrypoints/background.ts`]?.kind).toBe("region");
    expect(files[`${HOST_DIR}/wxt.config.ts`]?.kind).toBe("region");
    // WXT names an archive after `zip.name`, which the config sets to the tool's own name.
    expect(zipName(fixture(), "firefox")).toBe("hello.tool-0.1.0-firefox.zip");
    expect(content(files[`${HOST_DIR}/wxt.config.ts`])).toContain('zip: { name: "hello.tool" }');

    // The popup is the `web` surface's tree, imported; without it, only the pairing form ships.
    expect(content(files[`${HOST_DIR}/entrypoints/popup/main.tsx`])).toContain('from "@web/App"');
    const alone = planned(fixture({ surfaces: ["mcp", "browser-extension"] }));
    expect(content(alone[`${HOST_DIR}/entrypoints/popup/main.tsx`])).not.toContain("@web/App");
    expect(alone[`${HOST_DIR}/utils/page.css`]).toBeUndefined();
  });

  it("projects the manifest from capabilities, never from a hand-written permission list", () => {
    // `storage` for the pairing store; `activeTab` because an operation declares `browser`.
    expect(permissions(fixture(), [echo, scrape])).toEqual(["storage", "activeTab"]);
    expect(permissions(fixture(), [echo])).toEqual(["storage"]);
    expect(
      permissions(fixture({ browserExtension: { cookieExport: true, sidePanel: true } }), [echo]),
    ).toEqual(["storage", "cookies", "sidePanel"]);

    const config = content(planned(fixture())[`${HOST_DIR}/wxt.config.ts`]);
    // Loopback is portable only without a port (Firefox rejects a port in a match pattern), and
    // the declared session domains are added to it — never `<all_urls>`.
    expect(config).toContain(
      'const HOST_PERMISSIONS = ["http://127.0.0.1/*", "http://localhost/*"];',
    );
    expect(config).toContain('id: "hello.tool@octo.github.io"');
    const vandy = content(
      planned(fixture({ browserExtension: { authDomains: ["*://*.vanderbilt.edu/*"] } }))[
        `${HOST_DIR}/wxt.config.ts`
      ],
    );
    expect(vandy).toContain('"*://*.vanderbilt.edu/*"');
    // A Chromium-only permission is dropped from the other engines' manifests, not shipped dead.
    expect(config).toContain("CHROMIUM.includes(browser) || !CHROMIUM_ONLY.includes(permission)");
  });

  it("is native for browser and user-input operations, and degrades the export on Safari", () => {
    const project = fixture();
    expect(browserExtension.verdict?.(scrape, project)).toEqual({ kind: "native" });
    expect(browserExtension.verdict?.(summarize, project)).toEqual({
      kind: "excluded",
      reason: "excluded:no-model-bridge",
    });
    for (const engine of ["chromium", "firefox", "safari"] as const) {
      expect(browserVerdict(scrape, project, engine)).toEqual({ kind: "native" });
      expect(browserVerdict(summarize, project, engine).kind).toBe("excluded");
    }
    // Safari Web Extensions cannot read httpOnly cookies, so an opted-in export degrades there.
    const exporting = fixture({ browserExtension: { cookieExport: true } });
    expect(browserVerdict(scrape, exporting, "firefox")).toEqual({ kind: "native" });
    expect(browserVerdict(scrape, exporting, "safari")).toEqual({
      kind: "degraded",
      reason: "degraded:no-httponly-cookies",
    });
  });

  it("validates with the extension's own pinned CLIs, from inside the extension", () => {
    const project = fixture();
    const commands = browserExtension.validate?.(project) ?? [];
    expect(commands.map((command) => [command.command, ...command.args].join(" "))).toEqual([
      "npm install",
      "npm exec --no -- wxt prepare",
      expect.stringContaining("hosts/browser"),
      "npm exec --no -- wxt build",
      "npm exec --no -- wxt build -b firefox",
      "npm exec --no -- web-ext lint -s .output/firefox-mv2",
      "npm exec --no -- playwright install chromium",
      "npm run test",
      "node tests/smoke.mjs",
    ]);
    // wxt reads its entrypoints from the working directory, so every step runs in the host dir.
    expect(new Set(commands.map((command) => command.cwd))).toEqual(
      new Set([`/repo/${HOST_DIR}`, "/repo"]),
    );
  });
});
