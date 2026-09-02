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
import { githubSlug } from "../hosts/github.js";
import { githubOwner, projectName } from "../identity/name.js";
import type { PackageManager, Project, SurfaceId } from "../model.js";
import {
  HOST_DIR as BROWSER_HOST_DIR,
  sourcesZipName,
  zipName,
} from "../surfaces/browser-extension.js";
import { HOST_DIR as DSH_HOST_DIR } from "../surfaces/dsh.js";
import { MANIFEST_PATH as MCPB_MANIFEST_PATH, MCPB_PIN } from "../surfaces/mcpb.js";
import { HOST_DIR as OPENCLAW_HOST_DIR } from "../surfaces/openclaw-native.js";
import {
  configProperties,
  envName,
  has,
  isSensitive,
  npmName,
  pypiName,
} from "../surfaces/shared.js";

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
  if (has(project, "web") || has(project, "browser-extension")) {
    // The web smoke and the browser extension's own Playwright smoke both drive Chromium;
    // their own npm installs fetch the browser, the runner needs its system libraries.
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
    // `RELEASE_TAG`, not `GITHUB_REF_NAME`: `release.yml` also runs on `workflow_dispatch` with a
    // `tag` input — the only re-run that reads current secrets — and then the ref is a branch.
    name: `tag matches ${identity}`,
    run: `test "v$(${read})" = "$RELEASE_TAG"`,
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
  if (has(project, "browser-extension")) {
    // `wxt zip` writes into hosts/browser/.output/ under exactly the names `zipName`/
    // `sourcesZipName` predict (verified live), so no rename is needed, only a copy.
    const zipTargets: Array<"chrome" | "firefox" | "edge"> = ["chrome", "firefox", "edge"];
    const outDir = `${BROWSER_HOST_DIR}/.output`;
    steps.push({
      name: "browser extension zips",
      run: [
        `npm --prefix ${BROWSER_HOST_DIR} install`,
        // `npm exec` never changes the working directory (unlike `npm run`), so `wxt` needs its
        // root passed explicitly — verified live: without it, `wxt zip` looks for `./entrypoints`
        // relative to the repo root instead of hosts/browser.
        ...zipTargets.map(
          (browser) =>
            `npm --prefix ${BROWSER_HOST_DIR} exec --no -- wxt zip ${BROWSER_HOST_DIR} -b ${browser}`,
        ),
        ...zipTargets.map((browser) => `cp ${outDir}/${zipName(project, browser)} ${RELEASE_DIR}/`),
        `cp ${outDir}/${sourcesZipName(project)} ${RELEASE_DIR}/`,
      ].join(" && "),
    });
    steps.push({
      // Self-hosted Firefox distribution (§7): a Mozilla-signed, install-anywhere xpi. Opt-in on
      // the JWT pair alone — no store listing is created (`--channel=unlisted`) — so a project
      // with the surface selected but no Firefox credentials configured yet still packages clean.
      name: "Firefox signed xpi (only when FIREFOX_JWT_ISSUER/FIREFOX_JWT_SECRET are set)",
      run: `if [ -n "$FIREFOX_JWT_ISSUER" ] && [ -n "$FIREFOX_JWT_SECRET" ]; then npm --prefix ${BROWSER_HOST_DIR} exec --no -- web-ext sign --channel=unlisted --api-key="$FIREFOX_JWT_ISSUER" --api-secret="$FIREFOX_JWT_SECRET" --source-dir ${outDir}/firefox-mv2 --artifacts-dir ${RELEASE_DIR}; fi`,
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

/**
 * One row per (surface, registry): what publishing needs, what proves it, how to retract.
 * DESIGN.md §1 (research3). `secrets status`/`check`, the release legs' presence gating and the
 * unpublish step all read this table and nothing else.
 */
export interface Registry {
  /** Stable id: the release job suffix, the `secrets status` row, the unpublish step name. */
  id:
    | "npm"
    | "pypi"
    | "mcp-registry"
    | "oci"
    | "clawhub-package"
    | "clawhub-skill"
    | "pages"
    | "chrome"
    | "firefox"
    | "edge"
    | "safari";
  /** The surfaces whose selection publishes here; all must be selected. */
  surfaces: SurfaceId[];
  /** Environment names the publish leg consumes (repository scope); [] for OIDC/GITHUB_TOKEN legs. */
  secrets: string[];
  /** Environment names retraction consumes when they differ from `secrets`. */
  retractSecrets?: string[];
  /** Where a human mints the credential or does the one-time web step. */
  url: string;
  /** Where a human retracts by hand, when that differs from `url`; the notices point at it. */
  retractUrl?: string;
  /** Shell: exit 0 iff the credential in the environment is accepted (`secrets check`). Absent = no probe exists. */
  probe?: string;
  /** Shell: exit 0 iff the current version is published (anonymous; idempotency for publish and unpublish). */
  exists?: string;
  /**
   * Shell: exit 0 iff this leg can publish at this tag — the release `gate` job's
   * `outputs.<id>`, which every leg's job-level `if` reads. Absent = the leg is never gated.
   */
  gate?: string;
  /** Shell: the retraction, one upstream CLI; absent = manual. */
  retract?: string;
  /** With `--hard`: the destructive form. */
  retractHard?: string;
  /** A one-time human step with no API, gated by a repository variable the human sets when done. */
  confirmVariable?: string;
}

/** ClawHub's CLI, pinned: no runner carries `clawhub` on PATH and every ClawHub row shells to it. */
export const CLAWHUB_PIN = "0.23.3";

/** The `mcp-publisher` binary: the publish leg and the MCP Registry retraction fetch the same one. */
export const MCP_PUBLISHER_FETCH =
  'curl -sL "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_linux_amd64.tar.gz" | tar xz mcp-publisher';

const CLAWHUB = `npx -y clawhub@${CLAWHUB_PIN}`;

/**
 * `clawhub` reads its token from `~/.config/clawhub/config.json`, never from the environment
 * (verified: `CLAWHUB_TOKEN` in the environment still yields "Not logged in"). A throwaway HOME
 * makes `login --token` — which validates the token itself, exit 1 on a revoked one — safe to run
 * on a developer's machine without replacing the login they already have.
 */
function clawhubAuthed(command: string): string {
  return `d=$(mktemp -d) && HOME="$d" ${CLAWHUB} login --token "$CLAWHUB_TOKEN" --no-input >/dev/null && HOME="$d" ${CLAWHUB} ${command}`;
}

/**
 * ClawHub's anonymous rate limit presents as a not-found carrying "(reset in Ns)", so a plain
 * failure cannot be read as "absent" — retry once past the window before believing it.
 */
function clawhubExists(command: string): string {
  return `${CLAWHUB} ${command} >/dev/null 2>&1 || { ${CLAWHUB} ${command} 2>&1 | grep -q "reset in" && sleep 60 && ${CLAWHUB} ${command} >/dev/null 2>&1; }`;
}

/** npm names its registry credential as a config key, not a variable, so `env` is the only prefix that can set it. */
function npmAuthed(command: string): string {
  return `env "npm_config_//registry.npmjs.org/:_authToken=$NPM_TOKEN" ${command}`;
}

/** Every secret name of a set must be non-empty for its leg to run. */
function allSet(names: string[]): string {
  return names.map((name) => `[ -n "$${name}" ]`).join(" && ");
}

/**
 * Exit 0 iff the package name is already on the npm registry. Two consumers, one command: the npm
 * row's `gate` (a name that exists can have a trusted publisher; a new one can only be published
 * with a token) and the publish leg, which asks again at publish time to pick OIDC or the token.
 */
export function npmPackageExists(project: Project): string {
  return `npm view ${npmName(project)} version >/dev/null 2>&1`;
}

const CHROME_SECRETS = [
  "CHROME_EXTENSION_ID",
  "CHROME_PUBLISHER_ID",
  "CHROME_SERVICE_ACCOUNT_CLIENT_EMAIL",
  "CHROME_SERVICE_ACCOUNT_PRIVATE_KEY",
];
const FIREFOX_SECRETS = ["FIREFOX_EXTENSION_ID", "FIREFOX_JWT_ISSUER", "FIREFOX_JWT_SECRET"];
const EDGE_SECRETS = ["EDGE_PRODUCT_ID", "EDGE_CLIENT_ID", "EDGE_API_KEY"];
const ASC_SECRETS = ["ASC_KEY_ID", "ASC_ISSUER_ID", "ASC_PRIVATE_KEY"];

/**
 * Every name any row can consume, selected or not: the release's retraction step runs against
 * the previous tag's selection, so its environment carries them all (an unset one is empty).
 */
export const RELEASE_SECRET_NAMES = [
  "NPM_TOKEN",
  "CLAWHUB_TOKEN",
  ...CHROME_SECRETS,
  ...FIREFOX_SECRETS,
  ...EDGE_SECRETS,
  ...ASC_SECRETS,
];

/**
 * Every registry row whose surfaces are all selected, with the exact upstream command for each
 * column. Four consumers read this and nothing else: `secrets status`, `secrets check`, the
 * release legs' presence gating, and the unpublish step.
 */
export function registries(project: Project): Registry[] {
  const name = project.identity.name;
  const version = project.identity.version ?? "0.0.0";
  const pkg = npmName(project);
  const pypi = pypiName(project);
  const owner = githubOwner(project.identity.repository)?.toLowerCase();
  const slug = githubSlug(project.identity.repository);
  const server = owner ? `io.github.${owner}/${name}` : undefined;
  const registry = "https://registry.modelcontextprotocol.io";
  // The retraction's own message, on every registry that carries one: why the artifact stopped.
  const why = `${name} no longer publishes here: the surface was deselected.`;
  const browserZip = (browser: "chrome" | "firefox" | "edge") =>
    `${BROWSER_HOST_DIR}/.output/${zipName(project, browser)}`;
  const wxtSubmit = `npm --prefix ${BROWSER_HOST_DIR} exec --no -- wxt submit --dry-run`;

  const rows: Registry[] = [
    {
      id: "npm",
      surfaces: ["npm"],
      secrets: ["NPM_TOKEN"],
      url: "https://www.npmjs.com/settings/~/tokens",
      probe: npmAuthed("npm whoami"),
      exists: `npm view ${pkg}@${version} version >/dev/null 2>&1`,
      // The package existing means trusted publishing can have been configured for it (`npm trust`
      // refuses a name that is not on the registry yet); before that only a token can publish.
      gate: `${npmPackageExists(project)} || [ -n "$NPM_TOKEN" ]`,
      // Reversible (an empty message undeprecates) and it never breaks an install, which
      // `npm unpublish` does; the destructive form is behind `--hard`.
      retract: npmAuthed(`npm deprecate ${pkg}@'*' "${why}"`),
      retractHard: npmAuthed(`npm unpublish ${pkg} --force`),
    },
    {
      id: "pypi",
      surfaces: ["pypi"],
      secrets: [],
      url: "https://pypi.org/manage/account/publishing/",
      exists: `curl -fsS -o /dev/null https://pypi.org/pypi/${pypi}/${version}/json`,
      // A project that has published once proves its trusted publisher converted; before that the
      // pending publisher is a web-only step, so a human confirms it with the variable.
      gate: `curl -fsS -o /dev/null https://pypi.org/pypi/${pypi}/json || [ -n "$PYPI_TRUSTED_PUBLISHER" ]`,
      // Yanking and deleting are dashboard actions: PyPI's only write API is Upload.
      retractUrl: `https://pypi.org/manage/project/${pypi}/releases/`,
      confirmVariable: "PYPI_TRUSTED_PUBLISHER",
    },
    {
      id: "oci",
      surfaces: ["mcp-registry"],
      secrets: [],
      // Publishing rides GITHUB_TOKEN's `packages: write`; deleting needs `delete:packages`,
      // which that token does not carry, so retraction reads a PAT from the environment.
      retractSecrets: ["GH_TOKEN"],
      url: "https://github.com/settings/packages",
      exists: owner
        ? `token=$(curl -fsS "https://ghcr.io/token?scope=repository:${owner}/${name}:pull&service=ghcr.io" | sed -n 's/.*"token":"\\([^"]*\\)".*/\\1/p') && curl -fsS -o /dev/null -H "Authorization: Bearer $token" -H "Accept: application/vnd.oci.image.index.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.v2+json" "https://ghcr.io/v2/${owner}/${name}/manifests/${version}"`
        : undefined,
      // GITHUB_TOKEN is always there, so the leg always runs; what it cannot do is make the image
      // public, and GitHub has no API for that at all (verified: the Packages REST surface is
      // GET/DELETE/restore only), so the gate says so once per release instead of failing.
      gate: `echo "::notice::ghcr.io publishes a private image on the first push whatever the repository's visibility; make it public once at https://github.com/${owner ?? "<owner>"}?tab=packages -> Package settings -> Danger Zone."`,
      retract: owner
        ? `gh api --method DELETE /user/packages/container/${name} || gh api --method DELETE /orgs/${owner}/packages/container/${name} || echo "::notice::ghcr: delete the container package by hand at https://github.com/${owner}?tab=packages (a public package past 5,000 downloads needs GitHub support)."`
        : undefined,
    },
    {
      id: "mcp-registry",
      surfaces: ["mcp-registry"],
      secrets: [],
      url: registry,
      exists: server
        ? `curl -fsS -o /dev/null "${registry}/v0/servers/${encodeURIComponent(server)}/versions/${version}"`
        : undefined,
      // mcp-publisher validates that every `packages[]` entry already exists in its own registry,
      // so this leg can only run when each package leg is going to.
      retract: server
        ? `${MCP_PUBLISHER_FETCH} && ./mcp-publisher login github-oidc && ./mcp-publisher status --status deleted --all-versions --message "${why}" ${server}`
        : undefined,
    },
    {
      id: "clawhub-package",
      surfaces: ["clawhub", "openclaw-native"],
      secrets: ["CLAWHUB_TOKEN"],
      url: "https://clawhub.ai",
      probe: clawhubAuthed("whoami"),
      exists: clawhubExists(
        `package inspect ${projectName.openclawPackage(name)} --version ${version} --json`,
      ),
      gate: allSet(["CLAWHUB_TOKEN"]),
      // Soft: `package undelete` restores it, and the version number stays reserved either way.
      retract: clawhubAuthed(`package delete ${projectName.openclawPackage(name)} --yes --json`),
    },
    {
      id: "clawhub-skill",
      surfaces: ["clawhub", "skill"],
      secrets: ["CLAWHUB_TOKEN"],
      url: "https://clawhub.ai",
      probe: clawhubAuthed("whoami"),
      exists: clawhubExists(`inspect ${name} --version ${version} --json`),
      gate: allSet(["CLAWHUB_TOKEN"]),
      retract: clawhubAuthed(`delete ${name} --yes --reason "${why}"`),
    },
    {
      id: "pages",
      surfaces: ["web"],
      secrets: [],
      retractSecrets: ["GH_TOKEN"],
      url: slug ? `https://github.com/${slug}/settings/pages` : "https://docs.github.com/en/pages",
      // Pages must be enabled with Source = GitHub Actions before `configure-pages` can run; a
      // workflow token can read that (`pages: read`) but never set it — `bootstrap-repo` does.
      gate: slug ? `gh api repos/${slug}/pages >/dev/null 2>&1` : undefined,
      exists: slug
        ? `curl -fsS -o /dev/null https://${slug.replace("/", ".github.io/")}/`
        : undefined,
      // Doc-cited only: the docs require repository-admin or the Pages-settings permission and do
      // not say whether a workflow token satisfies it, so a failure is a notice, not a red run.
      retract: slug
        ? `gh api --method DELETE repos/${slug}/pages || echo "::notice::pages: disable the site by hand at https://github.com/${slug}/settings/pages"`
        : undefined,
    },
    {
      id: "chrome",
      surfaces: ["browser-extension"],
      secrets: CHROME_SECRETS,
      url: "https://chrome.google.com/webstore/devconsole",
      // Web Store API v2's `fetchStatus` is the only read method and the only one `chromewebstore
      // .readonly` reaches; `wxt submit --dry-run` calls it before it bails, so this is a real
      // credential check (it is not on the v1.1 path, which bails first — hence the pinned v2).
      probe: `CHROME_API_VERSION=v2 ${wxtSubmit} --chrome-zip ${browserZip("chrome")}`,
      gate: allSet(CHROME_SECRETS),
      // Google removed listing visibility from the API deliberately; it is dashboard-only.
    },
    {
      id: "firefox",
      surfaces: ["browser-extension"],
      secrets: FIREFOX_SECRETS,
      url: "https://addons.mozilla.org/developers/addon/api/key/",
      // `GET /api/v5/addons/addon/{id}` under the JWT, before the dry run bails.
      probe: `${wxtSubmit} --firefox-zip ${browserZip("firefox")} --firefox-sources-zip ${BROWSER_HOST_DIR}/.output/${sourcesZipName(project)}`,
      exists: `curl -fsS -o /dev/null "https://addons.mozilla.org/api/v5/addons/addon/$FIREFOX_EXTENSION_ID/"`,
      gate: allSet(FIREFOX_SECRETS),
      // AMO's PATCH/DELETE exist but only over hand-rolled JWT HTTP, which C1 forbids.
      retractUrl: "https://addons.mozilla.org/developers/addons",
    },
    {
      id: "edge",
      surfaces: ["browser-extension"],
      secrets: EDGE_SECRETS,
      url: "https://partner.microsoft.com/dashboard/microsoftedge/publishapi",
      // No probe: the Edge API's only GETs need an operationId from a prior mutating call, and
      // `wxt submit --dry-run` makes no network call at all for Edge (verified in its bundle).
      gate: allSet(EDGE_SECRETS),
      retractUrl: "https://partner.microsoft.com/dashboard/microsoftedge/overview",
    },
    {
      id: "safari",
      surfaces: ["browser-extension"],
      secrets: ASC_SECRETS,
      url: "https://appstoreconnect.apple.com/access/integrations/api",
      // No probe here: the whole leg is macOS-only, and the ASC read needs an ES256-signed JWT,
      // which is a hand-rolled HTTP client (C1).
      gate: allSet(ASC_SECRETS),
      retractUrl: "https://appstoreconnect.apple.com/apps",
    },
  ];

  const selected = rows.filter(
    (row) =>
      row.surfaces.every((surface) => has(project, surface)) &&
      (row.id !== "safari" || project.tool.browserExtension?.safari === true),
  );
  const mcpRegistry = selected.find((row) => row.id === "mcp-registry");
  if (mcpRegistry) {
    const packages = selected.filter(
      (row) => row.id === "npm" || row.id === "pypi" || row.id === "oci",
    );
    mcpRegistry.gate = packages.length
      ? packages.map((row) => `[ "$${gateVariable(row)}" = true ]`).join(" && ")
      : "true";
  }
  return selected;
}

/** The shell variable the release gate holds a row's presence in; the job output takes the same name. */
export function gateVariable(row: Registry): string {
  return row.id.replace(/-/g, "_");
}

/** Every environment name a secret can be set under: sensitive config keys, then the release registries' tokens. */
export function secretsOf(project: Project): string[] {
  const config = Object.entries(configProperties(project))
    .filter(([, property]) => isSensitive(property))
    .map(([key]) => envName(key));
  const release = registries(project).flatMap((row) => row.secrets);
  return [...new Set([...config, ...release])];
}

/**
 * The one-time human steps the table cannot automate — no API at all, or one no token in CI can
 * reach. `secrets status` and `bootstrap-repo` print the same list.
 */
export function manualSteps(project: Project): string[] {
  const rows = registries(project);
  const has_ = (id: Registry["id"]) => rows.some((row) => row.id === id);
  const slug = githubSlug(project.identity.repository);
  const steps: string[] = [];
  if (has_("oci")) {
    steps.push(
      `ghcr.io: the first push publishes a private image whatever the repository's visibility, and GitHub has no visibility API — flip it once at ${rows.find((row) => row.id === "oci")?.url}.`,
    );
  }
  if (has_("pypi")) {
    steps.push(
      `PyPI: register a pending trusted publisher (repository, \`release.yml\`, environment \`pypi\`) at https://pypi.org/manage/account/publishing/, then \`gh variable set PYPI_TRUSTED_PUBLISHER -b true${slug ? ` -R ${slug}` : ""}\`.`,
    );
  }
  for (const id of ["chrome", "firefox", "edge", "safari"] as const) {
    const row = rows.find((entry) => entry.id === id);
    if (!row) continue;
    steps.push(
      `${id}: the listing itself — creating it, and unlisting it again — is a dashboard action with no API: ${row.retractUrl ?? row.url}.`,
    );
  }
  steps.push(
    "Curated directories are listed with their URLs in AGENTS.md's Listing section: each is a one-time human-reviewed submission, and removing one is a reverting pull request.",
  );
  return steps;
}

/**
 * The retraction of every registry a dropped surface used to publish to, one step per row:
 * `exists` → the secret guard → `retract`, so re-running the same tag is a no-op and a registry
 * with no machine retraction prints the exact page instead of failing the release.
 *
 * `previous` is the project as the previous tag left it — its surfaces and its version — so the
 * existence probes ask about what that tag actually published, not about the tag being cut now.
 */
export function unpublishSteps(
  previous: Project,
  dropped: readonly SurfaceId[],
  hard = false,
): GateStep[] {
  const version = previous.identity.version ?? "0.0.0";
  return registries(previous)
    .filter((row) => row.surfaces.some((surface) => dropped.includes(surface)))
    .map((row) => {
      const retract = (hard ? row.retractHard : undefined) ?? row.retract;
      const where = row.retractUrl ?? row.url;
      const guard = row.retractSecrets ?? row.secrets;
      const body = !retract
        ? `echo "::notice::${row.id}: retract this listing by hand at ${where}"`
        : guard.length
          ? `if ${allSet(guard)}; then ${retract}; else echo "::notice::${row.id}: set ${guard.join(", ")} to retract automatically, or do it by hand at ${where}"; fi`
          : retract;
      return {
        name: `unpublish ${row.id}`,
        run: row.exists
          ? `if ${row.exists}; then ${body}; else echo "${row.id}: nothing published at ${version}"; fi`
          : body,
      };
    });
}

/** The one line CI runs, exactly as `toolfactory validate` is one gate step: the whole diff-and-retract. */
export function unpublishStep(project: Project): GateStep {
  return { name: "unpublish dropped registries", run: `${toolfactoryCli(project)} unpublish` };
}
