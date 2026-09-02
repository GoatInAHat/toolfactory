import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { listTools } from "../introspect/index.js";
import type { FullFile, MergeFile, PlannedFile, Project, SurfaceId } from "../model.js";
import { ToolConfigSchema } from "../model.js";
import { surface as pypi } from "../surfaces/pypi.js";
import { cliCommand, kernel, kernelCommand, scaffold } from "./python.js";

function project(surfaces: SurfaceId[], overrides: Partial<Project> = {}): Project {
  return {
    root: "/tmp/none",
    tool: ToolConfigSchema.parse({
      schemaVersion: 1,
      identity: "plugin.json",
      binding: "python",
      surfaces,
      config: { type: "object", properties: { apiKey: { type: "string" } } },
    }),
    identity: {
      name: "hello.py",
      version: "0.2.0",
      description: "Say hello.",
      license: "MIT",
      repository: "https://github.com/acme/hello",
      author: { name: "Ada", email: "ada@example.com" },
    },
    identityExtra: {},
    operations: [],
    toolfactoryVersion: "0.1.0",
    ...overrides,
  };
}

const paths = (files: PlannedFile[]) => files.map((file) => file.path);
const text = (files: PlannedFile[], path: string) =>
  (files.find((file) => file.path === path) as FullFile).content;

describe("python binding", () => {
  it("names every artifact from the canonical name", () => {
    const both = project(["mcp", "cli"]);
    expect(kernelCommand(both).args).toEqual([
      "run",
      "--quiet",
      "python",
      "-m",
      "hello_py.toolfactory.mcp",
    ]);
    expect(cliCommand(both).args.at(-1)).toBe("hello_py.toolfactory.cli");
    expect(paths(kernel(both))).toEqual([
      "src/hello_py/toolfactory/__init__.py",
      "src/hello_py/toolfactory/types.py",
      "src/hello_py/toolfactory/config.py",
      "src/hello_py/toolfactory/mcp.py",
      "src/hello_py/toolfactory/cli.py",
    ]);
    // A file exists iff a selected surface owns it, and config keys become environment reads.
    expect(paths(kernel(project(["mcp"])))).not.toContain("src/hello_py/toolfactory/cli.py");
    expect(text(kernel(both), "src/hello_py/toolfactory/config.py")).toContain(
      '"apiKey": os.environ.get("APIKEY")',
    );
    expect(text(scaffold(both), "pyproject.toml")).toContain(
      '"hello.py" = "hello_py.toolfactory.cli:main"',
    );
  });

  it("projects identity into pyproject.toml only when it is not the identity file", () => {
    const patch = (p: Project) =>
      (pypi.plan(p)[0] as MergeFile).patch.project as Record<string, unknown>;
    expect(patch(project(["pypi", "cli"]))).toMatchObject({
      name: "hello-py",
      version: "0.2.0",
      authors: [{ name: "Ada", email: "ada@example.com" }],
      urls: { Repository: "https://github.com/acme/hello" },
      scripts: { "hello.py": "hello_py.toolfactory.cli:main" },
    });
    const authored = project(["pypi", "cli"]);
    authored.tool.identity = "pyproject.toml";
    expect(patch(authored)).toEqual({ scripts: { "hello.py": "hello_py.toolfactory.cli:main" } });
  });

  it("carries the MCP Registry ownership marker in the README", () => {
    const files = pypi.plan(project(["pypi", "mcp-registry"]));
    expect((files[0] as MergeFile).patch).toMatchObject({ project: { readme: "README.md" } });
    const readme = files[1];
    if (readme.kind !== "region") throw new Error("expected a region file");
    expect(readme.regions[0]?.content).toContain("<!-- mcp-name: io.github.acme/hello.py -->");
  });
});

const uv = spawnSync("uv", ["--version"], { encoding: "utf8" }).status === 0;

describe.skipIf(!uv)("python kernel, really run", () => {
  it("serves tools/list and answers the CLI", { timeout: 300_000 }, async () => {
    const root = mkdtempSync(join(tmpdir(), "toolfactory-python-"));
    const real = project(["mcp", "cli"], { root, identity: { name: "probe", version: "0.1.0" } });
    for (const file of [...scaffold(real), ...kernel(real)]) {
      const path = join(root, file.path);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, (file as FullFile).content);
    }
    const sync = spawnSync("uv", ["sync", "--quiet"], { cwd: root, encoding: "utf8" });
    expect(sync.status, sync.stderr).toBe(0);

    const { command, args } = kernelCommand(real);
    const ops = await listTools(root, command, args);
    expect(ops.tools[0]).toMatchObject({
      name: "echo",
      inputSchema: { required: ["text"] },
      outputSchema: { required: ["text"] },
      _meta: { "dev.toolfactory": { requires: [] } },
    });

    const cli = cliCommand(real);
    const ran = spawnSync(cli.command, [...cli.args, "echo", "--text", "hi"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(JSON.parse(ran.stdout)).toEqual({ text: "hi" });
  });
});
