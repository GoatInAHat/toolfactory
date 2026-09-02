/**
 * The command layer. Every toolfactory verb is a function here so the CLI and the MCP
 * surface expose exactly the same operations.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { getBinding } from "./bindings/index.js";
import { LIVE_TEST_COMMAND } from "./bindings/python.js";
import {
  type BootstrapResult,
  type CreateRepoResult,
  createRepo,
  githubSlug,
  LIVE_ENVIRONMENT,
  bootstrapRepo as prepareRepository,
} from "./hosts/github.js";
import { assertValidName, projectName } from "./identity/name.js";
import { introspect as runIntrospect, snapshot } from "./introspect/index.js";
import type {
  Binding,
  Command,
  Identity,
  PlannedFile,
  Project,
  SurfaceId,
  ToolConfig,
} from "./model.js";
import { assertNoSensitiveArgument, SURFACE_IDS, ToolConfigSchema } from "./model.js";
import { apply, check as checkPlan, type Drift, setState } from "./project/apply.js";
import {
  type GateStep,
  gateSteps,
  manualSteps,
  PACKAGE_MANAGER_COMMANDS,
  packageSteps,
  type Registry,
  registries,
  toolfactoryCli,
  unpublishSteps,
} from "./project/gate.js";
import { droppedSurfaces, previousTag, toolAtRef } from "./project/history.js";
import {
  loadProject,
  OPS_PATH,
  TOOL_PATH,
  TOOLFACTORY_VERSION,
  toOperation,
} from "./project/load.js";
import { readLock } from "./project/lock.js";
import { buildPlan, TOOL_SCHEMA_PATH } from "./project/plan.js";
import { type Coverage, computeCoverage } from "./report/coverage.js";
import { PLUGIN_SCHEMA_ID } from "./surfaces/agent-plugins.js";
import { reloadLine, SETUP_PATH } from "./surfaces/agents.js";
import { HOST_DIR as BROWSER_HOST_DIR } from "./surfaces/browser-extension.js";
import { assertSurfaceRequirements, getSurface, selectedSurfaces } from "./surfaces/registry.js";
import {
  compact,
  configProperties,
  envName,
  has,
  isSensitive,
  json,
  liveCredentials,
  requiredConfig,
} from "./surfaces/shared.js";
import { validateAgentPlugin } from "./validate/agent-plugins.js";

export interface InitOptions {
  root: string;
  name: string;
  description?: string;
  binding: Binding;
  surfaces: SurfaceId[];
  license?: string;
  repository?: string;
  author?: string;
  /**
   * Activation triggers for hosts that key off them (Kiro Powers, Agent Plugins); defaults to
   * `[name]`.
   */
  keywords?: string[];
  /** `git init` when the directory is not a repository yet. `.agents/setup` needs one. */
  git?: boolean;
  /** Run `.agents/setup`: harness adapters, the git hooks, the dependency install. */
  setup?: boolean;
  /** `owner/name` of a GitHub repository to create with `gh` and push to. */
  repo?: string;
  /** Create that repository public; the default is private. */
  public?: boolean;
  /** Print the `gh` invocations instead of running them. */
  dryRun?: boolean;
  /** GitHub logins that must approve a live run, when the repository gets a live tier. */
  reviewers?: string[];
}

export interface InitResult {
  written: string[];
  /** What `.agents/setup` did here: whether it succeeded, and the harnesses it rendered for. */
  agentConfig: { setup: boolean; harnesses: string[] };
  repository?: CreateRepoResult & { secrets: string[] };
  /** What the caller — a human or the agent that ran `init` — has to do next, in order. */
  nextSteps: string[];
}

const BUNDLE_SURFACES: SurfaceId[] = ["agent-plugins", "skill", "claude", "codex", "cursor"];

function writeIfAbsent(root: string, files: PlannedFile[]): string[] {
  const written: string[] = [];
  for (const file of files) {
    if (file.kind !== "file") continue;
    const path = join(root, file.path);
    if (existsSync(path)) continue;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.content);
    written.push(file.path);
  }
  return written;
}

function git(root: string, args: string[]): boolean {
  return spawnSync("git", args, { cwd: root, stdio: "ignore", timeout: 60_000 }).status === 0;
}

/**
 * `git commit` refuses to run without an identity, and a CI runner or a fresh machine has none;
 * this commit is toolfactory's own, so it falls back to naming itself rather than failing.
 */
function commitIdentity(root: string): string[] {
  return git(root, ["config", "--get", "user.email"])
    ? []
    : ["-c", "user.name=toolfactory", "-c", "user.email=toolfactory@localhost"];
}

/**
 * `.agents/setup`: the template's one entry point — it renders the harness adapters from
 * `.agents/`, installs the git hooks that keep them in sync (and the drift gate in front of the
 * pre-commit hook), and installs the project's dependencies. Best-effort: a machine missing
 * python3, pnpm or the network still gets a scaffolded project, and `nextSteps` says to run it.
 */
function agentSetup(root: string): InitResult["agentConfig"] {
  const result = spawnSync("bash", [SETUP_PATH], {
    cwd: root,
    encoding: "utf8",
    timeout: 300_000,
  });
  const harnesses = (result.stdout ?? "")
    .split("\n")
    .flatMap((line) => line.match(/^Generated ([^:]+):/)?.slice(1, 2) ?? []);
  return { setup: result.status === 0, harnesses };
}

function nextSteps(project: Project, agentConfig: InitResult["agentConfig"]): string[] {
  const cli = toolfactoryCli(project);
  const ops =
    project.tool.binding === "typescript"
      ? "src/ops.ts"
      : `src/${projectName.pythonPackage(project.identity.name)}/ops.py`;
  // The credential inventory, once, where the agent that ran `init` will read it: a project that
  // declares none says nothing at all.
  const summary = secretsSummary(secretsReport(project));
  return [
    agentConfig.setup
      ? `Agent config is wired: \`.agents/\` is the canon (\`skills/\`, \`mcp/servers.json\`). \`${SETUP_PATH}\` rendered ${agentConfig.harnesses.length} harness adapter(s) here (${agentConfig.harnesses.join(", ") || "none detected"}) and installed the pre-commit/post-checkout/post-merge hooks, so pulls, branch switches and commits re-sync on their own. Details: \`.agents/README.md\`.`
      : `Agent config is written but \`${SETUP_PATH}\` did not finish here: run \`bash ${SETUP_PATH}\` to render the harness adapters from \`.agents/\`, install the git hooks that keep them in sync, and install the dependencies. Details: \`.agents/README.md\`.`,
    reloadLine(process.env),
    `Next: write your operations in \`${ops}\`, then \`${cli} introspect && ${cli} build\`.`,
    ...(summary ? [summary] : []),
  ];
}

/**
 * Create dev.toolfactory/tool.json, the identity file and the binding's scaffold, build every
 * selected surface, and leave a project that is already live in the harness it was run from:
 * a git repository, the first-party skills, the rendered agent config, and — only when asked —
 * a GitHub repository holding it.
 */
export function init(options: InitOptions): InitResult {
  const root = resolve(options.root);
  assertValidName(options.name);
  mkdirSync(root, { recursive: true });
  // First, because `.agents/setup` starts with `git rev-parse --show-toplevel` and fails outside
  // a repository, and because `gh repo create --source` pushes one.
  if (options.git !== false && !existsSync(join(root, ".git")))
    git(root, ["init", "-q", "-b", "main"]);
  const surfaces = [...new Set(options.surfaces)];
  assertSurfaceRequirements(surfaces);
  const usesBundle = surfaces.some((s) => BUNDLE_SURFACES.includes(s));
  const identityPath = usesBundle
    ? "plugin.json"
    : options.binding === "python"
      ? "pyproject.toml"
      : "package.json";
  const identity: Identity = compact({
    name: options.name,
    version: "0.1.0",
    description: options.description,
    license: options.license,
    repository: options.repository,
    author: options.author ? { name: options.author } : undefined,
    keywords: options.keywords?.length ? options.keywords : [options.name],
  }) as Identity;
  const written: string[] = [];
  if (usesBundle && !existsSync(join(root, "plugin.json"))) {
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "plugin.json"), json({ $schema: PLUGIN_SCHEMA_ID, ...identity }));
    written.push("plugin.json");
  }
  const tool = ToolConfigSchema.parse({
    $schema: `./${TOOL_SCHEMA_PATH.split("/").pop()}`,
    schemaVersion: 1,
    identity: identityPath,
    binding: options.binding,
    surfaces,
  });
  const toolPath = join(root, TOOL_PATH);
  if (!existsSync(toolPath)) {
    mkdirSync(dirname(toolPath), { recursive: true });
    writeFileSync(toolPath, json(tool));
    written.push(TOOL_PATH);
  }
  const scaffoldProject: Project = {
    root,
    tool,
    identity,
    identityExtra: {},
    operations: [],
    toolfactoryVersion: TOOLFACTORY_VERSION,
  };
  written.push(...writeIfAbsent(root, getBinding(options.binding).scaffold(scaffoldProject)));
  // A region file that predates toolfactory has no markers, and `apply` refuses to guess where
  // they go; appending the empty pair lets `init` run in a folder that already has these files.
  for (const file of ["agents", "readme"].flatMap((id) =>
    getSurface(id as SurfaceId).plan(scaffoldProject),
  )) {
    if (file.kind !== "region") continue;
    const path = join(root, file.path);
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf8");
    const missing = file.regions.filter((region) => !text.includes(region.begin));
    if (missing.length)
      writeFileSync(
        path,
        `${text}\n${missing.map((region) => `${region.begin}\n${region.end}`).join("\n")}\n`,
      );
  }
  // The kernel files exist from the first moment so `introspect` can spawn the server.
  const built = build(root);
  written.push(...built.result.written);
  // Best-effort: the first-party skills for the selected surfaces, so an agent developing the
  // tool from inside a harness that reads them has them from the first `init`.
  const skills = [
    surfaces.includes("web") ? "shadcn/ui@shadcn" : undefined,
    surfaces.some((s) => s === "mcp" || s === "openclaw-native" || s === "hermes-native")
      ? "anthropics/skills@mcp-builder"
      : undefined,
  ].filter((spec): spec is string => spec !== undefined);
  for (const spec of skills) {
    spawnSync("npx", ["--yes", "skills", "add", spec, "-y"], {
      cwd: root,
      stdio: "ignore",
      timeout: 120_000,
    });
  }
  const agentConfig = options.setup === false ? { setup: false, harnesses: [] } : agentSetup(root);
  // A repository with no commit has nothing to push and no baseline to diff against; one that
  // already has history is the author's, and init adds nothing to it. `--no-verify`: the
  // pre-commit hook `.agents/setup` just installed converges agent config and re-runs the drift
  // gate, which this build satisfied by construction, and requiring it here would make the first
  // commit depend on a toolchain the project has not installed yet.
  if (options.git !== false && !git(root, ["rev-parse", "--verify", "-q", "HEAD"])) {
    if (git(root, ["add", "-A"])) {
      git(root, [...commitIdentity(root), "commit", "-q", "--no-verify", "-m", "toolfactory init"]);
    }
  }
  const result: InitResult = {
    written,
    agentConfig,
    nextSteps: nextSteps(built.project, agentConfig),
  };
  if (options.repo) {
    const project = loadProject(root);
    const created = createRepo(project, {
      slug: options.repo,
      public: options.public,
      dryRun: options.dryRun,
    });
    // Everything GitHub-only in one call: it creates the live environment only when the project
    // has a live tier, and otherwise still sets the release secrets .env already holds.
    const prepared = prepareRepository(project, {
      repository: options.repo,
      reviewers: options.reviewers,
      dryRun: options.dryRun,
      releaseSecrets: registries(project).flatMap((row) => row.secrets),
      manual: manualSteps(project),
    });
    result.repository = {
      ...created,
      commands: [...created.commands, ...prepared.commands],
      secrets: prepared.secrets,
    };
  }
  return result;
}

export function build(root = ".") {
  const project = loadProject(root);
  return {
    project,
    result: {
      ...apply(project.root, buildPlan(project), TOOLFACTORY_VERSION),
      nudge: unpublishNudge(project),
    },
  };
}

/** Throws when any generated file drifted, so CLI and MCP callers see a failure. */
/** The drift gate: the operation snapshot and every generated file must match the code. */
export async function check(root = "."): Promise<{ project: Project; drift: Drift[] }> {
  const project = loadProject(root);
  assertNoSensitiveArgument(project.tool.config, project.operations);
  const drift = checkPlan(project.root, buildPlan(project), TOOLFACTORY_VERSION);
  const ops = await snapshot(project);
  if (ops.changed) drift.unshift({ kind: "changed", path: OPS_PATH });
  if (drift.length) {
    throw new Error(
      `${drift.length} generated file(s) out of date; run \`toolfactory ${ops.changed ? "introspect" : "build"}\`:\n${drift.map((d) => `  ${d.kind}: ${d.path}`).join("\n")}`,
    );
  }
  return { project, drift };
}

/** Regenerate the kernel first so the snapshot always reflects the current templates. */
export async function introspect(root = ".") {
  const { project } = build(root);
  const snapshot = await runIntrospect(project);
  // Against the operations the kernel just reported, not the ones on disk: this is the moment an
  // author who routed a secret through an argument finds out, before it reaches any surface.
  assertNoSensitiveArgument(project.tool.config, snapshot.ops.tools.map(toOperation));
  if (snapshot.changed) build(root);
  return snapshot;
}

export function coverage(root = "."): Coverage {
  const project = loadProject(root);
  return computeCoverage(project, selectedSurfaces(project.tool.surfaces));
}

export interface ValidationOutcome {
  label: string;
  command: string;
  ok: boolean;
  output: string;
}

/** Run every selected surface's upstream validator (tier 1 and the kernel smoke); throws if any fails. */
export function validate(root = ".", only?: SurfaceId): ValidationOutcome[] {
  const project = loadProject(root);
  const surfaces = selectedSurfaces(project.tool.surfaces).filter((s) => !only || s.id === only);
  const outcomes: ValidationOutcome[] = [];
  for (const surface of surfaces) {
    if (surface.id === "agent-plugins") {
      const problems = validateAgentPlugin(project.root);
      outcomes.push({
        label: "agent-plugins schema",
        command: "ajv (vendored Agent Plugins 1.0.0 schemas)",
        ok: problems.length === 0,
        output: problems.map((p) => `${p.file}: ${p.message}`).join("\n"),
      });
      continue;
    }
    for (const command of surface.validate?.(project) ?? []) {
      outcomes.push(run(command));
    }
  }
  const failed = outcomes.filter((outcome) => !outcome.ok);
  if (failed.length) {
    throw new Error(
      `${failed.length} validator(s) failed:\n${failed
        .map(
          (f) =>
            `  ${f.label}: ${f.command}\n${f.output
              .split("\n")
              .map((l) => `    ${l}`)
              .join("\n")}`,
        )
        .join("\n")}`,
    );
  }
  return outcomes;
}

export function run(command: Command): ValidationOutcome {
  const result = spawnSync(command.command, command.args, {
    cwd: command.cwd,
    env: { ...process.env, ...command.env },
    encoding: "utf8",
    timeout: 300_000,
  });
  const output = [result.stdout, result.stderr, result.error?.message]
    .filter(Boolean)
    .join("\n")
    .trim();
  return {
    label: command.label,
    command: [command.command, ...command.args].join(" "),
    ok: result.status === 0,
    output,
  };
}

export interface StepResult {
  name: string;
  ok: boolean;
  durationMs: number;
}

/**
 * Run a step list from `project/gate.ts` in order, stopping at the first failure. `when: "ci"`
 * steps are runner provisioning — a global install no checkout may perform on the author's
 * machine — and are skipped here exactly as `renderShell` skips them. Every step's output goes to
 * this process's stderr, never its stdout, so running the gate over the MCP surface cannot
 * corrupt the protocol stream.
 */
export function runSteps(root: string, steps: GateStep[]): { steps: StepResult[] } {
  const cwd = resolve(root);
  const results: StepResult[] = [];
  for (const step of steps) {
    if (step.when === "ci") continue;
    const started = Date.now();
    const { status } = spawnSync(step.run, {
      cwd,
      shell: true,
      stdio: ["ignore", 2, 2],
      env: { ...process.env, ...step.env },
      timeout: 1_800_000,
    });
    results.push({ name: step.name, ok: status === 0, durationMs: Date.now() - started });
    if (status !== 0) break;
  }
  return { steps: results };
}

function green(label: string, result: { steps: StepResult[] }): { steps: StepResult[] } {
  const failed = result.steps.find((step) => !step.ok);
  if (failed) {
    throw new Error(
      `${label} failed at step "${failed.name}" after ${failed.durationMs} ms; its output is above.`,
    );
  }
  return result;
}

/**
 * The gate: what "green" means for this project, run here instead of on a runner. `ci.yml`
 * renders the same list, so a project with no CI at all — no GitHub, plain git or none — has the
 * identical gate one command away.
 */
export function gate(root = "."): { steps: StepResult[] } {
  return green("gate", runSteps(root, gateSteps(loadProject(root))));
}

/** Every release asset into `dist/release/`, by the same steps the release workflow's job runs. */
export function packageRelease(root = "."): { steps: StepResult[] } {
  return green("package", runSteps(root, packageSteps(loadProject(root))));
}

// ---------------------------------------------------------------------------------------------
// secrets — the credential inventory (§6). Never a value: no `set`, no `value` property, on any
// surface. A secret reaches the kernel through the environment a host injects, and it gets there
// through that host's own masked field, `.env`, or `bootstrap-repo`.
// ---------------------------------------------------------------------------------------------

export interface SecretRow {
  /** The environment variable name, on every surface and in every environment. */
  name: string;
  kind: "config" | "release";
  required: boolean;
  /** Selected surfaces (a config key) or registry ids (a release token) that consume it. */
  needs: string[];
  /** Present in `<root>/.env` or this process's environment. Presence only, never the value. */
  local: boolean;
  /** Named by `gh secret list`; absent when `gh` is not on PATH or no repository is declared. */
  github?: boolean;
  url?: string;
  /** The exact next action, per selected host and per registry. */
  howTo: string[];
  /** `check`: what the registry's own CLI said about the credential in the environment. */
  check?: { ok: boolean; command: string };
}

export interface SecretsReport {
  secrets: SecretRow[];
  /** The one-time human steps with no API; the same list `bootstrap-repo` prints. */
  manual: string[];
}

/**
 * Where the end user of the built tool types a config value, per selected surface: the same text
 * the README's Configuration lines and the skill's operations block carry, so an agent inside a
 * harness can read it without calling anything. No runtime host detection — the selection is the
 * only input, because that is what decides which hosts exist at all.
 */
const CONFIG_HOSTS: Partial<Record<SurfaceId, (project: Project, name: string) => string>> = {
  claude: () =>
    "Claude Code: `/plugin` -> this plugin -> configure. Masked input, stored in the OS keychain.",
  mcpb: () => "Claude Desktop: the masked field in the `.mcpb` install dialog.",
  gemini: (project, name) =>
    `Gemini CLI: \`gemini extensions config ${projectName.gemini(project.identity.name)} ${name}\`.`,
  "openclaw-native": (project) =>
    `OpenClaw: the Control UI at http://localhost:18789 -> Plugins -> ${project.identity.name}; \`uiHints.sensitive\` masks the field.`,
  "hermes-native": () => "Hermes: the env file `hermes config env-path` prints.",
  cursor: (_project, name) =>
    `Cursor: \`\${env:${name}}\` in the MCP entry, with the value exported in the environment.`,
  codex: (_project, name) =>
    `Codex: the environment only — upstream has no plugin secret path (openai/codex#24401), so export ${name} before running \`codex\`.`,
};

/** `<root>/.env`, parsed for presence only. Missing or unreadable is simply "nothing set here". */
function envValues(root: string): Record<string, string | undefined> {
  const path = join(root, ".env");
  if (!existsSync(path)) return {};
  try {
    return parseEnv(readFileSync(path, "utf8")) as Record<string, string | undefined>;
  } catch {
    return {};
  }
}

/** Secret *names* GitHub already holds, from `gh secret list`; undefined when `gh` cannot answer. */
function githubSecretNames(project: Project): Set<string> | undefined {
  const slug = githubSlug(project.identity.repository);
  if (!slug) return undefined;
  const names = new Set<string>();
  let answered = false;
  for (const scope of [[], ["--env", LIVE_ENVIRONMENT]]) {
    const result = spawnSync("gh", ["secret", "list", "--repo", slug, ...scope], {
      encoding: "utf8",
      timeout: 30_000,
    });
    if (result.status !== 0) continue;
    answered = true;
    for (const line of result.stdout.split("\n")) {
      const name = line.trim().split(/\s+/)[0];
      if (name) names.add(name);
    }
  }
  return answered ? names : undefined;
}

/** The `wxt submit --dry-run` probes read the zips `toolfactory package` writes; without them, say so. */
function storeZipsPresent(project: Project): boolean {
  return existsSync(join(project.root, BROWSER_HOST_DIR, ".output"));
}

function releaseHowTo(project: Project, row: Registry, name: string): string[] {
  const lines = [
    `Mint it at ${row.url}.`,
    `Add \`${name}=\` to .env, then \`${toolfactoryCli(project)} bootstrap-repo\` pushes it as a repository secret.`,
    `Used by the release's \`${releaseJob(row)}\` leg.`,
  ];
  if (!row.probe) {
    lines.push(
      `No read-only endpoint exists for ${row.id}, so \`secrets check\` cannot verify this one; the release's own submit is the check.`,
    );
  }
  return lines;
}

function configHowTo(project: Project, name: string): string[] {
  const lines = [
    `Add \`${name}=\` to .env — gitignored, and what the live tests and \`${toolfactoryCli(project)} bootstrap-repo\` read.`,
  ];
  if (has(project, "web")) {
    lines.push(
      `Or open the Secrets panel in a browser: \`${project.identity.name} mcp --http --open\`.`,
    );
  }
  for (const [surface, line] of Object.entries(CONFIG_HOSTS)) {
    if (has(project, surface)) lines.push(line(project, name));
  }
  return lines;
}

/** The live test is the check for config keys: it is already gated on exactly these credentials. */
function liveTestCommand(project: Project): string {
  return project.tool.binding === "python"
    ? LIVE_TEST_COMMAND
    : PACKAGE_MANAGER_COMMANDS[project.packageManager ?? "npm"].run("test:live");
}

/** The release.yml job a registry row's leg lives in. */
function releaseJob(row: Registry): string {
  if (["chrome", "firefox", "edge"].includes(row.id)) return "publish-browser-ext";
  if (row.id === "safari") return "publish-browser-ext-safari";
  if (row.id === "pages") return "pages-deploy";
  return `publish-${row.id === "clawhub-package" ? "clawhub" : row.id}`;
}

export function secretsReport(
  project: Project,
  action: "status" | "check" = "status",
  key?: string,
): SecretsReport {
  const values = { ...envValues(project.root) };
  const properties = configProperties(project);
  const required = new Set(requiredConfig(project));
  const github = githubSecretNames(project);
  const rows: SecretRow[] = [];

  for (const [configKey, property] of Object.entries(properties)) {
    if (!isSensitive(property)) continue;
    const name = envName(configKey);
    const meta = (property["x-toolfactory"] ?? {}) as { url?: string };
    rows.push({
      name,
      kind: "config",
      required: required.has(configKey),
      needs: Object.keys(CONFIG_HOSTS).filter((surface) => has(project, surface)),
      local: Boolean(values[name] ?? process.env[name]),
      ...(github ? { github: github.has(name) } : {}),
      ...(meta.url ? { url: meta.url } : {}),
      howTo: configHowTo(project, name),
    });
  }

  const byName = new Map<string, Registry[]>();
  for (const row of registries(project)) {
    for (const name of row.secrets) byName.set(name, [...(byName.get(name) ?? []), row]);
  }
  for (const [name, owners] of byName) {
    const first = owners[0] as Registry;
    rows.push({
      name,
      kind: "release",
      required: false,
      needs: owners.map((row) => row.id),
      local: Boolean(values[name] ?? process.env[name]),
      ...(github ? { github: github.has(name) } : {}),
      url: first.url,
      howTo: releaseHowTo(project, first, name),
    });
  }

  const selected = key ? rows.filter((row) => row.name === key) : rows;
  if (action === "check") checkSecrets(project, selected, values);
  return { secrets: selected, manual: manualSteps(project) };
}

/**
 * Delegation, never re-implemented auth: each release row runs the one upstream command its
 * registry answers with, and config keys are checked by the T4 live test, which is already gated
 * on exactly them and is already the author's own proof that the credential works.
 */
function checkSecrets(
  project: Project,
  rows: SecretRow[],
  values: Record<string, string | undefined>,
): void {
  const present = (name: string) => Boolean(values[name] ?? process.env[name]);
  const table = registries(project);
  for (const row of rows) {
    if (row.kind !== "release" || !row.local) continue;
    const registry = table.find((entry) => entry.id === row.needs[0]);
    if (!registry?.probe || !registry.secrets.every(present)) continue;
    if (registry.surfaces.includes("browser-extension") && !storeZipsPresent(project)) {
      row.howTo.push(
        `\`${toolfactoryCli(project)} package\` first: the store dry run submits the zips it writes.`,
      );
      continue;
    }
    const outcome = run({
      label: registry.id,
      command: "bash",
      args: ["-c", registry.probe],
      cwd: project.root,
      env: values as Record<string, string>,
    });
    row.check = { ok: outcome.ok, command: registry.probe };
  }
  const live = liveCredentials(project);
  if (!live.length || !live.map(envName).every(present)) return;
  const command = liveTestCommand(project);
  const outcome = run({
    label: "live tests",
    command: "bash",
    args: ["-c", command],
    cwd: project.root,
    env: values as Record<string, string>,
  });
  for (const row of rows) {
    if (row.kind === "config") row.check = { ok: outcome.ok, command };
  }
}

/** The whole inventory: what each credential is for, where it is set, and (check) whether it works. */
export function secrets(args: {
  root?: string;
  action?: "status" | "check";
  key?: string;
}): SecretsReport {
  return secretsReport(loadProject(args.root ?? "."), args.action ?? "status", args.key);
}

/** One line for `init`'s next steps; nothing at all when the project declares no credential. */
function secretsSummary(report: SecretsReport): string | undefined {
  const { secrets: rows } = report;
  if (!rows.length) return undefined;
  const missing = rows.filter((row) => !row.local).map((row) => row.name);
  return `Secrets: ${rows.length - missing.length} of ${rows.length} present in .env${
    missing.length ? ` (missing ${missing.join(", ")})` : ""
  }. \`toolfactory secrets\` prints where each one is set, per host and per registry.`;
}

// ---------------------------------------------------------------------------------------------
// unpublish — deselect's other half. Git is the ledger: the previous tag's tool.json says what
// this project used to publish, and every row that lost its surface gets retracted.
// ---------------------------------------------------------------------------------------------

export interface UnpublishResult {
  /** The tag the previous selection came from; absent when there is no earlier tag to diff against. */
  from?: string;
  /** Surfaces selected at that tag, no longer selected, and published somewhere. */
  dropped: SurfaceId[];
  steps: { name: string; run: string }[];
  /**
   * What each step did (omitted by `dryRun`). Best-effort on purpose: a registry that refuses a
   * retraction must never stop the release it is riding along with from being cut.
   */
  ran?: StepResult[];
}

/** The project as the previous tag left it, plus the surfaces it published that are now gone. */
function retractable(
  project: Project,
  tag: string,
  tool: ToolConfig,
): { previous: Project; dropped: SurfaceId[] } {
  const previous: Project = {
    ...project,
    tool,
    // The gate asserts `v<version>` against the tag, so the tag *is* the version that tag published.
    identity: { ...project.identity, version: tag.replace(/^v/, "") },
  };
  const published = new Set(registries(previous).flatMap((row) => row.surfaces));
  return {
    previous,
    dropped: droppedSurfaces(tool.surfaces, project.tool.surfaces).filter((surface) =>
      published.has(surface),
    ),
  };
}

export function unpublish(
  root = ".",
  options: { ref?: string; dryRun?: boolean; hard?: boolean } = {},
): UnpublishResult {
  const project = loadProject(root);
  const from = previousTag(project.root, options.ref ?? "HEAD");
  const tool = from ? toolAtRef(project.root, from) : undefined;
  if (!from || !tool) return { from, dropped: [], steps: [] };
  const { previous, dropped } = retractable(project, from, tool);
  const steps = unpublishSteps(previous, dropped, options.hard);
  const listed = steps.map(({ name, run }) => ({ name, run }));
  if (options.dryRun) return { from, dropped, steps: listed };
  return { from, dropped, steps: listed, ran: runSteps(project.root, steps).steps };
}

/** `build`'s one line: a surface that published somewhere is gone, and nothing has retracted it yet. */
function unpublishNudge(project: Project): string | undefined {
  const from = previousTag(project.root);
  const tool = from ? toolAtRef(project.root, from) : undefined;
  if (!from || !tool) return undefined;
  const { dropped } = retractable(project, from, tool);
  if (!dropped.length) return undefined;
  return `${dropped.join(", ")} published at ${from} and is no longer selected: \`${toolfactoryCli(project)} unpublish --dry-run\` shows what the next release will retract.`;
}

export function adopt(root: string, path: string): void {
  setState(resolve(root), path, "manual", TOOLFACTORY_VERSION);
  build(root);
}

export function unadopt(root: string, path: string): void {
  setState(resolve(root), path, "generated", TOOLFACTORY_VERSION);
  build(root);
}

export function eject(root: string, surface: SurfaceId): string[] {
  const project = loadProject(root);
  const owned = buildPlan(project, selectedSurfaces([surface])).map((file) => file.path);
  const lock = readLock(project.root);
  const adopted: string[] = [];
  for (const path of owned) {
    if (lock?.files[path]) {
      setState(project.root, path, "manual", TOOLFACTORY_VERSION);
      adopted.push(path);
    }
  }
  build(root);
  return adopted;
}

export interface DoctorReport {
  toolfactory: string;
  node: string;
  tools: Record<string, string>;
}

/** Report the upstream CLIs this machine can delegate to. */
/**
 * Prepare the GitHub repository: the `live-tests` environment and its secrets, the release
 * registries' repository secrets, Pages, and npm's trusted publisher — everything GitHub only
 * exposes over its API, from the one table and the one `.env`.
 */
export function bootstrapRepo(args: {
  root: string;
  reviewers?: string[];
  dryRun?: boolean;
}): BootstrapResult {
  const project = loadProject(args.root);
  return prepareRepository(project, {
    reviewers: args.reviewers,
    dryRun: args.dryRun,
    releaseSecrets: registries(project).flatMap((row) => row.secrets),
    manual: manualSteps(project),
  });
}

export function doctor(): DoctorReport {
  const probes: Record<string, [string, string[]]> = {
    git: ["git", ["--version"]],
    gh: ["gh", ["--version"]],
    npm: ["npm", ["--version"]],
    uv: ["uv", ["--version"]],
    claude: ["claude", ["--version"]],
    openclaw: ["openclaw", ["--version"]],
    clawhub: ["clawhub", ["--version"]],
    hermes: ["hermes", ["--version"]],
    uvx: ["uvx", ["--version"]],
    agentskills: ["uvx", ["--from", "skills-ref", "agentskills", "--help"]],
    docker: ["docker", ["--version"]],
  };
  const tools: Record<string, string> = {};
  // Never spawn npx from here: under an npx-launched MCP host that deadlocks on npm's cache lock.
  try {
    const inspector = createRequire(import.meta.url)(
      "@modelcontextprotocol/inspector/package.json",
    ) as {
      version: string;
    };
    tools["mcp-inspector"] = `${inspector.version} (npx @modelcontextprotocol/inspector)`;
  } catch {
    tools["mcp-inspector"] =
      "missing (npx --yes @modelcontextprotocol/inspector installs it on demand)";
  }
  for (const [name, [command, args]] of Object.entries(probes)) {
    const result = spawnSync(command, args, { encoding: "utf8", timeout: 10_000 });
    tools[name] =
      result.status === 0
        ? ((result.stdout || result.stderr).trim().split("\n")[0] ?? "ok")
        : "missing";
  }
  return { toolfactory: TOOLFACTORY_VERSION, node: process.version, tools };
}

export const SURFACES = SURFACE_IDS;
