/**
 * Claude Code plugin: an unconditional projection whenever selected, validated by
 * `claude plugin validate . --strict`. Reuses the root `skills/`; MCP goes through `.mcp.json`.
 */
import type { Surface } from "../model.js";
import {
  compact,
  configProperties,
  has,
  isSensitive,
  json,
  kernelLaunch,
  mcpVerdict,
  requiredConfig,
} from "./shared.js";

export const surface: Surface = {
  id: "claude",
  plan(project) {
    const { identity } = project;
    const userConfig = Object.fromEntries(
      Object.entries(configProperties(project)).map(([key, property]) => [
        key,
        compact({
          type:
            property.type === "number" || property.type === "integer"
              ? "number"
              : property.type === "boolean"
                ? "boolean"
                : "string",
          title: (property.title as string | undefined) ?? key,
          description: (property.description as string | undefined) ?? key,
          sensitive: isSensitive(property) || undefined,
          required: requiredConfig(project).includes(key) || undefined,
          default: property.default,
        }),
      ]),
    );
    const manifest = compact({
      $schema: "https://json.schemastore.org/claude-code-plugin-manifest.json",
      name: identity.name,
      version: identity.version,
      description: identity.description,
      author: identity.author,
      homepage: identity.homepage,
      repository: identity.repository,
      license: identity.license,
      keywords: identity.keywords,
      userConfig: Object.keys(userConfig).length ? userConfig : undefined,
    });
    const files: ReturnType<Surface["plan"]> = [
      { kind: "file", path: ".claude-plugin/plugin.json", content: json(manifest) },
    ];
    if (has(project, "mcp")) {
      const launch = kernelLaunch(project, "${CLAUDE_PLUGIN_ROOT}");
      const env = Object.fromEntries(
        Object.keys(configProperties(project)).map((key) => [
          key.toUpperCase(),
          `\${user_config.${key}}`,
        ]),
      );
      files.push({
        kind: "file",
        path: ".mcp.json",
        content: json({
          mcpServers: {
            [identity.name]: compact({ ...launch, env: Object.keys(env).length ? env : undefined }),
          },
        }),
      });
    }
    return files;
  },
  validate(project) {
    return [
      {
        label: "claude plugin validate",
        command: "claude",
        args: ["plugin", "validate", ".", "--strict"],
        cwd: project.root,
      },
    ];
  },
  verdict: mcpVerdict,
};
