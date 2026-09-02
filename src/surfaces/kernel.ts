/**
 * The kernel surfaces: `mcp` (the MCP server over stdio) and `cli` (one subcommand per
 * operation plus `mcp`). Both are the binding's generated files; the binding owns the
 * templates, these surfaces own the verdicts and the smoke commands.
 */
import { getBinding } from "../bindings/index.js";
import type { Project, Surface } from "../model.js";
import { TOOLFACTORY_DIR } from "../project/lock.js";
import { cliVerdict, json, mcpVerdict } from "./shared.js";

/** MCP Inspector session config pointing at the dev kernel (no build step). */
export const INSPECTOR_CONFIG_PATH = `${TOOLFACTORY_DIR}/inspector.json`;

function inspectorConfig(project: Project): string {
  const launch = getBinding(project.tool.binding).kernelCommand(project);
  return json({ mcpServers: { [project.identity.name]: launch } });
}

export const mcp: Surface = {
  id: "mcp",
  // The kernel itself is generated for every tool (plan.ts); this surface ships it.
  plan(project) {
    return [{ kind: "file", path: INSPECTOR_CONFIG_PATH, content: inspectorConfig(project) }];
  },
  validate(project) {
    return [
      {
        label: "mcp-inspector tools/list",
        command: "npx",
        args: [
          "--yes",
          "@modelcontextprotocol/inspector",
          "--cli",
          "--config",
          INSPECTOR_CONFIG_PATH,
          "--server",
          project.identity.name,
          "--method",
          "tools/list",
        ],
        cwd: project.root,
      },
    ];
  },
  verdict: mcpVerdict,
};

export const cli: Surface = {
  id: "cli",
  plan(project) {
    return getBinding(project.tool.binding).cli(project);
  },
  validate(project) {
    const launch = getBinding(project.tool.binding).cliCommand(project);
    return [
      { label: "cli --help", ...launch, args: [...launch.args, "--help"], cwd: project.root },
    ];
  },
  verdict: cliVerdict,
};
