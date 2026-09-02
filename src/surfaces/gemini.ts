/**
 * Gemini CLI extension: one `gemini-extension.json` at the repository root, which is the entire
 * install channel. `gemini extensions install https://github.com/<owner>/<repo>` takes any public
 * repository carrying that file — no submission, no catalog PR — and geminicli.com/extensions
 * lists it from the same manifest.
 *
 * Three things it deliberately does not emit:
 *
 * - No `skills` or `commands` key. Gemini auto-discovers `skills/` and `commands/` from the
 *   extension root, and the extension root is the repository root, so the `skill` surface's
 *   directory already is the extension's skills.
 * - No `GEMINI.md`. `contextFileName` points at `AGENTS.md`, which the always-on `agents` surface
 *   writes and every other harness reads; `.agents/sync.py` renders `GEMINI.md` as the one line
 *   `@AGENTS.md` for interactive use, and the extension needs no second copy of it.
 * - No `env` on the MCP server row. Gemini does not pass the user's shell environment to an
 *   extension: only standard-safe variables and those declared in `settings[].envVar` are
 *   allowlisted through to its MCP servers, so the config schema projects onto `settings` and an
 *   `env` map would name variables that never arrive.
 */

import { projectName } from "../identity/name.js";
import type { Surface } from "../model.js";
import { AGENTS_PATH } from "./agents.js";
import {
  compact,
  configProperties,
  envName,
  isSensitive,
  json,
  kernelLaunch,
  mcpVerdict,
} from "./shared.js";

export const MANIFEST_PATH = "gemini-extension.json";

/**
 * The `@google/gemini-cli` release `validate()` runs. Pinned so the gate is reproducible;
 * Renovate bumps this constant (`renovate.json` `customManagers`).
 */
export const GEMINI_PIN = "0.58.0";

/** Gemini rejects any extension name outside `[A-Za-z0-9-]`; the projection lives in `projectName`. */
export const extensionName = projectName.gemini;

export const surface: Surface = {
  id: "gemini",
  plan(project) {
    const { identity } = project;
    const settings = Object.entries(configProperties(project)).map(([key, property]) =>
      compact({
        name: (property.title as string | undefined) ?? key,
        description: (property.description as string | undefined) ?? key,
        envVar: envName(key),
        sensitive: isSensitive(property) || undefined,
      }),
    );
    const manifest = compact({
      name: extensionName(identity.name),
      version: identity.version,
      description: identity.description,
      // `${extensionPath}` is the installed copy's own directory: an install is a copy, not a
      // checkout, so a bundled kernel is only reachable through it.
      mcpServers: { [identity.name]: kernelLaunch(project, "${extensionPath}") },
      contextFileName: AGENTS_PATH,
      settings: settings.length ? settings : undefined,
    });
    return [{ kind: "file", path: MANIFEST_PATH, content: json(manifest) }];
  },
  validate(project) {
    // Gemini's own manifest validator: it parses the manifest, enforces the name and version
    // rules, and fails when `contextFileName` names a file that is not there. Keyless — it never
    // reaches the model — so it is the gate rather than a schema of our own.
    return [
      {
        label: "gemini extensions validate",
        command: "npx",
        args: ["-y", `@google/gemini-cli@${GEMINI_PIN}`, "extensions", "validate", "."],
        cwd: project.root,
      },
    ];
  },
  // The extension carries MCP tool calls and nothing else: the rule is the `mcp` surface's own.
  verdict: mcpVerdict,
};
