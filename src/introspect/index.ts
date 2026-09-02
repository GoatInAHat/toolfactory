/**
 * Operations come from the code: spawn the kernel MCP server, list its tools, and
 * snapshot the result verbatim to ops.json so every generator runs offline.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { getBinding } from "../bindings/index.js";
import type { Project } from "../model.js";
import { OPS_PATH, type Ops, TOOLFACTORY_VERSION } from "../project/load.js";

export async function listTools(root: string, command: string, args: string[]): Promise<Ops> {
  const transport = new StdioClientTransport({ command, args, cwd: root, stderr: "pipe" });
  const stderr: string[] = [];
  transport.stderr?.on("data", (chunk: Buffer) => stderr.push(String(chunk)));
  const client = new Client({ name: "toolfactory", version: TOOLFACTORY_VERSION });
  try {
    await client.connect(transport).catch((error: unknown) => {
      const detail = stderr.join("").trim();
      throw new Error(
        `Could not start the kernel MCP server (${[command, ...args].join(" ")}): ${error instanceof Error ? error.message : String(error)}${detail ? `\n${detail}` : ""}`,
      );
    });
    const tools: Ops["tools"] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined);
      tools.push(...(page.tools as Ops["tools"]));
      cursor = page.nextCursor;
    } while (cursor);
    tools.sort((a, b) => a.name.localeCompare(b.name));
    return { tools };
  } finally {
    await client.close().catch(() => {});
  }
}

export function serializeOps(ops: Ops): string {
  return `${JSON.stringify(ops, null, 2)}\n`;
}

export async function introspect(
  project: Project,
): Promise<{ path: string; changed: boolean; ops: Ops }> {
  const kernel = project.tool.kernel ?? getBinding(project.tool.binding).kernelCommand(project);
  const ops = await listTools(project.root, kernel.command, kernel.args);
  const path = join(project.root, OPS_PATH);
  const next = serializeOps(ops);
  let changed = true;
  try {
    const { readFileSync } = await import("node:fs");
    changed = readFileSync(path, "utf8") !== next;
  } catch {
    changed = true;
  }
  if (changed) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, next);
  }
  return { path: OPS_PATH, changed, ops };
}
