/**
 * Agent Plugins 1.0.0 bundle: `plugin.json` is the authored identity file (never written
 * here), `mcp.json` points at the kernel, `skills/` comes from the skill surface.
 * Validation is Ajv against the cached official schemas; the spec forbids fetching at load.
 */
import type { Project, Surface } from "../model.js";
import { json, kernelLaunch, mcpVerdict } from "./shared.js";

export const MCP_SCHEMA_ID = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
export const PLUGIN_SCHEMA_ID = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";

export function assertBundleIdentity(project: Project): void {
  if (project.tool.identity !== "plugin.json") {
    throw new Error(
      `Surface "agent-plugins" requires plugin.json as the identity file (tool.json.identity is "${project.tool.identity}").`,
    );
  }
}

export const surface: Surface = {
  id: "agent-plugins",
  plan(project) {
    assertBundleIdentity(project);
    const launch = kernelLaunch(project, "${PLUGIN_ROOT}");
    return [
      {
        kind: "file",
        path: "mcp.json",
        content: json({
          $schema: MCP_SCHEMA_ID,
          mcpServers: { [project.identity.name]: { type: "stdio", ...launch } },
        }),
      },
    ];
  },
  validate(project) {
    return [
      {
        label: "agent-plugins schema",
        command: "toolfactory",
        args: ["validate", "--surface", "agent-plugins"],
        cwd: project.root,
      },
    ];
  },
  verdict: mcpVerdict,
};
