import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse as yamlParse } from "yaml";
import { bootstrapRepo } from "../hosts/github.js";
import type { Operation, Project, SurfaceId } from "../model.js";
import { gateSteps, packageSteps } from "../project/gate.js";
import { sourcesZipName, zipName } from "./browser-extension.js";
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
  it("always emits ci.yml, release.yml, .env.example and renovate.json, never compose without a trigger", () => {
    const files = emitted(project(["cli", "mcp"]));
    expect(Object.keys(files).sort()).toEqual([
      ".env.example",
      ".github/workflows/ci.yml",
      ".github/workflows/release.yml",
      "renovate.json",
    ]);
    // No registry surface: the tag still gets its gate, its assets and its Release, no legs.
    const bare = yamlParse(files[".github/workflows/release.yml"]);
    expect(Object.keys(bare.jobs)).toEqual(["gate", "package", "release"]);
    expect(bare.jobs.gate.outputs).toEqual({ sha: "${{ steps.tag.outputs.sha }}" });
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

  it("release.yml runs the legs in the forced order npm -> oci -> mcp-registry -> clawhub, each gated on what the gate decided", () => {
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
    expect(release.on.push).toEqual({ tags: ["v*"] });
    // The re-run after adding a secret: a fresh run reads current secrets, `gh run rerun` does not.
    expect(release.on.workflow_dispatch.inputs.tag).toMatchObject({
      required: true,
      type: "string",
    });
    // Presence is decided once, in the gate, and every leg obeys it at job level.
    expect(Object.keys(release.jobs.gate.outputs)).toEqual([
      "sha",
      "npm",
      "oci",
      "mcp_registry",
      "clawhub_package",
      "clawhub_skill",
      "pages",
    ]);
    expect(release.jobs["publish-npm"].if).toBe("needs.gate.outputs.npm == 'true'");
    expect(release.jobs["publish-mcp-registry"].if).toBe(
      "needs.gate.outputs.mcp_registry == 'true'",
    );
    expect(release.jobs["publish-clawhub"].if).toBe("needs.gate.outputs.clawhub_package == 'true'");
    expect(release.jobs["pages-build"].if).toBe("needs.gate.outputs.pages == 'true'");
    const presence = (
      release.jobs.gate.steps as { id?: string; run?: string; env?: Record<string, string> }[]
    ).find((s) => s.id === "presence");
    expect(presence?.env?.NPM_TOKEN).toBe("${{ secrets.NPM_TOKEN }}");
    expect(presence?.run).toContain('echo "npm=$npm" >> "$GITHUB_OUTPUT"');
    expect(presence?.run).toContain('[ "$npm" = true ] && [ "$oci" = true ]');
    // Skipped legs never skip the Release; failed ones do. It retracts dropped registries first.
    expect(release.jobs.release.if).toBe(
      "${{ !cancelled() && needs.package.result == 'success' && !contains(needs.*.result, 'failure') }}",
    );
    const releaseSteps = release.jobs.release.steps as {
      run?: string;
      with?: Record<string, unknown>;
    }[];
    expect(releaseSteps[0].with).toEqual({
      ref: "${{ needs.gate.outputs.sha }}",
      "fetch-depth": 0,
    });
    expect(releaseSteps.some((s) => s.run === "npx toolfactory unpublish")).toBe(true);
    expect(releaseSteps.at(-1)?.with).toMatchObject({
      tag_name: "${{ inputs.tag || github.ref_name }}",
      target_commitish: "${{ needs.gate.outputs.sha }}",
    });
    // Cutting a tag from the Actions UI: gate resolves the commit, the Release creates the tag.
    const gateSteps_ = release.jobs.gate.steps as {
      id?: string;
      run?: string;
      with?: Record<string, unknown>;
    }[];
    expect(gateSteps_[0].with).toEqual({ "fetch-depth": 0 });
    expect(gateSteps_.find((s) => s.id === "tag")?.run).toContain(
      'git rev-parse -q --verify "refs/tags/$RELEASE_TAG^{commit}"',
    );
    expect(Object.keys(release.jobs)).toEqual([
      "gate",
      "package",
      "publish-npm",
      "publish-oci",
      "publish-mcp-registry",
      "publish-clawhub",
      "publish-clawhub-skill",
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
    // ClawHub's skill catalog is a separate track: it needs only `gate` (no built tarball), and
    // reuses ClawHub's own skill-publish.yml, which derives slug/version from SKILL.md itself.
    expect(release.jobs["publish-clawhub-skill"]).toMatchObject({
      needs: "gate",
      uses: "openclaw/clawhub/.github/workflows/skill-publish.yml@main",
      with: { skill_path: "skills/hello", dry_run: false },
    });
    expect(release.jobs["publish-clawhub-skill"].secrets.clawhub_token).toContain("CLAWHUB_TOKEN");
    expect(release.jobs.release.needs.at(-1)).toBe("publish-clawhub-skill");

    // Every job that runs steps declares its own permissions; the workflow-call leg inherits the
    // file's `contents: read`.
    const withoutPermissions = Object.entries(
      release.jobs as Record<string, { permissions?: unknown }>,
    )
      .filter(([, job]) => job.permissions === undefined)
      .map(([name]) => name);
    expect(withoutPermissions).toEqual(["publish-clawhub", "publish-clawhub-skill"]);
    expect(release.permissions).toEqual({ contents: "read" });
    expect(release.jobs["publish-oci"].permissions).toEqual({
      contents: "read",
      packages: "write",
      attestations: "write",
      "id-token": "write",
    });
    expect(release.jobs.release.permissions).toEqual({
      contents: "write",
      packages: "write",
      pages: "write",
      "id-token": "write",
    });
    expect(release.jobs["pages-deploy"].permissions).toEqual({
      pages: "write",
      "id-token": "write",
    });

    // The gate asserts the tag against the identity file's version and never writes it (§2.2).
    const gateRuns = (release.jobs.gate.steps as { run?: string }[])
      .map((s) => s.run)
      .filter(Boolean);
    // After the commit is resolved (a dispatched tag may not exist yet), before anything else.
    expect(gateRuns[1]).toBe(
      'test "v$(node -p "require(\'./package.json\').version")" = "$RELEASE_TAG"',
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
        s.run?.includes('NODE_AUTH_TOKEN="$NPM_TOKEN" npm publish --access public'),
      ),
    ).toBe(true);
    // The oci leg pushes the very image server.json's oci entry names.
    const meta = (
      release.jobs["publish-oci"].steps as { id?: string; with?: Record<string, string> }[]
    ).find((s) => s.id === "meta");
    expect(meta?.with?.images).toBe("ghcr.io/acme/hello");
    expect(meta?.with?.labels).toBe("io.modelcontextprotocol.server.name=io.github.acme/hello");
    expect(files[".github/workflows/release.yml"]).toContain("git is the ledger");
    expect(files[".github/workflows/release.yml"]).toContain("CLAWHUB_TOKEN");
  });

  it("clawhub without openclaw-native publishes nothing (there is no host package to publish)", () => {
    const release = emitted(project(["clawhub", "npm"]))[".github/workflows/release.yml"];
    expect(yamlParse(release).jobs["publish-clawhub"]).toBeUndefined();
  });

  it("clawhub + skill without openclaw-native still publishes the skill catalog leg", () => {
    const release = yamlParse(
      emitted(project(["clawhub", "skill"]))[".github/workflows/release.yml"],
    );
    expect(release.jobs["publish-clawhub"]).toBeUndefined();
    expect(release.jobs["publish-clawhub-skill"].needs).toBe("gate");
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
    // No live credential is not "nothing to do": the release tokens still land, at repository scope.
    const noCredential = project(["cli"], { identity: target.identity });
    noCredential.tool.config = { ...noCredential.tool.config, required: [] };
    const release = bootstrapRepo(noCredential, { dryRun: true, releaseSecrets: ["NPM_TOKEN"] });
    expect(release.secrets).toEqual(["NPM_TOKEN"]);
    expect(release.commands).toContain(
      "gh secret set NPM_TOKEN --repo acme/hello  # value from /repo/.env, on stdin",
    );
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
    const target = project([
      "npm",
      "pypi",
      "openclaw-native",
      "skill",
      "claude",
      "web",
      "browser-extension",
      "mcp",
    ]);
    const runs = packageSteps(target).map((step) => step.run);
    expect(runs).toContain("npm pack --pack-destination dist/release");
    expect(runs).toContain("uv build --out-dir dist/release");
    expect(runs.some((run) => run.includes("npm pack ./hosts/openclaw"))).toBe(true);
    expect(runs).toContain("zip -qr dist/release/hello-plugin.zip skills .claude-plugin");
    expect(runs.some((run) => run.includes("hello-web.tar.gz"))).toBe(true);
    // wxt zip -b <browser> per store, copied into dist/release under zipName()'s own names, plus
    // the Firefox sources zip `wxt zip -b firefox` writes alongside it.
    const zipStep = runs.find((run) => run.includes("wxt zip hosts/browser -b chrome"));
    expect(zipStep).toContain("wxt zip hosts/browser -b firefox");
    expect(zipStep).toContain("wxt zip hosts/browser -b edge");
    for (const asset of [
      zipName(target, "chrome"),
      zipName(target, "firefox"),
      zipName(target, "edge"),
      sourcesZipName(target),
    ]) {
      expect(zipStep).toContain(asset);
    }
    // The signed Firefox xpi is opt-in on the JWT pair, never a hard failure when absent.
    expect(
      runs.some((run) => run.includes("web-ext sign") && run.includes("FIREFOX_JWT_ISSUER")),
    ).toBe(true);
    expect(runs.at(-1)).toBe(
      "cp COVERAGE.md dist/release/ && npx toolfactory coverage > dist/release/coverage.json",
    );
  });
});

/**
 * The publish-browser-ext leg (store submission) and its opt-in Safari sibling: the leg appears
 * only with the surface, Safari only with the surface *and* `tool.json` `browserExtension.safari`.
 */
describe("browser-extension release legs", () => {
  it("release.yml carries publish-browser-ext only with the surface, Safari only with the flag", () => {
    const withIdentity = {
      identity: {
        name: "hello",
        repository: "https://github.com/acme/hello.git",
        version: "0.1.0",
      },
    };
    const noExtension = project(["npm"], withIdentity);
    expect(
      yamlParse(emitted(noExtension)[".github/workflows/release.yml"]).jobs["publish-browser-ext"],
    ).toBeUndefined();

    const withExtension = project(["browser-extension", "mcp"], withIdentity);
    const release = yamlParse(emitted(withExtension)[".github/workflows/release.yml"]);
    // browser-extension alone (no npm/pypi/mcp-registry/clawhub) still gets a release.yml.
    expect(release.jobs["publish-browser-ext"]).toBeDefined();
    expect(release.jobs["publish-browser-ext"].needs).toEqual(["gate", "package"]);
    expect(release.jobs["publish-browser-ext"].permissions).toEqual({ contents: "read" });
    const steps = release.jobs["publish-browser-ext"].steps as { run?: string; if?: string }[];
    expect(steps.some((s) => s.run?.includes("wxt submit --dry-run"))).toBe(true);
    const realSubmit = steps.find(
      (s) => s.run?.includes("wxt submit") && !s.run.includes("--dry-run"),
    );
    expect(realSubmit).toBeDefined();
    // release.yml runs only on a tag or a dispatched tag, so the job-level store gate is the whole condition.
    expect(release.jobs["publish-browser-ext"].if).toContain("needs.gate.outputs.chrome == 'true'");
    expect(release.jobs.release.needs).toContain("publish-browser-ext");
    expect(release.jobs["publish-browser-ext-safari"]).toBeUndefined();

    const withSafari = project(["browser-extension", "mcp"], {
      ...withIdentity,
      tool: { ...project(["browser-extension"]).tool, browserExtension: { safari: true } },
    });
    const safariRelease = yamlParse(emitted(withSafari)[".github/workflows/release.yml"]);
    expect(safariRelease.jobs["publish-browser-ext-safari"]).toMatchObject({
      needs: "gate",
      "runs-on": "macos-latest",
    });
    // The Safari leg submits to App Store Connect, not dist/release/: it never gates the release.
    expect(safariRelease.jobs.release.needs).not.toContain("publish-browser-ext-safari");
  });
});
