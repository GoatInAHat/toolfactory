import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { FullFile, PlannedFile, Project, SurfaceId } from "../model.js";
import { ToolConfigSchema } from "../model.js";
import { cliCommand, cli as cliFiles, kernel, kernelCommand, scaffold } from "./typescript.js";

function project(surfaces: SurfaceId[], overrides: Partial<Project> = {}): Project {
  return {
    root: "/tmp/none",
    tool: ToolConfigSchema.parse({
      schemaVersion: 1,
      identity: "plugin.json",
      binding: "typescript",
      surfaces,
      config: { type: "object", properties: { apiKey: { type: "string" } } },
    }),
    identity: {
      name: "hello.ts",
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

describe("typescript binding", () => {
  it("names every artifact from the canonical name", () => {
    const both = project(["mcp", "cli"]);
    expect(kernelCommand().args).toEqual(["--import", "tsx", "src/toolfactory/mcp.ts"]);
    expect(cliCommand().args.at(-1)).toBe("src/toolfactory/cli.ts");
    expect(paths([...kernel(both), ...cliFiles(both)])).toEqual([
      "src/toolfactory/types.ts",
      "src/toolfactory/config.ts",
      "src/toolfactory/mcp.ts",
      "src/toolfactory/cli.ts",
    ]);
    // A file exists iff a selected surface owns it, and config keys become environment reads.
    // The kernel is the same for every surface set; only the cli surface adds cli.ts.
    expect(paths(kernel(project(["mcp"])))).not.toContain("src/toolfactory/cli.ts");
    expect(text(kernel(both), "src/toolfactory/config.ts")).toContain(
      '"apiKey": process.env["APIKEY"]',
    );
  });

  it("emits an opt-in --http flag, defaulting to stdio, on both the mcp module and the cli subcommand", () => {
    const files = [...kernel(project(["mcp", "cli"])), ...cliFiles(project(["mcp", "cli"]))];
    const mcp = text(files, "src/toolfactory/mcp.ts");
    expect(mcp).toContain(
      'import { createMcpHandler, McpServer } from "@modelcontextprotocol/server"',
    );
    expect(mcp).toContain("export async function serveHttp(");
    expect(mcp).toContain('port = 3000, host = "127.0.0.1", path = "/mcp"');
    expect(mcp).toContain("toNodeHandler(createMcpHandler(createServer))");
    // The CLI's mcp subcommand exists only when the mcp surface does (the file it imports).
    expect(text(cliFiles(project(["cli"])), "src/toolfactory/cli.ts")).not.toContain(
      'command("mcp")',
    );
    // Stdio is still the default: the standalone entrypoint only switches transport when --http is present.
    expect(mcp).toContain("const port = httpPortArg(process.argv.slice(2));");
    expect(mcp).toContain("port === undefined ? serve() : serveHttp({ port })");

    const cli = text(files, "src/toolfactory/cli.ts");
    expect(cli).toContain('"--http [port]"');
    expect(cli).toContain("serve, serveHttp");
    expect(cli).toContain("if (options.http === undefined) await serve();");
  });
});

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const repoNodeModules = join(repoRoot, "node_modules");

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

describe.skipIf(!existsSync(repoNodeModules))("typescript kernel, really run over http", () => {
  it("serves tools/list over MCP streamable HTTP when started with --http", {
    timeout: 60_000,
  }, async () => {
    const root = mkdtempSync(join(tmpdir(), "toolfactory-typescript-"));
    symlinkSync(repoNodeModules, join(root, "node_modules"), "dir");
    const real = project(["mcp", "cli"], { root, identity: { name: "probe", version: "0.1.0" } });
    for (const file of [...scaffold(real), ...kernel(real), ...cliFiles(real)]) {
      const filePath = join(root, file.path);
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, (file as FullFile).content);
    }

    const port = await freePort();
    const { command, args } = cliCommand();
    const child = spawn(command, [...args, "mcp", "--http", String(port)], {
      cwd: root,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stderr: string[] = [];
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(String(chunk)));

    try {
      const url = `http://127.0.0.1:${port}/mcp`;
      const init = await waitForInitialize(url, 20_000).catch((error) => {
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
