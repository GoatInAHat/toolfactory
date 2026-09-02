/**
 * The I/O half of the web surface: §8 C2, "mirror scaffolds by execution, not transcription".
 * Runs the real generators — `npm create vite`, the Tailwind and alias steps from
 * ui.shadcn.com/docs/installation/vite, `shadcn init` and `shadcn add` — into a temp directory,
 * seeding it with the very files `plan()` emits, then checks that everything they write still
 * agrees with WEB_SCAFFOLD, so an upstream default change is inherited on the next toolfactory
 * release instead of silently rotting in a constant.
 *
 * Runnable as a script (`node dist/hosts/web.js <root>`) because that is how the surface's
 * `validate()` step reaches it: one Command like every other validator.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { argv, exit, stderr, stdout } from "node:process";
import { fileURLToPath } from "node:url";
import type { PlannedFile, Project } from "../model.js";
import { loadProject } from "../project/load.js";
import { surface, TAILWIND_CSS, WEB_DIR, WEB_SCAFFOLD } from "../surfaces/web.js";

export const DRIFT_ENTRY = fileURLToPath(import.meta.url);

/** The scaffold's own config, which the generators read before writing anything else. */
const SEEDED = ["vite.config.ts", "tsconfig.json", "tsconfig.app.json"];

function planned(files: PlannedFile[], path: string): string {
  const file = files.find((candidate) => candidate.path === `${WEB_DIR}/${path}`);
  if (file?.kind !== "file") throw new Error(`the web surface no longer plans ${path}`);
  return file.content;
}

/** JSON with the comments a tsconfig is allowed to carry. */
function parse(text: string): unknown {
  return JSON.parse(text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""));
}

function differs(label: string, upstream: unknown, pinned: unknown): string[] {
  return JSON.stringify(upstream) === JSON.stringify(pinned)
    ? []
    : [`${label}: upstream and WEB_SCAFFOLD no longer agree`];
}

/** Human-readable drift lines; empty means the generators still write what WEB_SCAFFOLD says. */
export function scaffoldDrift(project: Project): string[] {
  const files = surface.plan(project);
  const directory = mkdtempSync(join(tmpdir(), "toolfactory-web-"));
  const probe = join(directory, WEB_DIR);
  // Prefer the shadcn the page pins as a dependency over whatever is on PATH.
  const pinned = join(project.root, WEB_DIR, "node_modules/.bin/shadcn");
  const shadcn = (args: string[]) =>
    existsSync(pinned)
      ? execFileSync(pinned, [...args, "--cwd", probe], { stdio: "pipe" })
      : execFileSync("npx", ["--yes", "shadcn@latest", ...args, "--cwd", probe], { stdio: "pipe" });
  try {
    execFileSync(
      "npm",
      ["create", "vite@latest", WEB_DIR, "--", "--template", WEB_SCAFFOLD.viteTemplate],
      { cwd: directory, stdio: "pipe" },
    );
    const scaffold = (path: string) => readFileSync(join(probe, path), "utf8");
    const drift = Object.keys(WEB_SCAFFOLD.vite).flatMap((path) =>
      scaffold(path) === WEB_SCAFFOLD.vite[path as keyof typeof WEB_SCAFFOLD.vite]
        ? []
        : [`${path}: \`npm create vite\` no longer writes what WEB_SCAFFOLD.vite pins`],
    );

    // The documentation's Tailwind and alias steps, as the generated project carries them.
    writeFileSync(join(probe, "src/index.css"), TAILWIND_CSS);
    for (const path of SEEDED) writeFileSync(join(probe, path), planned(files, path));
    execFileSync("npm", ["--prefix", probe, "install", "tailwindcss", "@tailwindcss/vite"], {
      stdio: "pipe",
    });
    shadcn(["init", "--yes", "--base", WEB_SCAFFOLD.base, "--preset", WEB_SCAFFOLD.preset]);
    shadcn(["add", "--yes", ...WEB_SCAFFOLD.components]);

    const packageJson = JSON.parse(scaffold("package.json")) as Record<string, unknown>;
    return [
      ...drift,
      ...(["scripts", "dependencies", "devDependencies"] as const).flatMap((key) =>
        differs(`package.json ${key}`, packageJson[key], WEB_SCAFFOLD.packageJson[key]),
      ),
      ...differs(
        "components.json",
        parse(scaffold("components.json")),
        WEB_SCAFFOLD.componentsJson,
      ),
      ...(scaffold("src/index.css") === WEB_SCAFFOLD.indexCss
        ? []
        : ["src/index.css: `shadcn init` no longer writes what WEB_SCAFFOLD.indexCss pins"]),
      ...(scaffold("src/lib/utils.ts") === WEB_SCAFFOLD.utils
        ? []
        : ["src/lib/utils.ts: `shadcn init` no longer writes what WEB_SCAFFOLD.utils pins"]),
    ];
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (argv[1] === DRIFT_ENTRY) {
  const drift = scaffoldDrift(loadProject(argv[2] ?? "."));
  if (drift.length) {
    stderr.write(
      `web scaffold drifted upstream; update WEB_SCAFFOLD in src/surfaces/web.ts:\n${drift
        .map((line) => `  ${line}`)
        .join("\n")}\n`,
    );
    exit(1);
  }
  stdout.write("the vite + shadcn scaffold still matches src/surfaces/web.ts\n");
}
