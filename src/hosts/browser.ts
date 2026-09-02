/**
 * The I/O half of the browser-extension surface: §8 C2, "mirror scaffolds by execution, not
 * transcription". Runs the real `wxt init` into a temp directory and checks that everything it
 * writes still agrees with BROWSER_SCAFFOLD, so an upstream template change is inherited on the
 * next toolfactory release instead of silently rotting in a constant.
 *
 * The same run also seeds the project's placeholder icon set. Those five PNGs are WXT's binary
 * files, not toolfactory's, and a pure `plan()` can only emit text — so they are copied out of
 * the fresh scaffold when the project is missing them, exactly as the shadcn CLI (not the web
 * surface) writes the components under `web/src/components/ui/`.
 *
 * Runnable as a script (`node dist/hosts/browser.js <root>`) because that is how the surface's
 * `validate()` step reaches it: one Command like every other validator.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { argv, exit, stderr, stdout } from "node:process";
import { fileURLToPath } from "node:url";
import type { Project } from "../model.js";
import { loadProject } from "../project/load.js";
import { BROWSER_SCAFFOLD, HOST_DIR, WXT_PIN } from "../surfaces/browser-extension.js";

export const DRIFT_ENTRY = fileURLToPath(import.meta.url);

/** Where WXT's auto-detection looks for the icon set, and therefore where the scaffold writes it. */
const ICON_DIR = "public/icon";

function differs(label: string, upstream: unknown, pinned: unknown): string[] {
  return JSON.stringify(upstream) === JSON.stringify(pinned)
    ? []
    : [`${label}: \`wxt init\` and BROWSER_SCAFFOLD no longer agree`];
}

/**
 * Drift lines (empty means the generator still writes what BROWSER_SCAFFOLD pins) and the icons
 * copied into the project because it had none.
 */
export function mirrorScaffold(project: Project): { drift: string[]; seeded: string[] } {
  const directory = mkdtempSync(join(tmpdir(), "toolfactory-browser-"));
  const probe = join(directory, "probe");
  // Prefer the wxt the extension pins as a devDependency over a fresh download.
  const pinned = join(project.root, HOST_DIR, "node_modules/.bin/wxt");
  try {
    execFileSync(
      existsSync(pinned) ? pinned : "npx",
      [
        ...(existsSync(pinned) ? [] : ["--yes", `wxt@${WXT_PIN}`]),
        "init",
        probe,
        "--template",
        BROWSER_SCAFFOLD.template,
        "--pm",
        BROWSER_SCAFFOLD.packageManager,
      ],
      { stdio: "pipe" },
    );
    const scaffold = (path: string) => readFileSync(join(probe, path), "utf8");
    const packageJson = JSON.parse(scaffold("package.json")) as Record<string, unknown>;
    const icons = join(project.root, HOST_DIR, ICON_DIR);
    const seeded = BROWSER_SCAFFOLD.icons.flatMap((size) => {
      const name = `${size}.png`;
      if (!existsSync(join(probe, ICON_DIR, name))) return [];
      if (existsSync(join(icons, name))) return [];
      mkdirSync(icons, { recursive: true });
      copyFileSync(join(probe, ICON_DIR, name), join(icons, name));
      return [`${ICON_DIR}/${name}`];
    });
    return {
      drift: [
        ...(["scripts", "dependencies", "devDependencies"] as const).flatMap((key) =>
          differs(`package.json ${key}`, packageJson[key], BROWSER_SCAFFOLD.packageJson[key]),
        ),
        ...(scaffold("tsconfig.json") === BROWSER_SCAFFOLD.tsconfig
          ? []
          : ["tsconfig.json: the template no longer writes what BROWSER_SCAFFOLD.tsconfig pins"]),
        ...(scaffold(".gitignore") === BROWSER_SCAFFOLD.gitignore
          ? []
          : [".gitignore: the template no longer writes what BROWSER_SCAFFOLD.gitignore pins"]),
        ...BROWSER_SCAFFOLD.icons.flatMap((size) =>
          existsSync(join(probe, ICON_DIR, `${size}.png`))
            ? []
            : [`${ICON_DIR}/${size}.png: the template no longer ships this icon`],
        ),
      ],
      seeded,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (argv[1] === DRIFT_ENTRY) {
  const { drift, seeded } = mirrorScaffold(loadProject(argv[2] ?? "."));
  for (const path of seeded) stdout.write(`copied WXT's ${path} into ${HOST_DIR}\n`);
  if (drift.length) {
    stderr.write(
      `the wxt scaffold drifted upstream; update BROWSER_SCAFFOLD in src/surfaces/browser-extension.ts:\n${drift
        .map((line) => `  ${line}`)
        .join("\n")}\n`,
    );
    exit(1);
  }
  stdout.write(`wxt init still matches src/surfaces/browser-extension.ts\n`);
}
