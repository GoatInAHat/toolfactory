/**
 * Claude Code plugin: an unconditional projection whenever selected, validated by
 * `claude plugin validate .`. Reuses the root `skills/`; MCP servers are declared inline.
 */
import type { Surface } from "../model.js";
import {
  compact,
  configProperties,
  envName,
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
    const launch = kernelLaunch(project, "${CLAUDE_PLUGIN_ROOT}");
    const env = Object.fromEntries(
      Object.keys(configProperties(project)).map((key) => [envName(key), `\${user_config.${key}}`]),
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
      // Inline rather than .mcp.json: a root .mcp.json doubles as the repo's own project MCP
      // config in Claude Code, and repo templates commonly own that file.
      mcpServers: has(project, "mcp")
        ? {
            [identity.name]: compact({ ...launch, env: Object.keys(env).length ? env : undefined }),
          }
        : undefined,
    });
    const files: ReturnType<Surface["plan"]> = [
      { kind: "file", path: ".claude-plugin/plugin.json", content: json(manifest) },
    ];
    return files;
  },
  validate(project) {
    return [
      {
        label: "claude plugin validate",
        command: "claude",
        // Not --strict: a repo-root CLAUDE.md (the AGENTS.md pointer every repo carries) is a
        // strict-mode warning, and warnings never describe the generated manifest.
        args: ["plugin", "validate", "."],
        cwd: project.root,
      },
    ];
  },
  verdict: mcpVerdict,
};
