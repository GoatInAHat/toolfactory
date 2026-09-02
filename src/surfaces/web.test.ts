import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { run } from "../commands.js";
import { DRIFT_ENTRY } from "../hosts/web.js";
import type { Operation, Project } from "../model.js";
import { apply, deepMerge, replaceRegions } from "../project/apply.js";
import { json } from "./shared.js";
import { APP_BEGIN, APP_END, surface, WEB_DIR, WEB_SCAFFOLD } from "./web.js";

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
  description: "Take a screenshot of the current tab.",
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

/** Every planned file as text, region files rendered fresh (as `apply()` writes them the first time). */
function planned(from: Project = project()): Map<string, string> {
  return new Map(
    surface.plan(from).map((file) => {
      if (file.kind === "file") return [file.path, file.content];
      if (file.kind === "region")
        return [file.path, replaceRegions(file.template, file) ?? file.template];
      return [file.path, json(deepMerge({}, file.patch))];
    }),
  );
}

function opsJson(from: Project = project()): Record<string, unknown> {
  return JSON.parse(planned(from).get(`${WEB_DIR}/src/ops.json`) ?? "");
}

describe("web", () => {
  it("plans the vite + shadcn project and leaves src/components/ui to the shadcn CLI", () => {
    expect([...planned().keys()]).toEqual([
      "web/.oxlintrc.json",
      "web/components.json",
      "web/index.html",
      "web/package.json",
      "web/smoke.mjs",
      "web/src/App.tsx",
      "web/src/index.css",
      "web/src/lib/utils.ts",
      "web/src/main.tsx",
      "web/src/ops.json",
      "web/src/schema-form.tsx",
      "web/tsconfig.app.json",
      "web/tsconfig.json",
      "web/tsconfig.node.json",
      "web/vite.config.ts",
    ]);
  });

  it("App.tsx is a region file: the operations page is generated, the pages array and shell are the author's and survive a rebuild", () => {
    const target = project();
    const file = surface
      .plan(target)
      .find((candidate) => candidate.path === `${WEB_DIR}/src/App.tsx`);
    if (file?.kind !== "region") throw new Error("web/src/App.tsx is no longer a region file");
    expect(file.regions).toHaveLength(1);
    expect(file.regions[0].begin).toBe(APP_BEGIN);
    expect(file.regions[0].end).toBe(APP_END);
    expect(file.regions[0].content).toContain("export function OperationsPage()");
    expect(file.template).toContain(
      "export const pages: { id: string; title: string; element: ReactNode }[]",
    );
    expect(file.template).toContain(
      '{ id: "operations", title: "Operations", element: <OperationsPage /> }',
    );
    expect(file.template).toContain("export default function App()");

    // Round-trip through the real writer: scaffold, let the author add a page below the
    // marker (as vutoolkit adds its d3 degree-planner graph), then run a second `toolfactory
    // build` (a changed operation set, same as a real `introspect` picking up new tools) and
    // check the added page is still there.
    const root = mkdtempSync(join(tmpdir(), "toolfactory-web-app-"));
    apply(root, surface.plan(target), "0.1.0");
    const appPath = join(root, WEB_DIR, "src/App.tsx");
    const authored = readFileSync(appPath, "utf8").replace(
      '{ id: "operations", title: "Operations", element: <OperationsPage /> },',
      '{ id: "operations", title: "Operations", element: <OperationsPage /> },\n  { id: "planner", title: "Degree planner", element: <div>planner</div> },',
    );
    writeFileSync(appPath, authored);

    const rebuilt = project({ operations: [echo] });
    apply(root, surface.plan(rebuilt), "0.1.0");
    const after = readFileSync(appPath, "utf8");
    expect(after).toContain(
      '{ id: "planner", title: "Degree planner", element: <div>planner</div> },',
    );
    expect(after).toContain("export function OperationsPage()");
  });

  it("web/package.json is a merge file, so an author-added dependency (e.g. `npm --prefix web install d3` for a page) survives a rebuild", () => {
    const target = project();
    const file = surface
      .plan(target)
      .find((candidate) => candidate.path === `${WEB_DIR}/package.json`);
    if (file?.kind !== "merge") throw new Error("web/package.json is no longer a merge file");

    const root = mkdtempSync(join(tmpdir(), "toolfactory-web-pkg-"));
    apply(root, surface.plan(target), "0.1.0");
    const pkgPath = join(root, WEB_DIR, "package.json");
    const authored = JSON.parse(readFileSync(pkgPath, "utf8"));
    authored.dependencies.d3 = "^7.9.0";
    writeFileSync(pkgPath, json(authored));

    apply(root, surface.plan(project({ operations: [echo] })), "0.1.0");
    const after = JSON.parse(readFileSync(pkgPath, "utf8"));
    expect(after.dependencies.d3).toBe("^7.9.0");
    expect(after.dependencies.react).toBe(WEB_SCAFFOLD.packageJson.dependencies.react);
  });

  it("snapshots the operations this surface carries and says why the others are missing", () => {
    const data = opsJson();
    expect(data.tool).toEqual({ name: "hello", version: "0.1.0", description: "Say hello" });
    expect(data.mcpProtocolVersion).toBe("2026-07-28");
    expect(data.defaultEndpoint).toBe("/mcp");

    const operations = data.operations as { name: string; inputSchema: unknown }[];
    expect(operations.map((operation) => operation.name)).toEqual(["echo"]);
    expect(operations[0]?.inputSchema).toEqual(echo.inputSchema);
    expect(data.excluded).toEqual([{ name: "shoot", reason: "excluded:mcp-no-host-capabilities" }]);
    expect(surface.verdict?.(shoot, project())).toEqual({
      kind: "excluded",
      reason: "excluded:mcp-no-host-capabilities",
    });
  });

  it("src/ops.json is an output file: a lossy duplicate rebuilt by `npm run build`, not tracked (D8)", () => {
    const file = surface
      .plan(project())
      .find((candidate) => candidate.path === `${WEB_DIR}/src/ops.json`);
    if (file?.kind !== "file") throw new Error("web/src/ops.json is no longer a plain file");
    expect(file.output).toBe(true);
  });

  it('vite.config.ts reads base from PAGES_BASE so a GitHub Pages project page (served from /<repo>/) doesn\'t break `npm run dev` at "/"', () => {
    const content = planned().get(`${WEB_DIR}/vite.config.ts`) ?? "";
    expect(content).toContain('base: process.env.PAGES_BASE ?? "/"');
  });

  it("previews the CLI only when the cli surface is also selected", () => {
    expect(opsJson().cliAvailable).toBe(true);
    const without = project({ tool: { ...project().tool, surfaces: ["web", "mcp"] } });
    expect(opsJson(without).cliAvailable).toBe(false);
  });

  it("emits the pinned scaffold verbatim, so the drift check speaks for plan()", () => {
    const files = planned();
    expect(files.get("web/src/index.css")).toBe(WEB_SCAFFOLD.indexCss);
    expect(files.get("web/src/lib/utils.ts")).toBe(WEB_SCAFFOLD.utils);
    for (const [path, content] of Object.entries(WEB_SCAFFOLD.vite)) {
      // The two tsconfigs gain the `@/*` alias; the rest travel unchanged.
      const emitted = files.get(`web/${path}`) ?? "";
      if (path === "tsconfig.json" || path === "tsconfig.app.json") {
        expect(emitted).toContain('"@/*": ["./src/*"]');
      } else if (path !== "vite.config.ts") {
        expect(emitted).toBe(content);
      }
    }
    expect(JSON.parse(files.get("web/components.json") ?? "")).toEqual(WEB_SCAFFOLD.componentsJson);

    const packageJson = JSON.parse(files.get("web/package.json") ?? "");
    expect(packageJson.dependencies).toEqual(WEB_SCAFFOLD.packageJson.dependencies);
    expect(packageJson.devDependencies).toMatchObject(WEB_SCAFFOLD.packageJson.devDependencies);
    expect(packageJson.devDependencies.playwright).toBe(WEB_SCAFFOLD.playwright);

    // Every component the page imports is one `validate()` asks the shadcn CLI for.
    const sources = `${files.get("web/src/App.tsx")}${files.get("web/src/schema-form.tsx")}`;
    const imported = [...sources.matchAll(/@\/components\/ui\/([a-z-]+)/g)].map(
      (match) => match[1],
    );
    expect(imported.length).toBeGreaterThan(0);
    expect(WEB_SCAFFOLD.components).toEqual(expect.arrayContaining(imported));
  });
});

/**
 * The whole validator chain, run the way `toolfactory validate --surface web` runs it. Needs
 * npm (every step installs from the registry) and a Playwright browser download for the smoke,
 * so it self-skips where neither the author nor CI has one.
 */
function browserAvailable(): boolean {
  const browsers = process.env.PLAYWRIGHT_BROWSERS_PATH ?? join(homedir(), ".cache/ms-playwright");
  return existsSync(browsers) && spawnSync("npm", ["--version"]).status === 0;
}

describe.skipIf(!browserAvailable())("validated the way an author runs it", () => {
  it("installs, adds the components, proves the scaffold, builds and smokes the page", () => {
    const root = mkdtempSync(join(tmpdir(), "toolfactory-web-"));
    const fixture = project({ root });
    for (const [path, content] of planned(fixture)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    }
    // What `loadProject` needs, so the drift script can re-plan from the same project.
    mkdirSync(join(root, "dev.toolfactory"), { recursive: true });
    writeFileSync(join(root, "dev.toolfactory/tool.json"), json(fixture.tool));
    writeFileSync(
      join(root, "dev.toolfactory/ops.json"),
      json({
        tools: [echo, shoot].map(({ requires, ...tool }) => ({
          ...tool,
          _meta: { "dev.toolfactory": { requires } },
        })),
      }),
    );
    writeFileSync(join(root, "package.json"), json(fixture.identity));

    for (const command of surface.validate?.(fixture) ?? []) {
      // Vitest runs this file from source, so the drift entry is still TypeScript: give node
      // the loader from this checkout, where `tsx` is installed.
      const outcome = run(
        command.args.includes(DRIFT_ENTRY)
          ? { ...command, args: ["--import", "tsx", DRIFT_ENTRY, root], cwd: process.cwd() }
          : command,
      );
      expect(outcome.ok, `${outcome.label}: ${outcome.output}`).toBe(true);
      if (outcome.label.includes("smoke")) expect(outcome.output).toContain("PASS cli preview");
    }
  }, 900_000);
});
