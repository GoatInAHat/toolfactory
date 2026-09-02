/**
 * The I/O half of the T4 live tier: preparing the repository so the generated `live` job can
 * run. Two things GitHub only exposes over its API — an environment with required reviewers,
 * and the secrets inside it — done through the official `gh` CLI (§8 C1: own no client), never
 * a hand-rolled HTTP call.
 *
 * Secret values are read from the local `.env`, piped to `gh` on stdin, and never written to a
 * command line, a log line, or the returned result.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import type { Project } from "../model.js";
import { envName, liveCredentials } from "../surfaces/shared.js";

/** The GitHub environment the generated `live` job deploys to. */
export const LIVE_ENVIRONMENT = "live-tests";

export interface BootstrapOptions {
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

function gh(args: string[], stdin?: string): string {
  return execFileSync("gh", args, {
    encoding: "utf8",
    input: stdin,
    stdio: ["pipe", "pipe", "inherit"],
  }).trim();
}

export function bootstrapRepo(project: Project, options: BootstrapOptions = {}): BootstrapResult {
  const repository = githubSlug(project.identity.repository);
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
