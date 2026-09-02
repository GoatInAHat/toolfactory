import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { z } from "zod";
import { readIdentityFile } from "../identity/read.js";
import {
  CAPABILITIES,
  type Capability,
  type Operation,
  type Project,
  ToolConfigSchema,
} from "../model.js";
import { TOOLFACTORY_DIR } from "./lock.js";

export const TOOL_PATH = `${TOOLFACTORY_DIR}/tool.json`;
export const OPS_PATH = `${TOOLFACTORY_DIR}/ops.json`;

const require = createRequire(import.meta.url);
export const TOOLFACTORY_VERSION: string = require("../../package.json").version;

/** `ops.json`: the `tools/list` result, verbatim, sorted by name. */
export const OpsSchema = z.object({
  tools: z.array(
    z
      .object({
        name: z.string(),
        title: z.string().optional(),
        description: z.string().optional(),
        inputSchema: z.record(z.string(), z.unknown()),
        outputSchema: z.record(z.string(), z.unknown()).optional(),
        annotations: z.record(z.string(), z.unknown()).optional(),
        _meta: z.record(z.string(), z.unknown()).optional(),
      })
      .passthrough(),
  ),
});
export type Ops = z.infer<typeof OpsSchema>;

export function toOperation(tool: Ops["tools"][number]): Operation {
  const meta = (tool._meta?.["dev.toolfactory"] ?? {}) as Record<string, unknown>;
  const declared = Array.isArray(meta.requires) ? meta.requires : [];
  const requires = declared.filter((c): c is Capability =>
    (CAPABILITIES as readonly string[]).includes(String(c)),
  );
  const unknown = declared.filter((c) => !(CAPABILITIES as readonly string[]).includes(String(c)));
  if (unknown.length) {
    throw new Error(
      `Operation ${tool.name} declares unknown capabilities ${JSON.stringify(unknown)}; allowed: ${CAPABILITIES.join(", ")}`,
    );
  }
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    annotations: tool.annotations,
    requires,
  };
}

export function readOps(root: string): Operation[] {
  const path = join(root, OPS_PATH);
  if (!existsSync(path)) return [];
  return OpsSchema.parse(JSON.parse(readFileSync(path, "utf8"))).tools.map(toOperation);
}

export function loadProject(rootInput = "."): Project {
  const root = resolve(rootInput);
  const toolPath = join(root, TOOL_PATH);
  if (!existsSync(toolPath)) {
    throw new Error(`${TOOL_PATH} not found in ${root}; run \`toolfactory init\` first.`);
  }
  const tool = ToolConfigSchema.parse(JSON.parse(readFileSync(toolPath, "utf8")));
  const identityFile = readIdentityFile(join(root, tool.identity));
  return {
    root,
    tool,
    identity: identityFile.identity,
    identityExtra: identityFile.extra,
    operations: readOps(root),
    toolfactoryVersion: TOOLFACTORY_VERSION,
  };
}
