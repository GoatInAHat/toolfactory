import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { scaffoldDrift } from "../hosts/openclaw.js";
import type { Operation, Project } from "../model.js";
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

function emitted(target: Project): Record<string, string> {
  return Object.fromEntries(
    surface.plan(target).map((file) => [file.path, file.kind === "file" ? file.content : ""]),
  );
}

describe("openclaw-native", () => {
  it("projects only the operations OpenClaw can run and pins the scaffold in one place", () => {
    const files = emitted(project());
    const manifest = JSON.parse(files[`${HOST_DIR}/openclaw.plugin.json`] ?? "{}");
    expect(manifest.contracts.tools).toEqual(["echo"]);
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
    expect(index).not.toContain("ops.js");
    expect(JSON.parse(emitted(python)[`${HOST_DIR}/package.json`] ?? "{}").dependencies).toEqual(
      OPENCLAW_SCAFFOLD.dependencies,
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
  });
});
