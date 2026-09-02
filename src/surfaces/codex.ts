/**
 * Codex plugin: `.codex-plugin/plugin.json` with the required `interface` block, plus
 * `.agents/plugins/marketplace.json` listing the repository's own plugin (`source: {source:
 * "local", path: "."}`) — the shape `codex plugin marketplace add <owner>/<repo>` (or a local
 * path) reads, confirmed against developers.openai.com/codex/plugins/build and proven end to end
 * in `validate()` below (`marketplace add` → `plugin add` → `plugin list --available`, real Codex
 * CLI, no mocks). The public ChatGPT/Codex plugin directory is a separate hosted-review portal
 * this surface does not reach.
 */

import { projectName } from "../identity/name.js";
import type { Surface } from "../model.js";
import { compact, has, json, kernelLaunch, mcpVerdict } from "./shared.js";

/** The Codex CLI (`@openai/codex`) `validate()` is proven against — pin for a deterministic gate. */
export const CODEX_PIN = "0.152.1";

export const surface: Surface = {
  id: "codex",
  plan(project) {
    const { identity } = project;
    const displayName = projectName.display(identity.name);
    const codexInterface = {
      displayName,
      shortDescription: (identity.description ?? identity.name).slice(0, 80),
      longDescription: identity.description ?? identity.name,
      developerName: identity.author?.name ?? "unknown",
      category: "Productivity",
      capabilities: [],
      ...(project.tool.codex?.interface ?? {}),
    };
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
        ? { [identity.name]: kernelLaunch(project, "${PLUGIN_ROOT}") }
        : undefined,
      interface: codexInterface,
    });
    // `source: "local"` + `path: "."` is the marketplace root itself: one repository, one
    // plugin. `policy.installation`/`policy.authentication`/`category` are required on every
    // entry per the build guide; `ON_INSTALL` mirrors the guide's own sample.
    const marketplace = compact({
      name: identity.name,
      interface: { displayName: codexInterface.displayName },
      plugins: [
        compact({
          name: identity.name,
          source: { source: "local", path: "." },
          policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
          category: codexInterface.category,
        }),
      ],
    });
    return [
      { kind: "file", path: ".codex-plugin/plugin.json", content: json(manifest) },
      { kind: "file", path: ".agents/plugins/marketplace.json", content: json(marketplace) },
    ];
  },
  validate(project) {
    // A fresh CODEX_HOME per run, matching the dsh surface's pattern: `marketplace add` reads
    // marketplace.json, `plugin add` installs the plugin entry it names (parsing plugin.json),
    // and `plugin list --available` confirms it resolves — the real install path end to end.
    const pluginId = `${project.identity.name}@${project.identity.name}`;
    // `plugin add` copies the plugin directory verbatim. A checkout carries node_modules (and the
    // OpenClaw host's link back to this repository), so the install runs from a staged copy that
    // has neither — the tree a `git clone` of the repository would give Codex.
    const script = [
      'CODEX_HOME="$(mktemp -d)"; STAGE="$(mktemp -d)"; export CODEX_HOME',
      'tar --exclude=./.git --exclude=node_modules --exclude=dist -cf - . | tar -xf - -C "$STAGE"',
      'cd "$STAGE"',
      `out="$({ npx -y @openai/codex@${CODEX_PIN} plugin marketplace add . --json && npx -y @openai/codex@${CODEX_PIN} plugin add ${pluginId} --json && npx -y @openai/codex@${CODEX_PIN} plugin list --available --json; } 2>&1)"`,
      "status=$?",
      'rm -rf "$CODEX_HOME" "$STAGE"',
      'printf "%s\\n" "$out"',
      "exit $status",
    ].join("\n");
    return [
      {
        label: "codex plugin marketplace add / plugin add / plugin list",
        command: "sh",
        args: ["-c", script],
        cwd: project.root,
      },
    ];
  },
  verdict: (operation) => {
    const verdict = mcpVerdict(operation);
    return verdict.kind === "native"
      ? { kind: "degraded", reason: "degraded:loader-unverified" }
      : verdict;
  },
};
