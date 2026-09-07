/**
 * Everything toolfactory does to a GitHub repository: creating and pushing it (`init --repo`),
 * and preparing the T4 live tier — an environment with required reviewers and the secrets inside
 * it, the two things GitHub only exposes over its API. All of it through the official `gh` CLI
 * (§8 C1: own no client), never a hand-rolled HTTP call, and all of it optional: a project with
 * no GitHub at all never reaches this file.
 *
 * Secret values are read from the local `.env`, piped to `gh` on stdin, and never written to a
 * command line, a log line, or the returned result.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import type { Project, SurfaceId } from "../model.js";
import { envName, has, liveCredentials, npmName } from "../surfaces/shared.js";

/** The GitHub environment the generated `live` job deploys to. */
export const LIVE_ENVIRONMENT = "live-tests";

export interface BootstrapOptions {
  /** `owner/repo` to prepare; the default is the identity file's repository URL. */
  repository?: string;
  /** GitHub logins that must approve a live run. Empty leaves the environment ungated. */
  reviewers?: string[];
  /** Where the secret values come from; defaults to `<root>/.env`. */
  envFile?: string;
  /**
   * Names the release registries consume, at repository scope — `registries(project)`'s union,
   * passed in so this file stays a `gh` driver and the table stays in `project/gate.ts`.
   */
  releaseSecrets?: string[];
  /** The one-time human steps to print at the end; `manualSteps(project)`'s list. */
  manual?: string[];
  /** Print the `gh` invocations instead of running them. */
  dryRun?: boolean;
}

export interface BootstrapResult {
  /** `owner/repo`, from the identity file's repository URL. */
  repository: string;
  environment: string;
  reviewers: string[];
  /** Names of the secrets written, in `gh` order. Never their values. */
  secrets: string[];
  /** Declared names with no value in `.env`: reported, never fatal — the rest of the run still lands. */
  missing: string[];
  /** Every `gh` invocation, in order, as it is (or would be) run. */
  commands: string[];
  /** The one-time human steps no API can do, each with its URL. */
  manual: string[];
  dryRun: boolean;
}

/** `owner/repo` from a GitHub URL or `git@` remote. */
export function githubSlug(repository: string | undefined): string | undefined {
  const match = repository?.match(/github\.com[/:]([^/]+)\/([^/#?]+?)(?:\.git)?(?:[/#?]|$)/);
  return match ? `${match[1]}/${match[2]}` : undefined;
}

function gh(args: string[], stdin?: string, cwd?: string): string {
  return execFileSync("gh", args, {
    cwd,
    encoding: "utf8",
    input: stdin,
    stdio: ["pipe", "pipe", "inherit"],
  }).trim();
}

/** npm trust's direct-publish permission flags landed in npm 11.15.0. */
function supportsNpmTrust(): { ok: boolean; version: string } {
  const result = spawnSync("npm", ["--version"], { encoding: "utf8", timeout: 10_000 });
  const version = result.status === 0 ? result.stdout.trim() : "unavailable";
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return { ok: major > 11 || (major === 11 && minor >= 15), version };
}

export function bootstrapRepo(project: Project, options: BootstrapOptions = {}): BootstrapResult {
  const repository = options.repository ?? githubSlug(project.identity.repository);
  if (!repository) {
    throw new Error(
      "bootstrap-repo needs a GitHub repository URL in the identity file to know which repo to prepare.",
    );
  }
  const { reviewers = [], dryRun = false, releaseSecrets = [] } = options;
  // npm setup below reports its actual result, replacing the generic status instructions.
  const manual = (options.manual ?? []).filter((step) => !step.startsWith("npm:"));
  const envFile = options.envFile ?? join(project.root, ".env");
  const values = existsSync(envFile) ? parseEnv(readFileSync(envFile, "utf8")) : {};
  const keys = liveCredentials(project);
  const commands: string[] = [];
  const written: string[] = [];
  const missing: string[] = [];

  // The live tier's own environment, and only when the project has a live tier: a `tool.json`
  // config key that is both required and sensitive is the whole trigger (§6 T4).
  if (keys.length) {
    const ids = reviewers.map((login) => {
      const args = ["api", `users/${login}`, "--jq", ".id"];
      commands.push(`gh ${args.join(" ")}`);
      return dryRun ? `<id of ${login}>` : gh(args);
    });
    const body = JSON.stringify(
      reviewers.length
        ? { reviewers: ids.map((id) => ({ type: "User", id: Number(id) || id })) }
        : {},
    );
    const environmentArgs = [
      "api",
      "--method",
      "PUT",
      `repos/${repository}/environments/${LIVE_ENVIRONMENT}`,
      "--input",
      "-",
    ];
    commands.push(`gh ${environmentArgs.join(" ")} <<< '${body}'`);
    if (!dryRun) gh(environmentArgs, body);
  }

  // Two scopes, one loop: a config key is the live job's, a registry token is the release's, and
  // one `gh secret set -f .env` could not tell them apart. The value goes in on stdin either way,
  // so it never reaches argv (`ps`), a log line, or this result.
  const scoped: [string, string[]][] = [
    ...keys.map((key): [string, string[]] => [envName(key), ["--env", LIVE_ENVIRONMENT]]),
    ...[...new Set(releaseSecrets)].map((name): [string, string[]] => [name, []]),
  ];
  for (const [name, scope] of scoped) {
    if (!dryRun && !values[name]) {
      missing.push(name);
      continue;
    }
    const args = ["secret", "set", name, ...scope, "--repo", repository];
    commands.push(`gh ${args.join(" ")}  # value from ${envFile}, on stdin`);
    if (!dryRun) gh(args, values[name]);
    written.push(name);
  }

  // Pages: a workflow's own token cannot enable it (`GITHUB_TOKEN` has no `administration` key at
  // all), but a local `gh` session is a repository admin, which is exactly the bar. Idempotent:
  // 404 from the read means "not enabled yet", anything else means it already is.
  if (has(project, "web")) {
    const read = ["api", `repos/${repository}/pages`];
    const create = [
      "api",
      "--method",
      "POST",
      `repos/${repository}/pages`,
      "-f",
      "build_type=workflow",
    ];
    commands.push(`gh ${read.join(" ")} || gh ${create.join(" ")}`);
    if (!dryRun && !try_(() => gh(read))) try_(() => gh(create));
  }

  // npm trusted publishing, so the release can use OIDC — but only once the package exists.
  // npm trust requires an interactive, logged-in 2FA session; granular bypass-2FA tokens are
  // explicitly unsupported, so never smuggle NPM_TOKEN into this command.
  if (releaseSecrets.includes("NPM_TOKEN")) {
    const pkg = npmName(project);
    const trustArgs = [
      "trust",
      "github",
      pkg,
      "--file",
      "release.yml",
      "--repo",
      repository,
      "--allow-publish",
      "-y",
    ];
    const trust = `npm ${trustArgs.join(" ")}`;
    const confirmArgs = [
      "variable",
      "set",
      "NPM_TRUSTED_PUBLISHER",
      "-b",
      "true",
      "--repo",
      repository,
    ];
    const confirm = `gh ${confirmArgs.join(" ")}`;
    const manualTrust = `npm: \`${trust}\` requires npm@11.15+, a package that already exists, and a logged-in 2FA session; granular access tokens with bypass 2FA are unsupported. Run it from that session, then \`${confirm}\`. Until it succeeds, NPM_TOKEN is the release fallback.`;
    const published =
      !dryRun &&
      spawnSync("npm", ["view", pkg, "version"], { stdio: "ignore", timeout: 60_000 }).status === 0;
    if (!published) {
      manual.push(
        `npm: the first publish uses NPM_TOKEN because \`npm trust\` requires the package to exist. Afterwards ${manualTrust.slice("npm: ".length)}`,
      );
    } else {
      const npm = supportsNpmTrust();
      if (!npm.ok) {
        manual.push(
          `npm: did not run \`${trust}\` because npm ${npm.version} lacks npm@11.15+'s --allow-publish permission. Install npm@^11.15 in the logged-in 2FA session, then ${manualTrust.slice("npm: ".length)}`,
        );
      } else if (!process.stdin.isTTY || !process.stdout.isTTY) {
        manual.push(
          `npm: run bootstrap-repo from an interactive terminal for npm's 2FA challenge. ${manualTrust.slice("npm: ".length)}`,
        );
      } else {
        commands.push(trust);
        const result = spawnSync("npm", trustArgs, { stdio: "inherit", timeout: 120_000 });
        if (result.status !== 0) {
          manual.push(
            `npm: \`${trust}\` exited ${result.status}. ${manualTrust.slice("npm: ".length)}`,
          );
        } else {
          commands.push(confirm);
          try {
            gh(confirmArgs);
          } catch {
            manual.push(
              `npm: trusted publishing was configured, but \`${confirm}\` did not succeed. Run it before relying on OIDC; NPM_TOKEN remains the release fallback until then.`,
            );
          }
        }
      }
    }
  }

  return {
    repository,
    environment: LIVE_ENVIRONMENT,
    reviewers,
    secrets: written,
    missing,
    commands,
    manual,
    dryRun,
  };
}

/** `gh` exits non-zero for "not found" as readily as for a real failure; both mean "keep going". */
function try_(call: () => string): boolean {
  try {
    call();
    return true;
  } catch {
    return false;
  }
}

/**
 * One GitHub topic per selected surface, so a repository `init` creates is discoverable as what
 * it actually ships. Surfaces that only package the same tool (`cli`, `npm`, `pypi`, `web`,
 * `clawhub`, `workflows`) name no ecosystem and get none.
 */
export const SURFACE_TOPICS: Partial<Record<SurfaceId, string>> = {
  skill: "agent-skill",
  "agent-plugins": "agent-plugins",
  claude: "claude-plugin",
  codex: "codex-plugin",
  cursor: "cursor-plugin",
  mcp: "mcp-server",
  "mcp-registry": "mcp-registry",
  "openclaw-native": "openclaw-plugin",
  "hermes-native": "hermes-plugin",
  dsh: "dsh-plugin",
};

export interface CreateRepoOptions {
  /** `owner/name` of the repository to create. */
  slug: string;
  /** Public instead of the private default. */
  public?: boolean;
  /** Print the `gh` invocations instead of running them. */
  dryRun?: boolean;
}

export interface CreateRepoResult {
  repository: string;
  visibility: "private" | "public";
  topics: string[];
  /** Every `gh` invocation, in order, as it is (or would be) run. */
  commands: string[];
  dryRun: boolean;
}

/** `gh <args>`, copy-pasteable: only arguments that need quoting get it. */
function render(args: string[]): string {
  return `gh ${args.map((arg) => (/[\s"'$]/.test(arg) ? JSON.stringify(arg) : arg)).join(" ")}`;
}

/**
 * Create the repository from the checkout and push it: `gh repo create --source --remote --push`,
 * private unless asked otherwise, then one `gh repo edit --add-topic` for the selected surfaces.
 * `gh` is the only GitHub client (§8 C1); nothing here talks to the API directly.
 */
export function createRepo(project: Project, options: CreateRepoOptions): CreateRepoResult {
  const { slug, dryRun = false } = options;
  if (!/^[^/\s]+\/[^/\s]+$/.test(slug)) {
    throw new Error(`repo takes owner/name, not ${JSON.stringify(slug)}.`);
  }
  const visibility = options.public ? "public" : "private";
  const topics = [
    ...new Set(
      project.tool.surfaces
        .flatMap((surface) => SURFACE_TOPICS[surface] ?? [])
        .concat("toolfactory"),
    ),
  ];
  const commands: string[] = [];
  const create = [
    "repo",
    "create",
    slug,
    `--${visibility}`,
    ...(project.identity.description ? ["--description", project.identity.description] : []),
    "--source",
    ".",
    "--remote",
    "origin",
    "--push",
  ];
  const edit = ["repo", "edit", slug, "--add-topic", topics.join(",")];
  for (const args of [create, edit]) {
    commands.push(render(args));
    if (!dryRun) gh(args, undefined, project.root);
  }
  return { repository: slug, visibility, topics, commands, dryRun };
}
