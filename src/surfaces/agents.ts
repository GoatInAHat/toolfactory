/**
 * Surface "agents": the agent-config machinery every generated project carries, always on
 * (never in `tool.json.surfaces`; `project/plan.ts` adds it unconditionally).
 *
 * It projects two things. The first is `AGENTS.md`, read natively by OpenClaw, Hermes, Codex,
 * Cursor, Gemini and Claude Code, so an agent working inside any of them can develop the tool;
 * toolfactory owns the `<!-- tf:agents -->` region and the author owns the prose around it. The
 * second is the `.agents/` canon from github.com/GoatInAHat/template — `sync.py`, the per-harness
 * hook carriers, the agent-config workflow — whose bytes are vendored in `agents.template.ts` and
 * proved against the real repository by `hosts/template.ts`. Whole file where the template has no
 * per-project content, merge where another tool writes into the same document, region where the
 * author has legitimate lines of their own.
 */
import { execArgv } from "node:process";
import { getBinding } from "../bindings/index.js";
import { DRIFT_ENTRY } from "../hosts/template.js";
import { projectName } from "../identity/name.js";
import type { PlannedFile, Project, Surface } from "../model.js";
import { TEMPLATE_FILES } from "./agents.template.js";
import {
  HOST_DIR as DSH_HOST_DIR,
  PROFILE as DSH_PROFILE,
  rowId as dshRowId,
  toolName as dshToolName,
  LOCAL_PATCH_FILE,
  PATCH_FILE,
} from "./dsh.js";
import { pluginDir as hermesPluginDir } from "./hermes-native.js";
import { INSPECTOR_CONFIG_PATH } from "./kernel.js";
import { HOST_DIR as OPENCLAW_HOST_DIR } from "./openclaw-native.js";
import { has, liveCredentials, TOOLFACTORY_DIR } from "./shared.js";
import { WEB_DIR } from "./web.js";

export const AGENTS_PATH = "AGENTS.md";
export const AGENTS_BEGIN = "<!-- tf:agents -->";
export const AGENTS_END = "<!-- /tf:agents -->";
export const SETUP_PATH = ".agents/setup";
export const SETUP_BEGIN = "# tf:setup";
export const SETUP_END = "# /tf:setup";
export const IGNORE_PATH = ".gitignore";
export const IGNORE_BEGIN = "# tf:ignore";
export const IGNORE_END = "# /tf:ignore";
export const SERVERS_PATH = ".agents/mcp/servers.json";

/** Where the template's `.agents/setup` hands the project its own setup steps. */
const SETUP_SENTINEL = "# Project setup goes here";

/**
 * What it takes for a harness to see a newly registered MCP server, a new skill or an edited
 * `AGENTS.md`. One table: the generated Reload section renders it, and `init` prints the single
 * `line` of whichever harness it is running inside (`reloadLine`). Reload is the one part of
 * registration a repository cannot automate, so the honest replacement for "restart your agent"
 * is one accurate sentence per harness, generated from here.
 */
export interface Reload {
  harness: string;
  /** Environment variables whose presence means this process is inside that harness. */
  env: string[];
  /** What a new MCP server registration needs before the session can call it. */
  mcp: string;
  /** What a new or edited skill, or an edited `AGENTS.md`, needs. */
  instructions: string;
  /** The line `init` prints when it detects this harness; harnesses with no marker have none. */
  line?: string;
}

export const RELOAD: Reload[] = [
  {
    harness: "Claude Code",
    env: ["CLAUDECODE", "CLAUDE_CODE_REMOTE"],
    mcp: "Reconnect from `/mcp`, or start a new session: stdio servers are not reconnected automatically. A server's own `list_changed` refreshes its tool list without one.",
    instructions: "`.claude/skills/`, symlinked by `sync.py`; no documented mid-session reload.",
    line: "Claude Code will not pick up the new MCP servers in this session: stdio servers are not reconnected automatically — reconnect from `/mcp`, or start a new session. Skills are read through `.claude/skills`, which `sync.py` has just linked.",
  },
  {
    harness: "OpenClaw",
    env: ["OPENCLAW_CLI", "OPENCLAW_SHELL"],
    mcp: "`openclaw gateway restart`: plugins and MCP config load at Gateway start, and `openclaw mcp reload` only refreshes the current CLI process.",
    instructions:
      "Skills refresh mid-session; the watcher's list is picked up on the next agent turn. `AGENTS.md` is read at session start.",
    line: "Run `openclaw gateway restart` — OpenClaw loads plugins and MCP config at Gateway start, and `openclaw mcp reload` only refreshes the current CLI process. Skills refresh on your next turn (the skills watcher).",
  },
  {
    harness: "Hermes",
    env: ["HERMES_HOME", "TERMINAL_CWD"],
    mcp: "A new invocation: every run is a fresh process. `/reload-mcp` inside an open session; `hermes gateway restart` is the messaging gateway only.",
    instructions:
      "`hermes skills trust` once in this repo, then a new conversation: the resolved skill directories are stable for a conversation.",
    line: "Run `hermes skills trust` once in this repo, then start a new Hermes conversation — every invocation re-scans plugins, skills and AGENTS.md. `/reload-mcp` only affects an already-open session; `hermes gateway restart` is only for the messaging gateway.",
  },
  {
    harness: "Gemini CLI",
    env: [],
    mcp: "`/mcp reload`",
    instructions: "`/memory refresh`",
  },
  {
    harness: "Codex",
    env: [],
    mcp: "Restart: `sync.py install-codex` writes the user-level `~/.codex/config.toml`, read at startup, because a project config applies only once the project is trusted.",
    instructions: "Reads `AGENTS.md` and `.agents/skills/` natively.",
  },
  {
    harness: "Factory (`droid`)",
    env: [],
    mcp: "None: it reloads when `.factory/mcp.json` changes.",
    instructions: "Reads `AGENTS.md` natively.",
  },
  {
    harness: "VS Code",
    env: [],
    mcp: "The per-server Restart control, or `chat.mcp.autostart` (experimental).",
    instructions: "Reads `AGENTS.md` and `.agents/skills/` natively.",
  },
  {
    harness: "Cursor, Qwen, OpenCode, Kilo, Amp, CodeBuddy",
    env: [],
    mcp: "No primary-source reload documentation: assume a restart.",
    instructions: "Reads `AGENTS.md` and `.agents/skills/` natively.",
  },
];

export const RELOAD_FALLBACK =
  "Your harness reads `AGENTS.md` and `.agents/skills/` directly; for MCP config, restart it or use its own reload command — the Reload table in `AGENTS.md` names one per harness.";

/** The one reload line that matches the harness this process is running inside. */
export function reloadLine(environment: NodeJS.ProcessEnv): string {
  const match = RELOAD.find((entry) => entry.env.some((name) => environment[name]));
  return match?.line ?? RELOAD_FALLBACK;
}

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
    "- `.agents/` — the agent-config canon: `skills/`, `mcp/servers.json`, `setup`, `sync.py`.",
  ];
  if (has(project, "openclaw-native") || has(project, "hermes-native") || has(project, "dsh")) {
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

function agentConfigSection(project: Project): string[] {
  const own = kernelServerName(project);
  return [
    "## Agent config",
    "",
    "Skills and MCP servers live once in `.agents/` — `skills/` and `mcp/servers.json` — and sync",
    "to every harness automatically, in both directions; `CLAUDE.md`, `GEMINI.md` and the",
    "per-harness configs are rendered from there by `.agents/sync.py`. `bash .agents/setup` runs it",
    "and installs the git hooks, so pulls, branch switches and commits re-sync on their own, and a",
    "commit cannot leave a generated file stale (pre-commit also runs `npx toolfactory check`).",
    "Personal-only config: gitignored `.agents/local/`, same shape. Details: `.agents/README.md`.",
    "",
    ...(own
      ? [
          `This tool's own kernel is registered there as \`${own}\`, so an agent developing it can call`,
          "the operations it is writing; register nothing by hand.",
          "",
        ]
      : []),
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
      `  \`openclaw plugins uninstall ${project.identity.name} --keep-files\` removes the registration and leaves the checkout.`,
    );
  }
  if (hermes) {
    lines.push(
      "- **Hermes**: commit, then",
      `  \`hermes plugins install file://<absolute path to this repo>#${hermesPluginDir(project)}\``,
      "  (a `file://` URL installs, with a security warning at install time). Every `hermes` run is a",
      "  fresh process, so nothing needs restarting; `hermes gateway restart` is only for the",
      "  messaging gateway daemon.",
    );
  }
  if (has(project, "dsh")) {
    lines.push(
      `- **DSH** (experimental): \`dsh plugin --profile ${DSH_PROFILE} add ./${DSH_HOST_DIR}\` installs the`,
      "  bundle (`dsh plugin` forwards to pnpm, so pnpm must be on `PATH`); the operations reach the",
      `  model as \`${dshToolName(project, "<operation>")}\`, and \`dsh --profile ${DSH_PROFILE} --dump-config\` shows`,
      `  the composed \`id: ${dshRowId(project)}\` row. Bundle patches are read once per boot and never watched,`,
      `  so restart DSH after editing \`${DSH_HOST_DIR}/${PATCH_FILE}\` or reinstalling. Boot with`,
      `  \`--patch ${DSH_HOST_DIR}/${LOCAL_PATCH_FILE}\` and no bundle installed to drive this checkout`,
      "  instead. Every config variable is restated in the row's `env:` because DSH scrubs",
      "  KEY/PASSWORD/SECRET/TOKEN names before spawning an MCP server.",
    );
  }
  if (!openclaw && !hermes && !has(project, "dsh")) {
    lines.push(
      "_No host-native surface (`openclaw-native`, `hermes-native`, `dsh`) is selected; nothing installs",
      "into a running host._",
    );
  }
  lines.push(
    "",
    "Codex and Cursor read this file as is; Claude Code and Gemini read `CLAUDE.md` / `GEMINI.md`,",
    "each of which `.agents/sync.py` renders as the one line `@AGENTS.md`.",
    "",
  );
  return lines;
}

function reloadSection(): string[] {
  return [
    "## Reload",
    "",
    "Registration is automated; reload is not, and only some harnesses have one.",
    "",
    "| Harness | MCP config | Skills and `AGENTS.md` |",
    "|---|---|---|",
    ...RELOAD.map((entry) => `| ${entry.harness} | ${entry.mcp} | ${entry.instructions} |`),
    "",
  ];
}

function worktreesSection(): string[] {
  return [
    "## Worktrees",
    "",
    "Use the host's own worktree system; toolfactory creates none and writes nothing outside this",
    "repository.",
    "",
    "- **OpenClaw**: `openclaw worktrees create <repo> --name <name>` (state-dir owned, outside the repo).",
    "- **Hermes**: `hermes chat -w <name>` (repo-local `.worktrees/`, gitignored for you).",
    "- **Claude Code**: `claude --worktree <name>` (`.claude/worktrees/`).",
    "- **Cursor**: `agent -w <name>` (`~/.cursor/worktrees/`).",
    "",
    "Calling toolfactory over MCP from inside one: pass `root` explicitly. A stdio MCP server gets a",
    "static, config-time working directory, so it cannot tell which worktree you are in.",
    "",
  ];
}

/** The content of the generated region — everything between the markers, not the markers themselves. */
export function agentsContent(project: Project): string {
  const lines = [
    "",
    ...commandsSection(project),
    ...layoutSection(project),
    ...boundarySection(),
    ...agentConfigSection(project),
    ...installSection(project),
    ...reloadSection(),
    ...worktreesSection(),
  ];
  return `${lines.join("\n")}\n`;
}

/**
 * The one-time bootstrap notice is the author's, above the region: `.agents/setup` deletes it on
 * its first successful run, and a self-deleting block inside a toolfactory-owned region would be
 * permanent drift. It ships without the template's `keep=` slug, which is what makes the template
 * repository itself keep the notice forever.
 */
function agentsTemplate(project: Project): string {
  return [
    `# ${project.identity.name}`,
    "",
    "<!-- setup -->",
    "One-time bootstrap: if no environment hook ran it yet, run",
    "`bash .agents/setup`. Its first successful run makes everything in Agent",
    "config automatic and deletes this notice.",
    "<!-- /setup -->",
    "",
    `One paragraph: what an agent working in this repo should know before touching \`${project.tool.binding === "typescript" ? "src/ops.ts" : "the operation module"}\` — the tool's domain, and anything not obvious from the layout below.`,
    "",
    AGENTS_BEGIN,
    AGENTS_END,
    "",
  ].join("\n");
}

/** The name the tool's own kernel is registered under, when a surface makes it worth running. */
function kernelServerName(project: Project): string | undefined {
  return has(project, "mcp") || has(project, "openclaw-native") || has(project, "hermes-native")
    ? project.identity.name
    : undefined;
}

/**
 * `.agents/mcp/servers.json` is a merge file keyed by server name: `sync.py absorb()` writes
 * servers a teammate added through their own harness into this same document, so toolfactory owns
 * exactly the names it puts there and every entry whole (`owned`), never field by field.
 */
function servers(project: Project): PlannedFile {
  const own = kernelServerName(project);
  const patch: Record<string, unknown> = {};
  if (own) patch[own] = getBinding(project.tool.binding).kernelCommand(project);
  // The generator that maintains the repo — except in toolfactory's own, where the published
  // package would shadow the checkout entry above under the same name.
  if (project.identity.name !== "toolfactory") {
    patch.toolfactory = { command: "npx", args: ["toolfactory", "mcp"] };
  }
  if (has(project, "web")) {
    patch.shadcn = { command: "npx", args: ["shadcn@latest", "mcp"] };
    patch.playwright = { command: "npx", args: ["@playwright/mcp@latest"] };
  }
  return {
    kind: "merge",
    path: SERVERS_PATH,
    format: "json",
    patch,
    owned: Object.keys(patch),
  };
}

/** The vendored `.gitignore`, split on its `# ─── Title ───` headers. */
function ignoreBlocks(): Map<string, string> {
  const blocks = new Map<string, string>();
  let title = "";
  let lines: string[] = [];
  for (const line of TEMPLATE_FILES[IGNORE_PATH]?.split("\n") ?? []) {
    const header = line.match(/^# ─+ (.+?) ─+$/);
    if (header) {
      if (title) blocks.set(title, lines.join("\n"));
      title = header[1] as string;
      lines = [line];
    } else if (title && line !== "") {
      lines.push(line);
    }
  }
  if (title) blocks.set(title, lines.join("\n"));
  return blocks;
}

/** The build products toolfactory generates and locks but rebuilds rather than tracks (§2.2 S4). */
function outputPaths(project: Project): string[] {
  return [
    `${TOOLFACTORY_DIR}/coverage.json`,
    INSPECTOR_CONFIG_PATH,
    ...(has(project, "web") ? [`${WEB_DIR}/src/ops.json`] : []),
  ];
}

/**
 * The `.gitignore` region: the template's two agent blocks — `sync.py check` fails unless every
 * renderer output is ignored — plus toolfactory's own. Everything else the template ignores is
 * written once into the author's half of the file.
 */
function ignoreRegion(project: Project): string {
  const blocks = ignoreBlocks();
  const binding =
    project.tool.binding === "python" ? [".venv/", "__pycache__/"] : ["node_modules/"];
  return [
    "",
    blocks.get("Agent local state") ?? "",
    "",
    blocks.get("Generated agent adapters") ?? "",
    "# The `skills` CLI symlinks straight into Factory's own skills directory, which",
    "# `sync.py` does not manage.",
    "/.factory/skills/",
    "",
    "# ─── toolfactory ──────────────────────────────────────────",
    ...binding,
    "dist/",
    ".env",
    ".env.*",
    "!.env.example",
    ...(has(project, "openclaw-native")
      ? [
          "# npm writes this when the host plugin is validated; its only dependency on this repo is file:../..",
          "hosts/*/package-lock.json",
          "hosts/*/uv.lock",
        ]
      : []),
    "# Build products: generated and locked like every other file, rebuilt rather than tracked.",
    ...outputPaths(project),
    "",
  ].join("\n");
}

/** The author's half of a fresh `.gitignore`: the template's remaining blocks, minus duplicates. */
function ignoreTemplate(project: Project): string {
  const region = ignoreRegion(project);
  const owned = new Set(region.split("\n"));
  const rest = [...ignoreBlocks()]
    .filter(([title]) => title !== "Agent local state" && title !== "Generated agent adapters")
    .map(([, block]) => block.split("\n").filter((line, index) => index === 0 || !owned.has(line)))
    .filter((lines) => lines.length > 1)
    .map((lines) => lines.join("\n"));
  return `${[IGNORE_BEGIN + region + IGNORE_END, ...rest].join("\n\n")}\n`;
}

/**
 * `.agents/setup` is the template's machinery verbatim — isolation detection, the git hooks, the
 * bootstrap-notice deletion — plus the dependency install and drift gate toolfactory generates for
 * the binding. Both are toolfactory's; the author's codegen and migrations go after the marker,
 * where the template's own sentinel comment puts them.
 */
function setupTail(project: Project): string {
  const install =
    project.tool.binding === "python"
      ? [
          "if command -v uv >/dev/null 2>&1; then",
          "    uv sync",
          "else",
          '    echo "uv not found: https://docs.astral.sh/uv/getting-started/installation/, then rerun .agents/setup" >&2',
          "    exit 1",
          "fi",
        ]
      : (project.packageManager ?? "npm") === "pnpm"
        ? [
            "if ! command -v pnpm >/dev/null 2>&1; then",
            "    corepack enable >/dev/null 2>&1 || true",
            "fi",
            "if command -v pnpm >/dev/null 2>&1; then",
            "    pnpm install --prefer-offline",
            "else",
            '    echo "pnpm not found: install Node >= 22.12 (corepack provides pnpm), then rerun .agents/setup" >&2',
            "    exit 1",
            "fi",
          ]
        : ["npm install --no-audit --no-fund"];
  return [
    "",
    "# The pre-commit hook installed above converges agent config; toolfactory's drift gate goes in",
    "# front of its final `exec` so a commit cannot leave a generated file stale. That hook is",
    "# rewritten on every setup run, so the gate is re-inserted here every time, and before the",
    "# dependency install below, which is the step most likely to fail on a fresh machine.",
    "python3 - <<'PY'",
    "import pathlib, subprocess",
    "",
    'hooks = subprocess.run(["git", "rev-parse", "--git-path", "hooks"],',
    "                       capture_output=True, text=True).stdout.strip()",
    'hook = pathlib.Path(hooks) / "pre-commit"',
    "gate = 'npx toolfactory check >/dev/null || { echo \"toolfactory: generated files are stale; run npx toolfactory build\" >&2; exit 1; }'",
    "if hook.is_file():",
    '    lines = hook.read_text(encoding="utf-8").splitlines()',
    "    if gate not in lines:",
    '        at = next((i for i, line in enumerate(lines) if line.startswith("exec ")), len(lines))',
    "        lines.insert(at, gate)",
    '        hook.write_text("\\n".join(lines) + "\\n", encoding="utf-8")',
    "PY",
    "",
    "# Project setup: the dependencies this project's toolchain needs.",
    ...install,
    "",
  ].join("\n");
}

function setupFile(project: Project): PlannedFile {
  const vendored = TEMPLATE_FILES[SETUP_PATH] ?? "";
  const sentinel = vendored.indexOf(SETUP_SENTINEL);
  const head = `${vendored.slice(vendored.indexOf("\n") + 1, sentinel).trimEnd()}\n`;
  const shebang = vendored.slice(0, vendored.indexOf("\n"));
  const content = `\n${head}${setupTail(project)}`;
  return {
    kind: "region",
    path: SETUP_PATH,
    regions: [{ begin: SETUP_BEGIN, end: SETUP_END, content }],
    template: [
      shebang,
      `${SETUP_BEGIN}${content}${SETUP_END}`,
      "",
      "# Anything else this project needs at setup time (codegen, migrations) goes",
      "# here. Keep it idempotent and fast when there is nothing to do.",
      "",
    ].join("\n"),
  };
}

/** The one template file with a per-project key: the binding's devcontainer feature. */
function devcontainer(project: Project): string {
  const path = ".devcontainer/devcontainer.json";
  const document = JSON.parse(TEMPLATE_FILES[path] ?? "{}") as {
    features?: Record<string, unknown>;
  };
  const features =
    project.tool.binding === "typescript"
      ? { "ghcr.io/devcontainers/features/node:1": { version: "22" }, ...document.features }
      : document.features;
  return `${JSON.stringify({ ...document, features }, null, 2)}\n`;
}

/** Whole-file carriers: no per-project content, `adopt` is the escape hatch. */
function vendored(project: Project): PlannedFile[] {
  const skip = new Set([SETUP_PATH, IGNORE_PATH, ".devcontainer/devcontainer.json"]);
  return [
    ...Object.entries(TEMPLATE_FILES)
      .filter(([path]) => !skip.has(path))
      .map(
        ([path, content]): PlannedFile => ({
          kind: "file",
          path,
          content,
          ...(path.endsWith("sync.py") ? { mode: 0o755 } : {}),
        }),
      ),
    { kind: "file", path: ".devcontainer/devcontainer.json", content: devcontainer(project) },
  ];
}

export const surface: Surface = {
  id: "agents",
  plan(project) {
    return [
      {
        kind: "region",
        path: AGENTS_PATH,
        regions: [{ begin: AGENTS_BEGIN, end: AGENTS_END, content: agentsContent(project) }],
        template: agentsTemplate(project),
      },
      {
        kind: "region",
        path: IGNORE_PATH,
        regions: [{ begin: IGNORE_BEGIN, end: IGNORE_END, content: ignoreRegion(project) }],
        template: ignoreTemplate(project),
      },
      setupFile(project),
      servers(project),
      ...vendored(project),
    ];
  },
  validate() {
    // C2: the vendored template is proved against the repository that owns it, never trusted.
    return [
      { label: "agent-config template drift", command: "node", args: [...execArgv, DRIFT_ENTRY] },
    ];
  },
};
