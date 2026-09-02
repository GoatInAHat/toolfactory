/**
 * The I/O half of the `agents` surface: §8 C2, "mirror scaffolds by execution, not
 * transcription", applied to a repository instead of a generator. The agent-config machinery
 * every generated project carries — `.agents/sync.py`, the hook carriers, the agent-config
 * workflow — is one shared contract owned by github.com/GoatInAHat/template, and a copy of a
 * moving contract rots silently. So the bytes are vendored into `src/surfaces/agents.template.ts`
 * by this module's `--write` mode, and the copy is proved by cloning the real repository and
 * diffing it file by file.
 *
 * Runnable as a script (`node dist/hosts/template.js [<url or checkout>] [--write]`) because that
 * is how the surface's `validate()` step reaches it: one Command like every other validator.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { argv, exit, stderr, stdout } from "node:process";
import { fileURLToPath } from "node:url";
import { TEMPLATE_COMMIT, TEMPLATE_FILES } from "../surfaces/agents.template.js";

export const DRIFT_ENTRY = fileURLToPath(import.meta.url);
export const TEMPLATE_URL = "https://github.com/GoatInAHat/template";

/**
 * The template files toolfactory projects into every generated repository. The two it does not
 * vendor are the two it writes itself: `.agents/mcp/servers.json` (a merge file, so a teammate's
 * absorbed server survives a rebuild) and `AGENTS.md` (a region file with the tool's own prose).
 */
export const VENDORED_PATHS = [
  ".agents/README.md",
  ".agents/setup",
  ".agents/skills/.gitkeep",
  ".agents/sync.py",
  ".claude/settings.json",
  ".cursor/environment.json",
  ".devcontainer/Dockerfile",
  ".devcontainer/devcontainer.json",
  ".gitattributes",
  ".github/workflows/agent-config.yml",
  ".github/workflows/copilot-setup-steps.yml",
  ".gitignore",
];

/** Where `--write` puts the vendored bytes; a source-tree path, since re-vendoring is a dev step. */
const VENDORED_MODULE = join(dirname(DRIFT_ENTRY), "..", "surfaces", "agents.template.ts");

function head(root: string): string {
  return execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
}

/** A local checkout is used where it is; anything else is cloned shallow into a temp directory. */
function checkout(source: string): { root: string; commit: string; dispose: () => void } {
  const local = (() => {
    try {
      return statSync(source).isDirectory();
    } catch {
      return false;
    }
  })();
  if (local) return { root: source, commit: head(source), dispose: () => {} };
  const directory = mkdtempSync(join(tmpdir(), "toolfactory-template-"));
  execFileSync("git", ["clone", "--depth", "1", source, directory], { stdio: "pipe" });
  return {
    root: directory,
    commit: head(directory),
    dispose: () => rmSync(directory, { recursive: true, force: true }),
  };
}

function read(root: string, path: string): string | undefined {
  try {
    return readFileSync(join(root, path), "utf8");
  } catch {
    return undefined;
  }
}

/** Human-readable drift lines; empty means the vendored copy is still the template's own bytes. */
export function scaffoldDrift(source: string = TEMPLATE_URL): string[] {
  const at = checkout(source);
  try {
    return VENDORED_PATHS.flatMap((path) => {
      const upstream = read(at.root, path);
      if (upstream === undefined) return [`${path}: no longer in the template`];
      if (TEMPLATE_FILES[path] === undefined) return [`${path}: not vendored`];
      return upstream === TEMPLATE_FILES[path] ? [] : [`${path}: the template moved`];
    });
  } finally {
    at.dispose();
  }
}

function moduleSource(files: Record<string, string>, commit: string): string {
  return [
    "/**",
    ` * Vendored from ${TEMPLATE_URL} at ${commit}.`,
    " *",
    " * Do not edit: written by `pnpm vendor:template`, proved by `src/hosts/template.ts`'s",
    " * scaffoldDrift, which the `agents` surface's validate() runs against the real repository.",
    " */",
    `export const TEMPLATE_COMMIT = ${JSON.stringify(commit)};`,
    "",
    "export const TEMPLATE_FILES: Record<string, string> = {",
    ...VENDORED_PATHS.map((path) => `  ${JSON.stringify(path)}: ${JSON.stringify(files[path])},`),
    "};",
    "",
  ].join("\n");
}

/** Re-vendor: read every projected file out of a checkout and rewrite the constants module. */
export function vendor(source: string = TEMPLATE_URL): { commit: string; path: string } {
  const at = checkout(source);
  try {
    const files = Object.fromEntries(
      VENDORED_PATHS.map((path) => {
        const content = read(at.root, path);
        if (content === undefined) throw new Error(`${path} is not in ${source}`);
        return [path, content];
      }),
    );
    writeFileSync(VENDORED_MODULE, moduleSource(files, at.commit));
    return { commit: at.commit, path: VENDORED_MODULE };
  } finally {
    at.dispose();
  }
}

if (argv[1] === DRIFT_ENTRY) {
  const args = argv.slice(2);
  const write = args.includes("--write");
  const source = args.find((argument) => !argument.startsWith("--")) ?? TEMPLATE_URL;
  if (write) {
    const { commit, path } = vendor(source);
    stdout.write(`vendored ${VENDORED_PATHS.length} template files at ${commit} into ${path}\n`);
  } else {
    const drift = scaffoldDrift(source);
    if (drift.length) {
      stderr.write(
        `the agent-config template drifted; re-run \`pnpm vendor:template\`:\n${drift
          .map((line) => `  ${line}`)
          .join("\n")}\n`,
      );
      exit(1);
    }
    stdout.write(
      `the template still matches src/surfaces/agents.template.ts (vendored at ${TEMPLATE_COMMIT})\n`,
    );
  }
}
