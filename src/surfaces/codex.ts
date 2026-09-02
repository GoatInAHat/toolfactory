/**
 * Codex plugin: `.codex-plugin/plugin.json` with the required `interface` block. The
 * loader has not been exercised against a generated bundle, so coverage carries a
 * `loader-unverified` note until someone does.
 */
import type { Surface } from "../model.js";
import { compact, has, json, kernelLaunch, mcpVerdict } from "./shared.js";

export const surface: Surface = {
  id: "codex",
  plan(project) {
    const { identity } = project;
    const displayName = identity.name
      .split(/[-.]/)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" ");
    const manifest = compact({
      name: identity.name,
      version: identity.version ?? "0.1.0",
      description: identity.description ?? identity.name,
      author: compact({
        name: identity.author?.name ?? "unknown",
        email: identity.author?.email,
        url: identity.author?.url,
      }),
      homepage: identity.homepage,
      repository: identity.repository,
      license: identity.license,
      keywords: identity.keywords,
      skills: has(project, "skill") ? "./skills/" : undefined,
      mcpServers: has(project, "mcp")
        ? { [identity.name]: kernelLaunch(project, "${CLAUDE_PLUGIN_ROOT}") }
        : undefined,
      interface: {
        displayName,
        shortDescription: (identity.description ?? identity.name).slice(0, 80),
        longDescription: identity.description ?? identity.name,
        developerName: identity.author?.name ?? "unknown",
        category: "Productivity",
        capabilities: [],
        ...(project.tool.codex?.interface ?? {}),
      },
    });
    return [{ kind: "file", path: ".codex-plugin/plugin.json", content: json(manifest) }];
  },
  verdict: (operation) => {
    const verdict = mcpVerdict(operation);
    return verdict.kind === "native"
      ? { kind: "degraded", reason: "degraded:loader-unverified" }
      : verdict;
  },
};
