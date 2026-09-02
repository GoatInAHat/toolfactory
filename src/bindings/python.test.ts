import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { listTools } from "../introspect/index.js";
import type { FullFile, MergeFile, PlannedFile, Project, SurfaceId } from "../model.js";
import { ToolConfigSchema } from "../model.js";
import { surface as pypi } from "../surfaces/pypi.js";
import {
  cliCommand,
  cli as cliFiles,
  kernel,
  kernelCommand,
  liveTest,
  scaffold,
} from "./python.js";

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

/** A project whose config declares one required, sensitive credential: what gates the T4 tier. */
function withCredential(surfaces: SurfaceId[]): Project {
  const base = project(surfaces);
  base.tool.config = {
    type: "object",
    properties: { passkey: { type: "string", "x-toolfactory": { sensitive: true } } },
    required: ["passkey"],
  };
  base.tool.tests = { examples: { echo: { text: "hi" } } };
  base.operations = [{ name: "echo", inputSchema: { type: "object" }, requires: [] }];
  return base;
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
    expect(paths([...kernel(both), ...cliFiles(both)])).toEqual([
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

  it("reads the data directory from <N>_DATA_DIR, else the platform default", () => {
    const files = kernel(project(["mcp"]));
    expect(text(files, "src/hello_py/toolfactory/types.py")).toContain("data_dir: Path");
    const config = text(files, "src/hello_py/toolfactory/config.py");
    expect(config).toContain('os.environ.get("HELLO_PY_DATA_DIR")');
    expect(config).toContain('os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share"');
    expect(config).toContain('os.environ.get("LOCALAPPDATA")');
    expect(config).toContain('return base / "hello.py"');
    expect(config).toContain("data_dir=data_dir()");
  });

  it("emits the T4 live test only for a required sensitive credential", () => {
    expect(liveTest(project(["cli"]))).toEqual([]);

    const live = liveTest(withCredential(["cli"]))[0];
    if (live?.kind !== "region") throw new Error("expected a region file");
    expect(live.path).toBe("tests/test_live.py");
    expect(live.regions[0]?.content).toContain('CREDENTIALS = ("PASSKEY",)');
    expect(live.regions[0]?.content).toContain("LIVE = all(os.environ.get(name)");
    expect(live.template).toContain("@pytest.mark.skipif(not LIVE");
    // pydantic's own JSON entry point, so tool.json's example arguments need no translation.
    expect(live.template).toContain('operation.input.model_validate_json("{\\"text\\":\\"hi\\"}")');
    // The header documents the local command; CI runs the same one without --env-file.
    expect(live.template).toContain(
      "uv run --env-file .env --with pytest pytest -q tests/test_live.py",
    );
  });

  it("emits an opt-in --http flag, defaulting to stdio, on both the mcp module and the cli subcommand", () => {
    const files = [...kernel(project(["mcp", "cli"])), ...cliFiles(project(["mcp", "cli"]))];
    const mcp = text(files, "src/hello_py/toolfactory/mcp.py");
    expect(mcp).toContain(
      'def serve_http(host: str = "127.0.0.1", port: int = 3000, path: str = "/mcp")',
    );
    expect(mcp).toContain('server.run("streamable-http"');
    expect(mcp).toContain("stateless_http=True");
    // Stdio is still the default: the standalone entrypoint only switches transport when --http is present.
    expect(mcp).toContain("serve_http(port=args.http) if args.http is not None else serve()");

    const cli = text(files, "src/hello_py/toolfactory/cli.py");
    expect(cli).toContain('"--http"');
    expect(cli).toContain("from .mcp import serve_http");
    expect(cli).toContain("if options.http is not None:");
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
    for (const file of [...scaffold(real), ...kernel(real), ...cliFiles(real)]) {
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

  it("serves tools/list over MCP streamable HTTP when started with --http", {
    timeout: 300_000,
  }, async () => {
    const root = mkdtempSync(join(tmpdir(), "toolfactory-python-http-"));
    const real = project(["mcp", "cli"], { root, identity: { name: "probe", version: "0.1.0" } });
    for (const file of [...scaffold(real), ...kernel(real), ...cliFiles(real)]) {
      const path = join(root, file.path);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, (file as FullFile).content);
    }
    const sync = spawnSync("uv", ["sync", "--quiet"], { cwd: root, encoding: "utf8" });
    expect(sync.status, sync.stderr).toBe(0);

    const port = await freePort();
    const cli = cliCommand(real);
    const child = spawn(cli.command, [...cli.args, "mcp", "--http", String(port)], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stderr: string[] = [];
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(String(chunk)));

    try {
      const url = `http://127.0.0.1:${port}/mcp`;
      const init = await waitForInitialize(url, 30_000).catch((error) => {
        throw new Error(`${error instanceof Error ? error.message : error}\n${stderr.join("")}`);
      });
      expect(init.status).toBe(200);
      const negotiated = (init.json as { result: { protocolVersion: string } }).result
        .protocolVersion;

      const list = await postRpc(url, { jsonrpc: "2.0", id: 2, method: "tools/list" }, negotiated);
      expect(list.status).toBe(200);
      const tools = (list.json as { result: { tools: { name: string }[] } }).result.tools;
      expect(tools.map((tool) => tool.name)).toEqual(["echo"]);
    } finally {
      child.kill();
    }
  });
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

// The streamable HTTP transport requires `Accept: application/json, text/event-stream` on every
// POST, and `MCP-Protocol-Version` on every request *after* the one that negotiates it in `initialize`.
async function postRpc(
  url: string,
  body: unknown,
  protocolVersion?: string,
): Promise<{ status: number; json: unknown }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (protocolVersion) headers["MCP-Protocol-Version"] = protocolVersion;
  const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const raw = await response.text();
  const isEventStream =
    response.headers.get("content-type")?.includes("text/event-stream") ?? false;
  const payload = isEventStream
    ? JSON.parse(
        raw
          .split("\n")
          .find((line) => line.startsWith("data: "))
          ?.slice("data: ".length) ?? "{}",
      )
    : JSON.parse(raw || "{}");
  return { status: response.status, json: payload };
}

/** Retries `initialize` until the freshly-spawned server starts accepting connections. */
async function waitForInitialize(
  url: string,
  deadlineMs: number,
): Promise<{ status: number; json: unknown }> {
  const deadline = Date.now() + deadlineMs;
  for (;;) {
    try {
      return await postRpc(url, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2026-07-28",
          capabilities: {},
          clientInfo: { name: "toolfactory-test", version: "0.0.0" },
        },
      });
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}
