/**
 * The command layer. Every toolfactory verb is a function here so the CLI and the MCP
 * surface expose exactly the same operations.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { getBinding } from "./bindings/index.js";
import { assertValidName } from "./identity/name.js";
import { introspect as runIntrospect } from "./introspect/index.js";
import type { Binding, Command, Identity, PlannedFile, Project, SurfaceId } from "./model.js";
import { SURFACE_IDS, ToolConfigSchema } from "./model.js";
import { apply, check as checkPlan, type Drift, setState } from "./project/apply.js";
import { loadProject, TOOL_PATH, TOOLFACTORY_VERSION } from "./project/load.js";
import { readLock } from "./project/lock.js";
import { buildPlan, TOOL_SCHEMA_PATH } from "./project/plan.js";
import { type Coverage, computeCoverage } from "./report/coverage.js";
import { PLUGIN_SCHEMA_ID } from "./surfaces/agent-plugins.js";
import { selectedSurfaces } from "./surfaces/registry.js";
import { compact, json } from "./surfaces/shared.js";
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

/** Create dev.toolfactory/tool.json, the identity file, and the binding's scaffold. */
export function init(options: InitOptions): { written: string[] } {
  const root = resolve(options.root);
  assertValidName(options.name);
  const surfaces = [...new Set(options.surfaces)];
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
  // The kernel files exist from the first moment so `introspect` can spawn the server.
  written.push(...build(root).result.written);
  return { written };
}

export function build(root = ".") {
  const project = loadProject(root);
  return { project, result: apply(project.root, buildPlan(project), TOOLFACTORY_VERSION) };
}

/** Throws when any generated file drifted, so CLI and MCP callers see a failure. */
export function check(root = "."): { project: Project; drift: Drift[] } {
  const project = loadProject(root);
  const drift = checkPlan(project.root, buildPlan(project), TOOLFACTORY_VERSION);
  if (drift.length) {
    throw new Error(
      `${drift.length} generated file(s) out of date; run \`toolfactory build\`:\n${drift.map((d) => `  ${d.kind}: ${d.path}`).join("\n")}`,
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
export function doctor(): DoctorReport {
  const probes: Record<string, [string, string[]]> = {
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
