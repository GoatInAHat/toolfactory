import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { scaffoldDrift } from "../hosts/openclaw.js";
import type { Operation, Project } from "../model.js";
import { computeCoverage, renderCoverageMarkdown } from "../report/coverage.js";
import { HOST_DIR, OPENCLAW_SCAFFOLD, surface } from "./openclaw-native.js";

const echo: Operation = {
  name: "echo",
  description: "Return the text you pass in.",
  inputSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
  },
  requires: [],
};
const shoot: Operation = { name: "shoot", inputSchema: { type: "object" }, requires: ["browser"] };

function project(overrides: Partial<Project> = {}): Project {
  return {
    root: "/repo",
    tool: {
      schemaVersion: 1,
      identity: "package.json",
      binding: "typescript",
      surfaces: ["openclaw-native", "mcp"],
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

/** A zero-operation plugin whose whole contribution is one declared host registration. */
function voice(): Project {
  const base = project();
  return {
    ...base,
    tool: {
      ...base.tool,
      openclaw: {
        registers: [
          {
            api: "registerRealtimeVoiceProvider",
            contract: "realtimeVoiceProviders",
            ids: ["codex"],
          },
        ],
        pluginApi: ">=2026.8.2",
        dependencies: { ws: "^8.18.0" },
      },
    },
    operations: [],
  };
}

/** Every planned file as text: full files verbatim, region files as the region toolfactory owns. */
function emitted(target: Project): Record<string, string> {
  return Object.fromEntries(
    surface
      .plan(target)
      .map((file) => [
        file.path,
        file.kind === "file"
          ? file.content
          : file.kind === "region"
            ? file.regions.map((region) => region.content).join("")
            : JSON.stringify(file.patch),
      ]),
  );
}

describe("openclaw-native", () => {
  it("projects only the operations OpenClaw can run and pins the scaffold in one place", () => {
    const files = emitted(project());
    const manifest = JSON.parse(files[`${HOST_DIR}/openclaw.plugin.json`] ?? "{}");
    expect(manifest.contracts).toEqual({ tools: ["echo"] });
    expect(manifest.activation).toEqual({ onStartup: true });
    expect(surface.verdict?.(shoot, project())).toEqual({
      kind: "excluded",
      reason: "excluded:implement-in-hosts",
    });
    // The escape hatch is where the author writes it; the README has to say so.
    expect(files[`${HOST_DIR}/README.md`]).toContain("excluded:implement-in-hosts");
    expect(files[`${HOST_DIR}/README.md`]).toContain("`shoot` — requires browser");

    const pkg = JSON.parse(files[`${HOST_DIR}/package.json`] ?? "{}");
    expect(pkg.openclaw).toEqual({
      extensions: ["./dist/index.js"],
      compat: { pluginApi: OPENCLAW_SCAFFOLD.pluginApi },
      build: { openclawVersion: OPENCLAW_SCAFFOLD.openclawVersion },
    });
    // Nothing to expect of the inspector until the plugin declares a registration.
    expect(pkg.pluginInspector).toBeUndefined();
    // TypeScript core: in-process import of the author's module, no subprocess.
    expect(pkg.dependencies.hello).toBe("file:../..");
    expect(files[`${HOST_DIR}/src/index.ts`]).toContain('from "hello/dist/ops.js"');
    // JSON Schema goes through untouched via Type.Unsafe; $schema is what OpenClaw strips.
    expect(files[`${HOST_DIR}/src/index.ts`]).toContain('"text"');
    expect(files[`${HOST_DIR}/src/index.ts`]).not.toContain("$schema");
  });

  it("degrades a non-TypeScript core to an out-of-process shim", () => {
    const python = project({
      tool: { ...project().tool, binding: "python" },
    });
    expect(surface.verdict?.(echo, python)).toEqual({
      kind: "degraded",
      reason: "degraded:out-of-process",
    });
    const index = emitted(python)[`${HOST_DIR}/src/index.ts`] ?? "";
    expect(index).toContain('"run", "python", "-m", "hello.toolfactory.cli"');
    // The host's state directory reaches an out-of-process kernel as the environment variable
    // every surface reads it from.
    expect(index).toContain('env["HELLO_DATA_DIR"] = dataDir;');
    expect(index).not.toContain("ops.js");
    expect(JSON.parse(emitted(python)[`${HOST_DIR}/package.json`] ?? "{}").dependencies).toEqual(
      OPENCLAW_SCAFFOLD.dependencies,
    );
  });

  it("drives manifest, inspector and test from one `registers` declaration", () => {
    const target = voice();
    const files = emitted(target);
    const manifest = JSON.parse(files[`${HOST_DIR}/openclaw.plugin.json`] ?? "{}");
    expect(manifest.contracts).toEqual({ tools: [], realtimeVoiceProviders: ["codex"] });

    const pkg = JSON.parse(files[`${HOST_DIR}/package.json`] ?? "{}");
    expect(pkg.pluginInspector.plugin.expect).toEqual({
      registrations: ["registerRealtimeVoiceProvider"],
      manifestContracts: ["realtimeVoiceProviders"],
    });
    // The author's extra dependency merges after the scaffold's; the core is not imported at all.
    expect(pkg.dependencies).toEqual({ ...OPENCLAW_SCAFFOLD.dependencies, ws: "^8.18.0" });
    expect(pkg.peerDependencies.openclaw).toBe(">=2026.8.2");
    expect(pkg.openclaw.compat.pluginApi).toBe(">=2026.8.2");

    // The generated region stops at the entry: the registration itself is the author's tail.
    const region = files[`${HOST_DIR}/src/index.ts`] ?? "";
    expect(region).toContain("const entry = defineToolPlugin({");
    expect(region).not.toContain("registerRealtimeVoiceProvider(");
    expect(region).toContain('Parameters<OpenClawPluginApi["registerRealtimeVoiceProvider"]>[0]');
    expect(region).not.toContain("typebox");
    const template = surface.plan(target).find((file) => file.path.endsWith("src/index.ts"));
    expect(template?.kind === "region" && template.template).toContain("export default entry;");

    // The generated test records the registration the declaration promised.
    const test = files[`${HOST_DIR}/src/index.test.ts`] ?? "";
    expect(test).toContain("entry.register(api as OpenClawPluginApi)");
    expect(test).toContain('registered["registerRealtimeVoiceProvider"]');
    expect(files[`${HOST_DIR}/README.md`]).toContain("codex-app-server-extensions.ts");
  });

  it("reports what a zero-operation plugin contributes instead of an empty table", () => {
    const coverage = computeCoverage(voice(), [surface]);
    expect(coverage.rows).toEqual([]);
    const markdown = renderCoverageMarkdown(coverage, [], 7);
    expect(markdown).not.toContain("| operation |");
    expect(markdown).toContain(
      "`registerRealtimeVoiceProvider` → `realtimeVoiceProviders`: `codex`",
    );
  });
});

/** C2: the scaffold constants are only trustworthy while the real generator still writes them. */
function hasOpenclaw(): boolean {
  try {
    execFileSync("openclaw", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!hasOpenclaw())("openclaw scaffold", () => {
  it("still matches `openclaw plugins init --type tool`", () => {
    expect(scaffoldDrift(project())).toEqual([]);
    // A declared `pluginApi` is an intentional override, not drift.
    expect(scaffoldDrift(voice())).toEqual([]);
  });
});
