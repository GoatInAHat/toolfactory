/** Verify the extension scaffold against Microsoft's generator, without touching the checkout. */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { argv } from "node:process";
import { fileURLToPath } from "node:url";
import {
  ESBUILD,
  ESLINT,
  GITIGNORE,
  IGNORE,
  LAUNCH,
  TASKS,
  VSCODE_GENERATOR,
  VSCODE_SCAFFOLD,
} from "../surfaces/vscode-scaffold.js";

export function scaffoldDrift(): string[] {
  const root = mkdtempSync(join(tmpdir(), "toolfactory-vscode-scaffold-"));
  const target = join(root, "probe");
  try {
    execFileSync(
      "npx",
      [
        "--yes",
        "--package",
        "yo",
        "--package",
        `generator-code@${VSCODE_GENERATOR}`,
        "--",
        "yo",
        "code",
        target,
        "--extensionType",
        "ts",
        "--extensionDisplayName",
        "ToolFactory Probe",
        "--extensionId",
        "tf-probe",
        "--extensionDescription",
        "ToolFactory scaffold probe",
        "--pkgManager",
        "npm",
        "--bundler",
        "esbuild",
        "--gitInit",
        "false",
        "--skip-install",
        "--skipOpen",
        "--quick",
      ],
      { stdio: "pipe", cwd: root },
    );
    const pkg = JSON.parse(readFileSync(join(target, "package.json"), "utf8"));
    const drift = Object.entries(VSCODE_SCAFFOLD)
      .filter(([key, expected]) => JSON.stringify(pkg[key]) !== JSON.stringify(expected))
      .map(([key]) => `package.json ${key}`);
    for (const [path, expected] of [
      ["esbuild.js", ESBUILD],
      ["eslint.config.mjs", ESLINT],
      [".vscodeignore", IGNORE],
      [".gitignore", GITIGNORE],
      [".vscode/launch.json", LAUNCH],
      [".vscode/tasks.json", TASKS],
    ]) {
      if (readFileSync(join(target, path), "utf8") !== expected) drift.push(path);
    }
    return drift;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (argv[1] === fileURLToPath(import.meta.url)) {
  const drift = scaffoldDrift();
  if (drift.length) throw new Error(`VS Code scaffold drifted: ${drift.join(", ")}`);
  process.stdout.write("VS Code scaffold matches generator-code.\n");
}
