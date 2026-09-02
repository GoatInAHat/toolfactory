import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import type { Operation, Project } from "../model.js";
import { HOST_DIR, pluginDir, surface } from "./hermes-native.js";

const echo: Operation = {
  name: "echo",
  description: "Return the text you pass in.",
  inputSchema: {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
  },
  outputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
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
      surfaces: ["hermes-native", "cli"],
      bundle: { runtime: "package" },
      tests: { examples: { echo: { text: "hi" } } },
      config: {
        type: "object",
        properties: {
          apiKey: {
            description: "Acme key",
            "x-toolfactory": { sensitive: true, url: "https://a" },
          },
          region: { description: "Acme region" },
        },
        required: ["apiKey"],
      },
      ...overrides.tool,
    },
    identity: { name: "hello", version: "1.2.0", description: "Say hello" },
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

const python = project({ tool: { ...project().tool, binding: "python" } });

describe("hermes-native", () => {
  it("projects the manifest Hermes parses and the credentials it prompts for", () => {
    const files = emitted(project());
    const manifest = parseYaml(files[`${pluginDir(project())}/plugin.yaml`] ?? "") as Record<
      string,
      // biome-ignore lint/suspicious/noExplicitAny: manifest is untyped upstream YAML
      any
    >;
    // 1, not the loader's newer-supported 2: `hermes plugins install`'s own cap is still stuck
    // at 1 and rejects a v2 manifest outright, even though the loader and `doctor` accept it.
    expect(manifest.manifest_version).toBe(1);
    expect(manifest.name).toBe("hello");
    // Only what the surface can actually run: `shoot` is excluded, so it is never advertised.
    expect(manifest.provides_tools).toEqual(["echo"]);
    expect(surface.verdict?.(shoot, project())).toEqual({
      kind: "excluded",
      reason: "excluded:implement-in-hosts",
    });
    // One credential declaration becomes the rich env form Hermes' config UI prompts from.
    expect(manifest.requires_env).toEqual([
      {
        name: "APIKEY",
        description: "Acme key",
        secret: true,
        url: "https://a",
      },
    ]);
    expect(manifest.optional_env.map((entry: { name: string }) => entry.name)).toEqual([
      "REGION",
      "HELLO_ROOT",
    ]);

    const pyproject = parseToml(files[`${HOST_DIR}/pyproject.toml`] ?? "") as Record<
      string,
      // biome-ignore lint/suspicious/noExplicitAny: TOML is untyped
      any
    >;
    expect(pyproject.project["entry-points"]["hermes_agent.plugins"]).toEqual({
      hello: "hello_hermes:register",
    });
  });

  it("shims a TypeScript core out of process and calls a Python core in it", () => {
    const shim = emitted(project())[`${pluginDir(project())}/__init__.py`] ?? "";
    expect(surface.verdict?.(echo, project())).toEqual({
      kind: "degraded",
      reason: "degraded:out-of-process",
    });
    expect(shim).toContain('KERNEL = ["node", "--import", "tsx", "src/toolfactory/cli.ts"]');
    expect(shim).toContain('_ROOT = os.environ.get("HELLO_ROOT")');
    // Hermes' own per-plugin data directory reaches the kernel through the shared variable.
    expect(shim).toContain('os.environ.setdefault("HELLO_DATA_DIR", str(ctx.state.data_dir))');

    const native = emitted(python)[`${pluginDir(python)}/__init__.py`] ?? "";
    expect(surface.verdict?.(echo, python)).toEqual({ kind: "native" });
    expect(native).toContain("from hello.ops import OPERATIONS");
    expect(native).not.toContain("subprocess");
    // The published wheel resolves the pin; the checkout resolves the uv path source.
    const pyproject = parseToml(emitted(python)[`${HOST_DIR}/pyproject.toml`] ?? "") as Record<
      string,
      // biome-ignore lint/suspicious/noExplicitAny: TOML is untyped
      any
    >;
    expect(pyproject.project.dependencies).toEqual(["hello>=1.2.0,<2"]);
    expect(pyproject.tool.uv.sources.hello).toEqual({ path: "../..", editable: true });
  });

  it("emits a fake-ctx test that registers and calls a real handler, no Hermes import", () => {
    const shim = emitted(project())[`${HOST_DIR}/tests/test_plugin.py`] ?? "";
    expect(shim).not.toMatch(/^\s*(import|from) hermes/m);
    expect(shim).toContain("from hello_hermes import register");
    expect(shim).toContain("def register_tool(self, **kwargs: Any) -> None:");
    expect(shim).toContain("self.state = _State(data_dir)");
    // `shoot` is excluded (browser), so only `echo` is registered and only `echo` is callable.
    expect(shim).toContain('assert [r["name"] for r in ctx.registrations] == ["echo"]');
    expect(shim).toContain('r["name"] == "echo"');
    expect(shim).toContain('handler({"text":"hi"})');
    // The marker comes from `echo`'s own output schema, not a hardcoded assumption.
    expect(shim).toContain('assert "text" in result');
    expect(shim).toContain("checkout and Node, which the shim handler spawns");

    const native = emitted(python)[`${HOST_DIR}/tests/test_plugin.py`] ?? "";
    expect(native).toContain("from hello_hermes import register");
    expect(native).not.toContain("and Node");
  });
});

function hasHermes(): boolean {
  try {
    execFileSync("hermes", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** The only claim that matters: Hermes' own runtime discovers, imports and registers this. */
describe.skipIf(!hasHermes())("hermes plugins doctor", () => {
  it("loads and registers the generated plugin", () => {
    const root = mkdtempSync(join(tmpdir(), "toolfactory-hermes-"));
    try {
      for (const file of surface.plan(project())) {
        if (file.kind !== "file") continue;
        mkdirSync(dirname(join(root, file.path)), { recursive: true });
        writeFileSync(join(root, file.path), file.content);
      }
      const commands = surface.validate?.({ ...project(), root }) ?? [];
      const command = commands.find((c) => c.label === "hermes plugins doctor");
      if (!command) throw new Error("the hermes surface no longer declares a doctor validator");
      const output = execFileSync(command.command, command.args, { cwd: root, encoding: "utf8" });
      expect(output).toContain("registrations: 1 tool(s)");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
