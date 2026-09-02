/**
 * Cursor plugin: `.cursor-plugin/plugin.json`; config becomes `variables` (JSON Schema)
 * and the bundle's `mcp.json` is shared. Loader unverified, like Codex.
 */
import { projectName } from "../identity/name.js";
import type { Surface } from "../model.js";
import { compact, configProperties, has, json, mcpVerdict, requiredConfig } from "./shared.js";

export const surface: Surface = {
  id: "cursor",
  plan(project) {
    const { identity } = project;
    const properties = configProperties(project);
    const variables = Object.keys(properties).length
      ? {
          type: "object",
          properties: Object.fromEntries(
            Object.entries(properties).map(([key, property]) => [
              key.toUpperCase(),
              compact({
                type: property.type ?? "string",
                title: (property.title as string | undefined) ?? key,
                description: property.description,
                default: property.default,
              }),
            ]),
          ),
          required: requiredConfig(project).map((key) => key.toUpperCase()),
        }
      : undefined;
    const manifest = compact({
      name: projectName.cursor(identity.name),
      version: identity.version,
      description: identity.description,
      author: identity.author
        ? compact({ name: identity.author.name ?? "unknown", email: identity.author.email })
        : undefined,
      homepage: identity.homepage,
      repository: identity.repository,
      license: identity.license,
      keywords: identity.keywords,
      skills: has(project, "skill") ? "./skills/" : undefined,
      mcpServers: has(project, "agent-plugins") ? "./mcp.json" : undefined,
      variables,
    });
    return [{ kind: "file", path: ".cursor-plugin/plugin.json", content: json(manifest) }];
  },
  verdict: (operation) => {
    const verdict = mcpVerdict(operation);
    return verdict.kind === "native"
      ? { kind: "degraded", reason: "degraded:loader-unverified" }
      : verdict;
  },
};
