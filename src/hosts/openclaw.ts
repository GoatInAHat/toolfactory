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
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { argv, exit, stderr, stdout } from "node:process";
import { fileURLToPath } from "node:url";
import type { PlannedFile, Project } from "../model.js";
import { loadProject } from "../project/load.js";
import { HOST_DIR, surface } from "../surfaces/openclaw-native.js";

export const DRIFT_ENTRY = fileURLToPath(import.meta.url);

/** Per-tool values: the scaffold writes its own, and the projection is expected to differ. */
const PER_TOOL_KEYS = new Set(["name", "version", "description"]);

/**
 * Keys `tool.json` deliberately overrides (`openclaw.pluginApi` and the extra dependency maps):
 * the scaffold's value is not law where the author has replaced it on purpose.
 */
function overridden(project: Project): Set<string> {
  const openclaw = project.tool.openclaw;
  const paths = new Set<string>();
  for (const section of ["dependencies", "peerDependencies", "devDependencies"] as const) {
    for (const key of Object.keys(openclaw?.[section] ?? {})) paths.add(`.${section}.${key}`);
  }
  if (openclaw?.pluginApi) {
    paths.add(".peerDependencies.openclaw");
    paths.add(".openclaw.compat.pluginApi");
  }
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
  if (file?.kind !== "file") throw new Error(`the openclaw surface no longer plans ${path}`);
  return file.content;
}

/** Human-readable drift lines; empty means the generator still mirrors upstream. */
export function scaffoldDrift(project: Project): string[] {
  const files = surface.plan(project);
  const directory = mkdtempSync(join(tmpdir(), "toolfactory-openclaw-"));
  // Prefer the openclaw the plugin pins as a devDependency over whatever is on PATH.
  const pinned = join(project.root, HOST_DIR, "node_modules/.bin/openclaw");
  try {
    execFileSync(
      existsSync(pinned) ? pinned : "openclaw",
      ["plugins", "init", "tf-probe", "--type", "tool", "--directory", join(directory, "probe")],
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
    return drift;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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
