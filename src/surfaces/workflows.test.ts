import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as yamlParse } from "yaml";
import { bootstrapRepo } from "../hosts/github.js";
import type { Operation, Project, SurfaceId } from "../model.js";
import { gateSteps, packageSteps } from "../project/gate.js";
import { surface } from "./workflows.js";

const echo: Operation = { name: "echo", inputSchema: { type: "object" }, requires: [] };
const shoot: Operation = { name: "shoot", inputSchema: { type: "object" }, requires: ["browser"] };

function project(surfaces: SurfaceId[], overrides: Partial<Project> = {}): Project {
  return {
    root: "/repo",
    tool: {
      schemaVersion: 1,
      identity: "package.json",
      binding: "typescript",
      surfaces,
      bundle: { runtime: "package" },
      tests: { examples: {} },
      config: {
        properties: {
          api_key: {
            type: "string",
            description: "Provider API key",
            "x-toolfactory": { sensitive: true, tier: 4, url: "https://example.com/keys" },
          },
          region: { type: "string", description: "Deployment region" },
        },
        required: ["api_key"],
      },
    },
    identity: { name: "hello", version: "0.1.0", description: "Say hello" },
    identityExtra: {},
    operations: [echo],
    toolfactoryVersion: "0.1.0",
    ...overrides,
  };
}

function emitted(target: Project): Record<string, string> {
  return Object.fromEntries(
    surface
      .plan(target)
      .map((file) => [
        file.path,
        file.kind === "file"
          ? file.content
          : file.kind === "merge"
            ? JSON.stringify(file.patch)
            : "",
      ]),
  );
}

/** Every generated file is a parseable document in its format — the one invariant that must never break. */
function expectAllYamlAndJsonParse(files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    if (path.endsWith(".yml") || path.endsWith(".yaml")) {
      expect(() => yamlParse(content), path).not.toThrow();
    } else if (path.endsWith(".json")) {
      expect(() => JSON.parse(content), path).not.toThrow();
    }
  }
}

describe("workflows", () => {
  it("always emits ci.yml, .env.example and renovate.json, never release.yml or compose without a trigger", () => {
    const files = emitted(project(["cli", "mcp"]));
    expect(Object.keys(files).sort()).toEqual([
      ".env.example",
      ".github/workflows/ci.yml",
      "renovate.json",
    ]);
    expectAllYamlAndJsonParse(files);

    const ci = yamlParse(files[".github/workflows/ci.yml"]);
    expect(ci.jobs.test.strategy.matrix["node-version"]).toEqual(["22", "24"]);
    // No skill/claude/openclaw-native selected: no extra validator installs, no matrix guard.
    const steps = ci.jobs.test.steps as { run?: string; if?: string }[];
    expect(steps.some((s) => s.run?.includes("agentskills"))).toBe(false);
    expect(
      steps.filter((s) => (s as { uses?: string }).uses).map((s) => (s as { uses?: string }).uses),
    ).toEqual(["actions/checkout@v7", "actions/setup-node@v7"]);
    expect(steps.some((s) => s.run?.includes("claude-code"))).toBe(false);
    expect(steps.find((s) => s.run === "npx toolfactory validate")?.if).toBeUndefined();

    const renovate = JSON.parse(files["renovate.json"]);
    expect(renovate.extends).toEqual(["config:recommended", "group:all"]);
    expect(renovate.minimumReleaseAge).toBe("7 days");
    // The generated workflows are SHA-locked projections: a Renovate PR editing one would make
    // `toolfactory check` fail and the next `toolfactory build` revert it.
    expect(renovate.ignorePaths).toContain(".github/workflows/**");
  });

  it("ci.yml installs each selected surface's validator and guards the openclaw leg on the matrix", () => {
    const files = emitted(project(["skill", "claude", "openclaw-native", "mcp"]));
    const ci = yamlParse(files[".github/workflows/ci.yml"]);
    const steps = ci.jobs.test.steps as { uses?: string; run?: string; if?: string }[];
    expect(steps.some((s) => s.uses === "astral-sh/setup-uv@v6")).toBe(true);
    expect(steps.some((s) => s.run?.includes("npm i -g @anthropic-ai/claude-code"))).toBe(true);
    // openclaw-native needs Node >=24; skip that one step on the 22 leg rather than fail it.
    expect(steps.find((s) => s.run === "npx toolfactory validate")?.if).toBe(
      "matrix.node-version == '24'",
    );
  });

  it("python binding uses a single uv + Python 3.12 toolchain, no node matrix", () => {
    const python = project(["cli", "mcp"], {
      tool: { ...project(["cli"]).tool, binding: "python" },
    });
    const ci = yamlParse(emitted(python)[".github/workflows/ci.yml"]);
    expect(ci.jobs.test.strategy).toBeUndefined();
    const steps = ci.jobs.test.steps as {
      uses?: string;
      with?: Record<string, string>;
      run?: string;
    }[];
    expect(steps.find((s) => s.uses === "astral-sh/setup-uv@v6")?.with).toEqual({
      "python-version": "3.12",
    });
    expect(steps.some((s) => s.run === "uv run --with pytest pytest -q")).toBe(true);
  });

  it("release.yml appears only with a registry surface, in the forced order npm -> oci -> mcp-registry -> clawhub", () => {
    expect(emitted(project(["cli"]))[".github/workflows/release.yml"]).toBeUndefined();

    const files = emitted(
      project(
        ["npm", "mcp-registry", "clawhub", "openclaw-native", "skill", "claude", "web", "mcp"],
        {
          identity: {
            name: "hello",
            version: "0.1.0",
            repository: "https://github.com/acme/hello.git",
          },
        },
      ),
    );
    expectAllYamlAndJsonParse(files);
    const release = yamlParse(files[".github/workflows/release.yml"]);
    expect(release.on).toEqual({ push: { tags: ["v*"] } });
    expect(Object.keys(release.jobs)).toEqual([
      "gate",
      "package",
      "publish-npm",
      "publish-oci",
      "publish-mcp-registry",
      "publish-clawhub",
      "release",
      "pages-build",
      "pages-deploy",
    ]);
    expect(release.jobs["publish-npm"].needs).toBe("gate");
    expect(release.jobs["publish-oci"].needs).toBe("gate");
    expect(release.jobs["publish-mcp-registry"].needs).toEqual(["publish-npm", "publish-oci"]);
    // The ClawHub leg publishes the tarball `package` built, not the repository subdirectory:
    // the reusable workflow has no build step of its own.
    expect(release.jobs["publish-clawhub"].needs).toEqual([
      "package",
      "publish-npm",
      "publish-oci",
      "publish-mcp-registry",
    ]);
    expect(release.jobs["publish-clawhub"].with).toMatchObject({
      package_artifact_name: "release-assets",
      package_artifact_path: "openclaw-plugin-hello-0.1.0.tgz",
    });
    expect(release.jobs["publish-clawhub"].secrets.clawhub_token).toContain("CLAWHUB_TOKEN");
    expect(release.jobs.release.needs.at(-1)).toBe("publish-clawhub");

    // Every job that runs steps declares its own permissions; the workflow-call leg inherits the
    // file's `contents: read`.
    const withoutPermissions = Object.entries(
      release.jobs as Record<string, { permissions?: unknown }>,
    )
      .filter(([, job]) => job.permissions === undefined)
      .map(([name]) => name);
    expect(withoutPermissions).toEqual(["publish-clawhub"]);
    expect(release.permissions).toEqual({ contents: "read" });
    expect(release.jobs["publish-oci"].permissions).toEqual({
      contents: "read",
      packages: "write",
      attestations: "write",
      "id-token": "write",
    });
    expect(release.jobs.release.permissions).toEqual({ contents: "write" });
    expect(release.jobs["pages-deploy"].permissions).toEqual({
      pages: "write",
      "id-token": "write",
    });

    // The gate asserts the tag against the identity file's version and never writes it (§2.2).
    const gateRuns = (release.jobs.gate.steps as { run?: string }[])
      .map((s) => s.run)
      .filter(Boolean);
    expect(gateRuns[0]).toBe(
      'test "v$(node -p "require(\'./package.json\').version")" = "$GITHUB_REF_NAME"',
    );
    // The gate is the same check sequence as ci.yml: build precedes `toolfactory validate`,
    // which runs every selected surface's own validator (no transcribed commands to drift).
    expect(gateRuns.indexOf("npm run --if-present build")).toBeLessThan(
      gateRuns.indexOf("npx toolfactory validate"),
    );
    expect(gateRuns.some((r) => r?.includes("openclaw plugins build"))).toBe(false);
    // npm generates provenance itself under trusted publishing; --provenance is redundant.
    expect(
      (release.jobs["publish-npm"].steps as { run?: string }[]).some((s) =>
        s.run?.endsWith("npm publish --access public"),
      ),
    ).toBe(true);
    // The oci leg pushes the very image server.json's oci entry names.
    const meta = (
      release.jobs["publish-oci"].steps as { id?: string; with?: Record<string, string> }[]
    ).find((s) => s.id === "meta");
    expect(meta?.with?.images).toBe("ghcr.io/acme/hello");
    expect(meta?.with?.labels).toBe("io.modelcontextprotocol.server.name=io.github.acme/hello");
    expect(files[".github/workflows/release.yml"]).toContain("no per-registry release-ledger");
    expect(files[".github/workflows/release.yml"]).toContain("CLAWHUB_TOKEN");
  });

  it("clawhub without openclaw-native publishes nothing (there is no host package to publish)", () => {
    const release = emitted(project(["clawhub", "npm"]))[".github/workflows/release.yml"];
    expect(yamlParse(release).jobs["publish-clawhub"]).toBeUndefined();
  });

  it("compose.toolfactory.yaml appears only for a host-native surface and picks the browser image variant", () => {
    expect(emitted(project(["cli"]))["compose.toolfactory.yaml"]).toBeUndefined();

    const withBrowser = project(["openclaw-native"], { operations: [echo, shoot] });
    const compose = yamlParse(emitted(withBrowser)["compose.toolfactory.yaml"]);
    expect(compose.services.openclaw.image).toBe("ghcr.io/openclaw/openclaw:latest-browser");
    // `--link` (a copy trips the install-time symlink scan) and a non-interactive accept.
    expect(compose.services.openclaw.command[2]).toContain(
      "openclaw plugins install --link /work/hosts/openclaw --force --accept-capabilities",
    );
    expect(compose.services.openclaw.env_file).toEqual([".env"]);
    expect(compose.services.hermes).toBeUndefined();
    expect(compose.volumes.PLUGIN_DATA).toEqual({});

    const noBrowser = project(["hermes-native"]);
    const composeHermes = yamlParse(emitted(noBrowser)["compose.toolfactory.yaml"]);
    expect(composeHermes.services.hermes.command[2]).toContain(
      "hermes plugins doctor /work/hosts/hermes/hello_hermes --ci",
    );
    expect(composeHermes.services.openclaw).toBeUndefined();
  });

  it("adds the T4 live job, and workflow_dispatch, iff a config key is required and sensitive", () => {
    const ci = yamlParse(emitted(project(["cli"]))[".github/workflows/ci.yml"]);
    expect(ci.on.workflow_dispatch).toEqual({});
    const live = ci.jobs.live;
    expect(live.needs).toBe("test");
    expect(live.environment).toBe("live-tests");
    // A fork's pull request must never see the live-tests secrets.
    expect(live.if).toBe(
      "github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository",
    );
    // Every sensitive key, not only the required ones: an optional credential is still a secret.
    expect(live.env).toEqual({ API_KEY: "${{ secrets.API_KEY }}" });
    expect((live.steps as { run?: string }[]).at(-1)?.run).toBe("npm run --if-present test:live");

    const python = project(["cli"], { tool: { ...project(["cli"]).tool, binding: "python" } });
    expect(
      (
        yamlParse(emitted(python)[".github/workflows/ci.yml"]).jobs.live.steps as { run?: string }[]
      ).at(-1)?.run,
    ).toBe("uv run --with pytest pytest -q tests/test_live.py");

    // api_key optional: nothing gates a live run, so no live job and no workflow_dispatch.
    const noCredential = project(["cli"]);
    noCredential.tool.config = { ...noCredential.tool.config, required: [] };
    const plain = yamlParse(emitted(noCredential)[".github/workflows/ci.yml"]);
    expect(plain.jobs.live).toBeUndefined();
    expect(plain.on.workflow_dispatch).toBeUndefined();
  });

  it(".env.example lists every config key uppercased, secrets and required marked", () => {
    const env = emitted(project(["cli"]))[".env.example"];
    expect(env).toContain("API_KEY=");
    expect(env).toContain("(required, secret) — get one: https://example.com/keys");
    expect(env).toContain("REGION=");
    expect(env).toContain("(optional)");
  });
});

/** Real invocation: an offline GitHub Actions linter, when one happens to be on PATH. */
function actionlintAvailable(): boolean {
  try {
    execFileSync("actionlint", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!actionlintAvailable())("actionlint", () => {
  it("accepts the generated ci.yml and release.yml", () => {
    const dir = mkdtempSync(join(tmpdir(), "tf-workflows-"));
    const files = emitted(
      project(
        [
          "npm",
          "mcp-registry",
          "clawhub",
          "openclaw-native",
          "hermes-native",
          "skill",
          "claude",
          "web",
          "mcp",
        ],
        {
          identity: {
            name: "hello",
            version: "0.1.0",
            repository: "https://github.com/acme/hello.git",
          },
        },
      ),
    );
    const workflowPaths: string[] = [];
    for (const [path, content] of Object.entries(files)) {
      if (!path.startsWith(".github/workflows/")) continue;
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
      workflowPaths.push(path);
    }
    // actionlint otherwise walks up looking for a git repo to find `.github/workflows`;
    // point it straight at the files instead.
    execFileSync("actionlint", workflowPaths, { cwd: dir });
  });
});

/**
 * `bootstrap-repo`: the one-time I/O the live job depends on. It shells to the official `gh`
 * CLI, so the unit under test is the invocation list — which `--dry-run` returns without
 * touching the network — and the fact that no secret value appears in it.
 */
describe("bootstrap-repo", () => {
  it("prepares the live-tests environment through gh, with values only ever on stdin", () => {
    const target = project(["cli"], {
      root: "/repo",
      identity: { name: "hello", repository: "https://github.com/acme/hello.git" },
    });
    const result = bootstrapRepo(target, { reviewers: ["ada"], dryRun: true });
    expect(result.repository).toBe("acme/hello");
    expect(result.secrets).toEqual(["API_KEY"]);
    expect(result.commands).toEqual([
      "gh api users/ada --jq .id",
      'gh api --method PUT repos/acme/hello/environments/live-tests --input - <<< \'{"reviewers":[{"type":"User","id":"<id of ada>"}]}\'',
      "gh secret set API_KEY --env live-tests --repo acme/hello  # value from /repo/.env, on stdin",
    ]);

    const anonymous = project(["cli"], { identity: { name: "hello" } });
    expect(() => bootstrapRepo(anonymous, { dryRun: true })).toThrow(/GitHub repository URL/);
    const noCredential = project(["cli"], { identity: target.identity });
    noCredential.tool.config = { ...noCredential.tool.config, required: [] };
    expect(() => bootstrapRepo(noCredential, { dryRun: true })).toThrow(/nothing to do/);
  });
});

/**
 * The gate is a command and the workflows are its projection: one list, two renderings. The
 * local runner skips the runner-only provisioning, so what it skips and what it keeps is pinned.
 */
describe("gate", () => {
  it("lists the same steps CI runs, marking the runner-only ones", () => {
    const target = project(["npm", "claude", "openclaw-native", "mcp"]);
    const steps = gateSteps(target);
    expect(steps.map((step) => step.name)).toEqual([
      "install",
      "build",
      "toolfactory check",
      "toolfactory build (output files)",
      "Install Claude Code CLI",
      "toolfactory validate",
      "author checks",
      "author tests",
      "openclaw end-to-end (scripted model, no LLM key)",
    ]);

    // `npm ci` and a global CLI install are the runner's job, not a checkout's: `toolfactory gate`
    // skips every `when: "ci"` step and runs the rest here, in order.
    expect(steps.filter((step) => step.when === "ci").map((step) => step.name)).toEqual([
      "install",
      "Install Claude Code CLI",
    ]);
    expect(steps.filter((step) => step.when === "node24").map((step) => step.name)).toEqual([
      "toolfactory validate",
      "openclaw end-to-end (scripted model, no LLM key)",
    ]);
  });

  it("packages one asset per selected distribution surface into dist/release", () => {
    const target = project(["npm", "pypi", "openclaw-native", "skill", "claude", "web", "mcp"]);
    const runs = packageSteps(target).map((step) => step.run);
    expect(runs).toContain("npm pack --pack-destination dist/release");
    expect(runs).toContain("uv build --out-dir dist/release");
    expect(runs.some((run) => run.includes("npm pack ./hosts/openclaw"))).toBe(true);
    expect(runs).toContain("zip -qr dist/release/hello-plugin.zip skills .claude-plugin");
    expect(runs.some((run) => run.includes("hello-web.tar.gz"))).toBe(true);
    expect(runs.at(-1)).toBe(
      "cp COVERAGE.md dist/release/ && npx toolfactory coverage > dist/release/coverage.json",
    );
  });
});
