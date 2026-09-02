/**
 * Surface "agents": `AGENTS.md` at the tool's root, always generated (like `workflows`; never in
 * `tool.json.surfaces`, `project/plan.ts` adds this surface unconditionally) so an agent working
 * inside OpenClaw, Hermes, Codex, Cursor, Gemini or Claude Code — all of which read `AGENTS.md`
 * natively — can develop the generated tool itself. toolfactory owns the `<!-- tf:agents -->`
 * region; the body around it (what the tool is, what an agent should know before touching it) is
 * the author's.
 */
import { projectName } from "../identity/name.js";
import type { Project, Surface } from "../model.js";
import { pluginDir as hermesPluginDir } from "./hermes-native.js";
import { HOST_DIR as OPENCLAW_HOST_DIR } from "./openclaw-native.js";
import { has, liveCredentials } from "./shared.js";

export const AGENTS_PATH = "AGENTS.md";
export const AGENTS_BEGIN = "<!-- tf:agents -->";
export const AGENTS_END = "<!-- /tf:agents -->";

/** Registers the toolfactory MCP server itself: every host, every binding, always available. */
const TOOLFACTORY_MCP_SNIPPET = JSON.stringify({ command: "npx", args: ["toolfactory", "mcp"] });
const SHADCN_MCP_SNIPPET = JSON.stringify({ command: "npx", args: ["shadcn@latest", "mcp"] });

function commandsSection(project: Project): string[] {
  const typescript = project.tool.binding === "typescript";
  const pm = project.packageManager ?? "npm";
  const testCmd = typescript ? `${pm} test` : "uv run --with pytest pytest -q";
  const live = liveCredentials(project).length > 0 && project.operations.length > 0;
  const liveCmd = typescript
    ? pm === "pnpm"
      ? "pnpm test:live"
      : "npm run test:live"
    : "uv run --with pytest pytest -q tests/test_live.py";
  return [
    "## Commands",
    "",
    "- `npx toolfactory introspect` — resnapshot `dev.toolfactory/ops.json` after editing the operations.",
    "- `npx toolfactory build` — regenerate every generated file after a `dev.toolfactory/tool.json` change.",
    "- `npx toolfactory check` — the drift gate: fails when a generated file or the operation snapshot is stale.",
    "- `npx toolfactory validate` — runs every selected surface's upstream validator.",
    "- `npx toolfactory coverage` — operation × surface verdicts.",
    `- Tests: \`${testCmd}\`${live ? `; live tests against the real service (needs \`.env\`, copied from \`.env.example\`): \`${liveCmd}\`` : ""}.`,
    `- Package manager: ${typescript ? pm : "uv"}.`,
    "",
  ];
}

function layoutSection(project: Project): string[] {
  const typescript = project.tool.binding === "typescript";
  const opsPath = typescript
    ? "src/ops.ts"
    : `src/${projectName.pythonPackage(project.identity.name)}/ops.py`;
  const lines = [
    "## Layout",
    "",
    `- \`${opsPath}\` — your operations, the only hand-written source. Everything else here is a`,
    "  generated projection of it plus `dev.toolfactory/tool.json`.",
    "- `dev.toolfactory/` — the operation snapshot, coverage verdicts and the generation lock;",
    "  never hand-edit (`toolfactory adopt <path>` first if you must).",
  ];
  if (has(project, "openclaw-native") || has(project, "hermes-native")) {
    lines.push(
      "- `hosts/<id>/` — the host-native escape hatch for a selected host; nothing else creates it.",
    );
  }
  if (has(project, "web")) lines.push("- `web/` — the shadcn/ui app.");
  lines.push("");
  return lines;
}

function boundarySection(): string[] {
  return [
    "## The boundary",
    "",
    "Core logic is a pure function of (JSON arguments, environment/config, filesystem). Anything a",
    "host provides that is not one of those three is not available to core; a host-native shim",
    "converts it into one of them before the call.",
    "",
  ];
}

function installSection(project: Project): string[] {
  const lines = ["## Installing into the host you are developing in", ""];
  const openclaw = has(project, "openclaw-native");
  const hermes = has(project, "hermes-native");
  if (openclaw) {
    lines.push(
      `- **OpenClaw**: \`openclaw plugins install --link ${OPENCLAW_HOST_DIR} --force\` links the`,
      `  checkout in place; \`openclaw plugins inspect ${project.identity.name} --runtime --json\` confirms it loaded.`,
    );
  }
  if (hermes) {
    lines.push(
      "- **Hermes**: commit, then",
      `  \`hermes plugins install file://<absolute path to this repo>#${hermesPluginDir(project)}\`,`,
      "  then `hermes gateway restart`.",
    );
  }
  if (!openclaw && !hermes) {
    lines.push(
      "_No host-native surface (`openclaw-native`, `hermes-native`) is selected; nothing installs",
      "into a running host._",
    );
  }
  lines.push(
    "",
    "Codex and Cursor read this file as is; Claude Code and Gemini read `CLAUDE.md` / `GEMINI.md`,",
    "each of which can be the one line `@AGENTS.md`.",
    "",
  );
  return lines;
}

function skillsSection(project: Project): string[] {
  const lines = ["## First-party skills and MCP servers", ""];
  if (has(project, "web")) {
    lines.push(
      "- `npx skills add shadcn/ui@shadcn -y` — the `shadcn` skill, for the web surface.",
      `- shadcn MCP server: \`${SHADCN_MCP_SNIPPET}\``,
    );
  }
  if (has(project, "mcp") || has(project, "openclaw-native") || has(project, "hermes-native")) {
    lines.push(
      "- `npx skills add anthropics/skills@mcp-builder -y` — the `mcp-builder` skill, for the",
      "  kernel MCP server and the host-native plugins.",
    );
  }
  lines.push(`- toolfactory's own MCP server: \`${TOOLFACTORY_MCP_SNIPPET}\``, "");
  return lines;
}

/** The content of the generated region — everything between the markers, not the markers themselves. */
export function agentsContent(project: Project): string {
  const lines = [
    "",
    ...commandsSection(project),
    ...layoutSection(project),
    ...boundarySection(),
    ...installSection(project),
    ...skillsSection(project),
  ];
  return `${lines.join("\n")}\n`;
}

function template(project: Project): string {
  return [
    `# ${project.identity.name}`,
    "",
    `One paragraph: what an agent working in this repo should know before touching \`${project.tool.binding === "typescript" ? "src/ops.ts" : "the operation module"}\` — the tool's domain, and anything not obvious from the layout below.`,
    "",
    AGENTS_BEGIN,
    AGENTS_END,
    "",
  ].join("\n");
}

export const surface: Surface = {
  id: "agents",
  plan(project) {
    const regions = [{ begin: AGENTS_BEGIN, end: AGENTS_END, content: agentsContent(project) }];
    return [{ kind: "region", path: AGENTS_PATH, regions, template: template(project) }];
  },
};
