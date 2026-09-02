/**
 * The command layer. Every toolfactory verb is a function here so the CLI and the MCP
 * surface expose exactly the same operations.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { getBinding } from "./bindings/index.js";
import {
  type BootstrapResult,
  type CreateRepoResult,
  createRepo,
  bootstrapRepo as prepareRepository,
} from "./hosts/github.js";
import { assertValidName, projectName } from "./identity/name.js";
import { introspect as runIntrospect, snapshot } from "./introspect/index.js";
import type { Binding, Command, Identity, PlannedFile, Project, SurfaceId } from "./model.js";
import { SURFACE_IDS, ToolConfigSchema } from "./model.js";
import { apply, check as checkPlan, type Drift, setState } from "./project/apply.js";
import { type GateStep, gateSteps, packageSteps, toolfactoryCli } from "./project/gate.js";
import { loadProject, OPS_PATH, TOOL_PATH, TOOLFACTORY_VERSION } from "./project/load.js";
import { readLock } from "./project/lock.js";
import { buildPlan, TOOL_SCHEMA_PATH } from "./project/plan.js";
import { type Coverage, computeCoverage } from "./report/coverage.js";
import { PLUGIN_SCHEMA_ID } from "./surfaces/agent-plugins.js";
import { reloadLine, SETUP_PATH } from "./surfaces/agents.js";
import { assertSurfaceRequirements, getSurface, selectedSurfaces } from "./surfaces/registry.js";
import { compact, json, liveCredentials } from "./surfaces/shared.js";
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
  return [
    agentConfig.setup
      ? `Agent config is wired: \`.agents/\` is the canon (\`skills/\`, \`mcp/servers.json\`). \`${SETUP_PATH}\` rendered ${agentConfig.harnesses.length} harness adapter(s) here (${agentConfig.harnesses.join(", ") || "none detected"}) and installed the pre-commit/post-checkout/post-merge hooks, so pulls, branch switches and commits re-sync on their own. Details: \`.agents/README.md\`.`
      : `Agent config is written but \`${SETUP_PATH}\` did not finish here: run \`bash ${SETUP_PATH}\` to render the harness adapters from \`.agents/\`, install the git hooks that keep them in sync, and install the dependencies. Details: \`.agents/README.md\`.`,
    reloadLine(process.env),
    `Next: write your operations in \`${ops}\`, then \`${cli} introspect && ${cli} build\`.`,
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
    // The live tier is GitHub-only and needs both halves: a credential declared in `tool.json`
    // and a value for it here. Without them there is no environment to create.
    const live =
      liveCredentials(project).length > 0 && existsSync(join(root, ".env"))
        ? prepareRepository(project, {
            repository: options.repo,
            reviewers: options.reviewers,
            dryRun: options.dryRun,
          })
        : undefined;
    result.repository = {
      ...created,
      commands: [...created.commands, ...(live?.commands ?? [])],
      secrets: live?.secrets ?? [],
    };
  }
  return result;
}

export function build(root = ".") {
  const project = loadProject(root);
  return { project, result: apply(project.root, buildPlan(project), TOOLFACTORY_VERSION) };
}

/** Throws when any generated file drifted, so CLI and MCP callers see a failure. */
/** The drift gate: the operation snapshot and every generated file must match the code. */
export async function check(root = "."): Promise<{ project: Project; drift: Drift[] }> {
  const project = loadProject(root);
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
/** Prepare the GitHub repository for the live tier: the `live-tests` environment and its secrets. */
export function bootstrapRepo(args: {
  root: string;
  reviewers?: string[];
  dryRun?: boolean;
}): BootstrapResult {
  return prepareRepository(loadProject(args.root), {
    reviewers: args.reviewers,
    dryRun: args.dryRun,
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
