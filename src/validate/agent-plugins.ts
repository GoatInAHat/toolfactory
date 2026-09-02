/**
 * Agent Plugins has no CLI validator; the spec forbids fetching schemas at load time, so
 * the two official 1.0.0 schemas are vendored and checked here with Ajv (draft 2020-12).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Ajv2020 } from "ajv/dist/2020.js";

const SCHEMA_DIR = fileURLToPath(new URL("../../schemas/agent-plugins/", import.meta.url));

export interface SchemaProblem {
  file: string;
  message: string;
}

function loadSchema(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(SCHEMA_DIR, name), "utf8")) as Record<string, unknown>;
}

export function validateAgentPlugin(root: string): SchemaProblem[] {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  const problems: SchemaProblem[] = [];
  const targets: Array<[string, string]> = [
    ["plugin.json", "plugin.schema.json"],
    ["mcp.json", "mcp.schema.json"],
  ];
  for (const [file, schemaName] of targets) {
    const path = join(root, file);
    if (!existsSync(path)) {
      if (file === "plugin.json")
        problems.push({ file, message: "missing (required for an Agent Plugins bundle)" });
      continue;
    }
    let document: unknown;
    try {
      document = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      problems.push({ file, message: `not valid JSON: ${(error as Error).message}` });
      continue;
    }
    const validate = ajv.compile(loadSchema(schemaName));
    if (!validate(document)) {
      for (const error of validate.errors ?? []) {
        problems.push({
          file,
          message: `${error.instancePath || "/"} ${error.message ?? "invalid"}`,
        });
      }
    }
  }
  return problems;
}
