/**
 * The I/O half of the OpenClaw surface: §8 C2, "mirror scaffolds by execution, not
 * transcription". Runs the real `openclaw plugins init --type tool` into a temp directory and
 * checks that everything it writes still agrees with what `plan()` emits, so an upstream default
 * change is inherited on the next toolfactory release instead of silently rotting in a constant.
 *
 * Runnable as a script (`node dist/hosts/openclaw.js <root>`) because that is how the surface's
 * `validate()` step reaches it: one Command like every other validator.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { argv, exit, stderr, stdout } from "node:process";
import { fileURLToPath } from "node:url";
import type { PlannedFile, Project } from "../model.js";
import type { Drift } from "../project/apply.js";
import { loadProject } from "../project/load.js";
import { HOST_DIR, OPENCLAW_SCAFFOLD, surface } from "../surfaces/openclaw-native.js";

export const DRIFT_ENTRY = fileURLToPath(import.meta.url);

/** Per-tool values: the scaffold writes its own, and the projection is expected to differ. */
const PER_TOOL_KEYS = new Set(["name", "version", "description"]);

/**
 * Keys `tool.json` deliberately overrides (`openclaw.pluginApi` and the extra dependency maps):
 * the scaffold's value is not law where the author has replaced it on purpose.
 */
function overridden(project: Project): Set<string> {
  const openclaw = project.tool.openclaw;
  // The host development dependency is deliberately pinned to the recorded scaffold release.
  const paths = new Set<string>([".devDependencies.openclaw"]);
  for (const section of ["dependencies", "peerDependencies", "devDependencies"] as const) {
    for (const key of Object.keys(openclaw?.[section] ?? {})) paths.add(`.${section}.${key}`);
  }
  if (openclaw?.pluginApi) {
    paths.add(".peerDependencies.openclaw");
    paths.add(".openclaw.compat.pluginApi");
  }
  // Shipped skills append to `files`; upstream's entries must still survive (checked below).
  if (openclaw?.skills?.length) paths.add(".files");
  return paths;
}

/**
 * Every scaffold key must survive into the projection with the same value; extra keys are the
 * generator's own additions (the core dependency, the projected tools, the inspector fixture)
 * and are allowed, as are the keys `tool.json` overrides on purpose.
 */
function missing(scaffold: unknown, ours: unknown, path: string, skip: Set<string>): string[] {
  if (skip.has(path)) return [];
  if (scaffold === null || typeof scaffold !== "object" || Array.isArray(scaffold)) {
    return JSON.stringify(scaffold) === JSON.stringify(ours)
      ? []
      : [`${path}: upstream ${JSON.stringify(scaffold)}, generated ${JSON.stringify(ours)}`];
  }
  if (ours === null || typeof ours !== "object" || Array.isArray(ours)) {
    return [`${path}: upstream object, generated ${JSON.stringify(ours)}`];
  }
  const right = ours as Record<string, unknown>;
  return Object.entries(scaffold as Record<string, unknown>).flatMap(([key, value]) =>
    path === "" && PER_TOOL_KEYS.has(key) ? [] : missing(value, right[key], `${path}.${key}`, skip),
  );
}

function planned(files: PlannedFile[], path: string): string {
  const file = files.find((candidate) => candidate.path === `${HOST_DIR}/${path}`);
  if (!file) throw new Error(`the openclaw surface no longer plans ${path}`);
  if (file.kind === "file") return file.content;
  if (file.kind === "merge" && file.format === "json") return JSON.stringify(file.patch, null, 2);
  throw new Error(`the openclaw surface no longer plans ${path} as JSON`);
}

/** Human-readable drift lines; empty means the generator still mirrors upstream. */
export function scaffoldDrift(project: Project): string[] {
  const files = surface.plan(project);
  const directory = mkdtempSync(join(tmpdir(), "toolfactory-openclaw-"));
  // The probe must run the exact openclaw this project pins (author override or the
  // scaffold default) - never whatever happens to be on PATH, which made the drift verdict
  // environment-dependent: the scaffold openclawVersion is the running CLI own version.
  const pin = project.tool.openclaw?.devDependencies?.openclaw ?? OPENCLAW_SCAFFOLD.openclawVersion;
  const pinned = join(project.root, HOST_DIR, "node_modules/.bin/openclaw");
  try {
    const probe = existsSync(pinned)
      ? { command: pinned, pre: [] as string[] }
      : { command: "npx", pre: ["--yes", `openclaw@${pin}`] };
    execFileSync(
      probe.command,
      [
        ...probe.pre,
        "plugins",
        "init",
        "tf-probe",
        "--type",
        "tool",
        "--directory",
        join(directory, "probe"),
      ],
      { stdio: "pipe" },
    );
    const scaffold = (path: string) => readFileSync(join(directory, "probe", path), "utf8");
    const skip = overridden(project);
    const drift = [
      ...["package.json", "tsconfig.json"].flatMap((path) =>
        missing(JSON.parse(scaffold(path)), JSON.parse(planned(files, path)), "", skip).map(
          (line) => `${path}${line}`,
        ),
      ),
      ...(scaffold("vitest.config.ts") === planned(files, "vitest.config.ts")
        ? []
        : ["vitest.config.ts: upstream template changed"]),
    ];
    if (project.tool.openclaw?.skills?.length) {
      const upstream = (JSON.parse(scaffold("package.json")) as { files?: string[] }).files ?? [];
      const ours = (JSON.parse(planned(files, "package.json")) as { files?: string[] }).files ?? [];
      const lost = upstream.filter((entry) => !ours.includes(entry));
      if (lost.length) drift.push(`package.json.files lost upstream entries: ${lost.join(", ")}`);
    }
    return drift;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * The copy is what the plugin's runtime lookup resolves, and nothing syncs it: after the core
 * gains an operation, a stale copy still registers the tool but every call fails with
 * "operation … is missing from the core package". Opt-in via a MATERIALIZED marker, so
 * npm-installed cores in generated tools are never compared against a workspace build.
 */
export function coreCopyDrift(root: string): Drift[] {
  // Resolves HOST_DIR lazily: this module sits in an import cycle with
  // surfaces/openclaw-native.js (DRIFT_ENTRY), so nothing may touch its exports at module scope.
  const copy = join(root, HOST_DIR, "node_modules", "toolfactory");
  if (!existsSync(join(copy, "MATERIALIZED"))) return [];
  const source = join(root, "dist");
  if (!existsSync(source)) return [];
  return treeDrift(
    source,
    join(copy, "dist"),
    join(HOST_DIR, "node_modules", "toolfactory", "dist"),
  );
}

/** Byte-compare two trees in both directions; `label` prefixes every reported path. */
function treeDrift(source: string, copy: string, label: string): Drift[] {
  if (!existsSync(copy)) return [{ kind: "changed", path: label }];
  const drift: Drift[] = [];
  for (const name of new Set([...readdirSync(source), ...readdirSync(copy)])) {
    const ours = join(source, name);
    const theirs = join(copy, name);
    const oursDir = existsSync(ours) && statSync(ours).isDirectory();
    const theirsDir = existsSync(theirs) && statSync(theirs).isDirectory();
    if (oursDir || theirsDir) {
      if (oursDir && theirsDir) drift.push(...treeDrift(ours, theirs, join(label, name)));
      else drift.push({ kind: "changed", path: join(label, name) });
    } else if (
      !existsSync(ours) ||
      !existsSync(theirs) ||
      !readFileSync(ours).equals(readFileSync(theirs))
    ) {
      drift.push({ kind: "changed", path: join(label, name) });
    }
  }
  return drift;
}

if (argv[1] === DRIFT_ENTRY) {
  const drift = scaffoldDrift(loadProject(argv[2] ?? "."));
  if (drift.length) {
    stderr.write(
      `openclaw scaffold drifted upstream; update src/surfaces/openclaw-native.ts:\n${drift
        .map((line) => `  ${line}`)
        .join("\n")}\n`,
    );
    exit(1);
  }
  stdout.write("openclaw plugins init still matches src/surfaces/openclaw-native.ts\n");
}
