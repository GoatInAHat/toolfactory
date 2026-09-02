/**
 * MCP Registry: `server.json` plus the package ownership marker. Publishing is the
 * `mcp-publisher` Go binary in CI; nothing runs here.
 */
import { githubOwner, projectName } from "../identity/name.js";
import type { Surface } from "../model.js";
import {
  compact,
  configProperties,
  envName,
  has,
  isSensitive,
  json,
  npmName,
  pypiName,
  requiredConfig,
} from "./shared.js";

export const SERVER_SCHEMA_ID =
  "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json";

export function registryName(project: { identity: { name: string; repository?: string } }): string {
  const owner = githubOwner(project.identity.repository);
  if (!owner) {
    throw new Error(
      'Surface "mcp-registry" needs a GitHub repository URL in the identity file to derive io.github.<owner>/<name>.',
    );
  }
  return projectName.mcpRegistry(project.identity.name, owner);
}

/** The registry schema caps description at 100 characters; cut at a word boundary. */
export function registryDescription(text: string): string {
  if (text.length <= 100) return text;
  const cut = text.slice(0, 100);
  return cut.slice(0, Math.max(cut.lastIndexOf(" "), 1)).replace(/[\s,;:]+$/, "");
}

export const surface: Surface = {
  id: "mcp-registry",
  plan(project) {
    const { identity } = project;
    const version = identity.version ?? "0.0.0";
    const environmentVariables = Object.entries(configProperties(project)).map(([key, property]) =>
      compact({
        name: envName(key),
        description: property.description,
        isRequired: requiredConfig(project).includes(key) || undefined,
        isSecret: isSensitive(property) || undefined,
      }),
    );
    const pkg =
      project.tool.binding === "python"
        ? {
            registryType: "pypi",
            identifier: pypiName(project),
            version,
            transport: { type: "stdio" },
          }
        : {
            registryType: "npm",
            identifier: npmName(project),
            version,
            transport: { type: "stdio" },
          };
    const server = compact({
      $schema: SERVER_SCHEMA_ID,
      name: registryName(project),
      description: registryDescription(identity.description ?? identity.name),
      version,
      repository: identity.repository ? { url: identity.repository, source: "github" } : undefined,
      websiteUrl: identity.homepage,
      packages:
        has(project, "npm") || has(project, "pypi")
          ? [
              compact({
                ...pkg,
                environmentVariables: environmentVariables.length
                  ? environmentVariables
                  : undefined,
              }),
            ]
          : undefined,
    });
    return [{ kind: "file", path: "server.json", content: json(server) }];
  },
};
