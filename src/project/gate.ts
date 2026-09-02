/**
 * The gate and the release assets, as data.
 *
 * The gate is a command; CI is its projection. One list of steps is rendered three ways — the
 * `test` job of `ci.yml`, the `gate`/`package` jobs of `release.yml`, and a shell script a local
 * `toolfactory gate` / `toolfactory package` spawns — so "what green means" has exactly one
 * definition whether or not the project ever sees GitHub.
 *
 * A step here is a command and nothing else. GitHub Actions `uses:` steps are runner provisioning
 * (checkout, toolchains, caches) and stay in `src/surfaces/workflows.ts`, which wraps this list.
 */
import { projectName } from "../identity/name.js";
import type { PackageManager, Project } from "../model.js";
import { HOST_DIR as DSH_HOST_DIR } from "../surfaces/dsh.js";
import { MANIFEST_PATH as MCPB_MANIFEST_PATH, MCPB_PIN } from "../surfaces/mcpb.js";
import { HOST_DIR as OPENCLAW_HOST_DIR } from "../surfaces/openclaw-native.js";
import { has, npmName } from "../surfaces/shared.js";

export interface GateStep {
  /** Step label: the CI step name, and the banner the shell script echoes. */
  name: string;
  run: string;
  /**
   * `"ci"` — runner provisioning no checkout may perform on the author's machine (a global or
   * system-wide install); the local runner skips it. `"node24"` — needs Node >= 24, which the
   * `openclaw` CLI does; the matrix guard in `ci.yml`.
   */
  when?: "ci" | "node24";
  env?: Record<string, string>;
}

/** Where `toolfactory package` and the release `package` job leave every asset. */
export const RELEASE_DIR = "dist/release";

/** The web app's build, shared by the release tarball and the Pages job (which sets `PAGES_BASE`). */
export const WEB_BUILD = "npm -C web ci && npm -C web run build";

/** The commands each supported package manager spells; `package.json` `packageManager` picks the row. */
export const PACKAGE_MANAGER_COMMANDS: Record<
  PackageManager,
  { install: string; run: (script: string) => string; test: string }
> = {
  npm: {
    install: "npm ci",
    run: (script) => `npm run --if-present ${script}`,
    test: "npm test",
  },
  pnpm: {
    install: "pnpm install --frozen-lockfile",
    run: (script) => `pnpm run --if-present ${script}`,
    test: "pnpm test",
  },
};

/** How the project invokes toolfactory: the devDependency in a TypeScript project, a pinned fetch otherwise. */
export function toolfactoryCli(project: Project): string {
  return project.tool.binding === "typescript"
    ? "npx toolfactory"
    : `npx --yes toolfactory@${project.toolfactoryVersion}`;
}

function commands(project: Project) {
  return PACKAGE_MANAGER_COMMANDS[project.packageManager ?? "npm"];
}

/**
 * Dependencies and, for TypeScript, the build — everything both the gate and the packaging run
 * need before any command that imports the project's own code.
 */
/**
 * Output files (§2.2 S4) are build products, not tracked: a fresh checkout has none, and the
 * validators and the web build read them. On a tree `check` has just proved current, `build`
 * writes exactly those.
 */
export function outputsStep(project: Project): GateStep {
  return { name: "toolfactory build (output files)", run: `${toolfactoryCli(project)} build` };
}

export function bootstrapSteps(project: Project): GateStep[] {
  const pm = commands(project);
  return project.tool.binding === "typescript"
    ? [
        { name: "install", run: pm.install, when: "ci" },
        { name: "build", run: pm.run("build") },
      ]
    : [{ name: "install", run: "uv sync", when: "ci" }];
}

/**
 * The gate: bootstrap, the drift check, the validator CLIs the selected surfaces need on PATH,
 * `toolfactory validate` (every surface's own upstream validator), the author's `check` and
 * tests, and the credential-free OpenClaw turn. Nothing is transcribed from a surface — the
 * commands a surface owns are reached through `toolfactory validate`, so this list cannot drift
 * away from what `validate` actually runs.
 */
export function gateSteps(project: Project): GateStep[] {
  const typescript = project.tool.binding === "typescript";
  const pm = commands(project);
  const cli = toolfactoryCli(project);
  const openclaw = has(project, "openclaw-native");
  const steps: GateStep[] = [
    ...bootstrapSteps(project),
    { name: "toolfactory check", run: `${cli} check` },
    outputsStep(project),
  ];
  if (has(project, "claude")) {
    steps.push({
      name: "Install Claude Code CLI",
      run: "npm i -g @anthropic-ai/claude-code",
      when: "ci",
    });
  }
  if (has(project, "web")) {
    // The web smoke drives Chromium; web/'s own npm install fetches the browser, the runner
    // needs its system libraries.
    steps.push({
      name: "Install Chromium dependencies",
      run: "npx --yes playwright install-deps chromium",
      when: "ci",
    });
  }
  steps.push({
    name: "toolfactory validate",
    run: `${cli} validate`,
    // openclaw-native's validate() shells to the openclaw CLI, which needs Node >=24.
    ...(openclaw ? { when: "node24" as const } : {}),
  });
  if (typescript) steps.push({ name: "author checks", run: pm.run("check") });
  steps.push({
    name: "author tests",
    run: typescript ? pm.test : "uv run --with pytest pytest -q",
  });
  if (openclaw) {
    // T3, credential-free: one real OpenClaw agent turn against a scripted model. The suite only
    // exists when `tool.json` `tests.examples` names an operation the plugin carries, which is
    // exactly what npm's own `--if-present` asks.
    steps.push({
      name: "openclaw end-to-end (scripted model, no LLM key)",
      run: `npm --prefix ${OPENCLAW_HOST_DIR} run --if-present test:e2e`,
      when: "node24",
    });
  }
  return steps;
}

/**
 * §2.2: one version, in the identity file, projected everywhere by `build`. A release therefore
 * asserts the tag against it and never writes it — rewriting a SHA-locked file from the tag would
 * be a change `build` did not make and `check` would fail on the next run.
 */
export function tagVersionAssert(project: Project): GateStep | undefined {
  const identity = project.tool.identity;
  const read = identity.endsWith(".json")
    ? `node -p "require('./${identity}').version"`
    : identity.endsWith(".toml")
      ? `python3 -c "import tomllib,pathlib;print(tomllib.loads(pathlib.Path('${identity}').read_text())['project']['version'])"`
      : undefined;
  if (!read) return undefined;
  return {
    name: `tag matches ${identity}`,
    run: `test "v$(${read})" = "$GITHUB_REF_NAME"`,
  };
}

/** The bundle paths a plugin zip carries, in the order a reader wants them: identity, then payload. */
function bundlePaths(project: Project): string[] {
  const paths: string[] = [];
  if (has(project, "agent-plugins")) paths.push(project.tool.identity, "mcp.json");
  if (has(project, "skill")) paths.push("skills");
  if (has(project, "claude")) paths.push(".claude-plugin");
  if (has(project, "codex")) paths.push(".codex-plugin");
  if (has(project, "cursor")) paths.push(".cursor-plugin");
  return paths;
}

/**
 * The release assets, into `dist/release/`: the same list locally (`toolfactory package`) and in
 * the release workflow's `package` job, which uploads the directory as one artifact. Publishing
 * to a registry stays a CI concern; producing the artifacts never is.
 */
export function packageSteps(project: Project): GateStep[] {
  const cli = toolfactoryCli(project);
  const name = project.identity.name;
  const steps: GateStep[] = [
    { name: "release directory", run: `rm -rf ${RELEASE_DIR} && mkdir -p ${RELEASE_DIR}` },
    ...bootstrapSteps(project),
    outputsStep(project),
  ];
  if (has(project, "npm")) {
    steps.push({ name: "npm tarball", run: `npm pack --pack-destination ${RELEASE_DIR}` });
  }
  if (has(project, "mcpb")) {
    // A bundle root is the published package with its production dependencies installed into
    // it, so it is built from the tarball `npm pack` just wrote rather than from the checkout:
    // whatever ships to npm is exactly what ships to Claude Desktop. `--ignore-scripts` because
    // nothing in a bundle root may run a build; the tarball already carries `dist/`.
    const stage = "dist/mcpb";
    const tarball = `${npmName(project).replace(/^@/, "").replace("/", "-")}-${project.identity.version ?? "0.0.0"}.tgz`;
    steps.push({
      name: "MCPB bundle",
      run: [
        `rm -rf ${stage} && mkdir -p ${stage}`,
        `tar -xzf ${RELEASE_DIR}/${tarball} -C ${stage} --strip-components=1`,
        `npm --prefix ${stage} install --omit=dev --ignore-scripts`,
        `cp ${MCPB_MANIFEST_PATH} ${stage}/manifest.json`,
        `npx -y @anthropic-ai/mcpb@${MCPB_PIN} pack ${stage} ${RELEASE_DIR}/${name}.mcpb`,
      ].join(" && "),
    });
  }
  if (has(project, "pypi")) {
    steps.push({ name: "python distributions", run: `uv build --out-dir ${RELEASE_DIR}` });
  }
  if (has(project, "openclaw-native")) {
    // ClawHub's reusable workflow has no build step of its own, so the tarball it publishes has
    // to arrive already built (`package_artifact_name`).
    steps.push({
      name: "OpenClaw plugin tarball",
      run: [
        `npm --prefix ${OPENCLAW_HOST_DIR} install`,
        `npm --prefix ${OPENCLAW_HOST_DIR} run build`,
        `npm pack ./${OPENCLAW_HOST_DIR} --pack-destination ${RELEASE_DIR}`,
      ].join(" && "),
    });
  }
  if (has(project, "dsh")) {
    // Two files and no code: nothing to build, and `dsh plugin add` takes a tarball directly.
    steps.push({
      name: "DSH bundle tarball",
      run: `npm pack ./${DSH_HOST_DIR} --pack-destination ${RELEASE_DIR}`,
    });
  }
  const bundle = bundlePaths(project);
  if (bundle.length) {
    steps.push({
      name: "plugin bundle",
      run: `zip -qr ${RELEASE_DIR}/${name}-plugin.zip ${bundle.join(" ")}`,
    });
  }
  if (has(project, "web")) {
    steps.push({
      name: "web build",
      // Root-relative: the tarball is a site anyone can serve from a domain root. The Pages job
      // runs the same build with its own PAGES_BASE.
      env: { PAGES_BASE: "/" },
      run: `${WEB_BUILD} && tar -czf ${RELEASE_DIR}/${name}-web.tar.gz -C web/dist .`,
    });
  }
  // COVERAGE.md is tracked; coverage.json is a build output that need not be, so recompute it.
  steps.push({
    name: "coverage report",
    run: `cp COVERAGE.md ${RELEASE_DIR}/ && ${cli} coverage > ${RELEASE_DIR}/coverage.json`,
  });
  return steps;
}

/** The ClawHub tarball `npm pack ./hosts/openclaw` writes, by name, inside the release artifact. */
export function openclawTarball(project: Project): string {
  const pkg = projectName.openclawPackage(project.identity.name);
  return `${pkg}-${project.identity.version ?? "0.0.0"}.tgz`;
}
