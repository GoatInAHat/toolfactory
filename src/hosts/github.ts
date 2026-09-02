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
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import type { Project, SurfaceId } from "../model.js";
import { envName, liveCredentials } from "../surfaces/shared.js";

/** The GitHub environment the generated `live` job deploys to. */
export const LIVE_ENVIRONMENT = "live-tests";

export interface BootstrapOptions {
  /** `owner/repo` to prepare; the default is the identity file's repository URL. */
  repository?: string;
  /** GitHub logins that must approve a live run. Empty leaves the environment ungated. */
  reviewers?: string[];
  /** Where the secret values come from; defaults to `<root>/.env`. */
  envFile?: string;
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
  /** Every `gh` invocation, in order, as it is (or would be) run. */
  commands: string[];
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

export function bootstrapRepo(project: Project, options: BootstrapOptions = {}): BootstrapResult {
  const repository = options.repository ?? githubSlug(project.identity.repository);
  if (!repository) {
    throw new Error(
      "bootstrap-repo needs a GitHub repository URL in the identity file to know which repo to prepare.",
    );
  }
  const keys = liveCredentials(project);
  if (keys.length === 0) {
    throw new Error(
      "bootstrap-repo has nothing to do: no dev.toolfactory/tool.json config key is both required and sensitive.",
    );
  }
  const { reviewers = [], dryRun = false } = options;
  const envFile = options.envFile ?? join(project.root, ".env");
  const values = dryRun ? {} : parseEnv(readFileSync(envFile, "utf8"));
  const missing = dryRun ? [] : keys.filter((key) => !values[envName(key)]);
  if (missing.length) {
    throw new Error(`${envFile} has no value for ${missing.map(envName).join(", ")}.`);
  }

  const commands: string[] = [];
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

  for (const key of keys) {
    const name = envName(key);
    const args = ["secret", "set", name, "--env", LIVE_ENVIRONMENT, "--repo", repository];
    // The value goes in on stdin, so it never reaches argv (`ps`) or this list.
    commands.push(`gh ${args.join(" ")}  # value from ${envFile}, on stdin`);
    if (!dryRun) gh(args, values[name]);
  }

  return {
    repository,
    environment: LIVE_ENVIRONMENT,
    reviewers,
    secrets: keys.map(envName),
    commands,
    dryRun,
  };
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
