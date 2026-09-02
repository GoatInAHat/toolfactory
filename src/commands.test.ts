/**
 * The command layer's own behaviour: the step runner behind `gate`/`package`, the `gh`
 * invocations `init --repo` makes (dry-run only — `gh` is not installed here and
 * api.github.com is unreachable, so the shape is proved, never the call), and what `init`
 * leaves behind in a real directory.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as commands from "./commands.js";
import { createRepo } from "./hosts/github.js";
import type { Project, SurfaceId } from "./model.js";
import { RELOAD } from "./surfaces/agents.js";

function project(surfaces: SurfaceId[]): Project {
  return {
    root: "/repo",
    tool: {
      schemaVersion: 1,
      identity: "plugin.json",
      binding: "typescript",
      surfaces,
      bundle: { runtime: "package" },
      tests: { examples: {} },
    },
    identity: { name: "probe", version: "0.1.0", description: "A probe tool" },
    identityExtra: {},
    operations: [],
    toolfactoryVersion: "0.1.0",
  };
}

const environment = { ...process.env };
afterEach(() => {
  process.env = { ...environment };
});

describe("runSteps", () => {
  it("runs in order, skips CI-only provisioning, and stops at the first failure", () => {
    const { steps } = commands.runSteps(tmpdir(), [
      { name: "first", run: "true" },
      { name: "provisioning", run: "exit 1", when: "ci" },
      { name: "boom", run: "exit 3" },
      { name: "never", run: "true" },
    ]);
    expect(steps.map((step) => [step.name, step.ok])).toEqual([
      ["first", true],
      ["boom", false],
    ]);
    expect(steps.every((step) => step.durationMs >= 0)).toBe(true);
  });
});

describe("createRepo", () => {
  it("dry-runs the exact gh invocations: private, from the checkout, one topic per surface", () => {
    expect(
      createRepo(project(["skill", "mcp", "openclaw-native", "cli"]), {
        slug: "GoatInAHat/probe",
        dryRun: true,
      }),
    ).toEqual({
      repository: "GoatInAHat/probe",
      visibility: "private",
      topics: ["agent-skill", "mcp-server", "openclaw-plugin", "toolfactory"],
      commands: [
        'gh repo create GoatInAHat/probe --private --description "A probe tool" --source . --remote origin --push',
        "gh repo edit GoatInAHat/probe --add-topic agent-skill,mcp-server,openclaw-plugin,toolfactory",
      ],
      dryRun: true,
    });
  });

  it("makes the repository public only when asked", () => {
    const { commands: lines } = createRepo(project(["mcp"]), {
      slug: "GoatInAHat/probe",
      public: true,
      dryRun: true,
    });
    expect(lines[0]).toContain("--public");
    expect(lines[0]).not.toContain("--private");
  });
});

describe("init", () => {
  it("initialises a git repository, commits, and reports the reload line of this harness", () => {
    const dir = mkdtempSync(join(tmpdir(), "toolfactory-init-"));
    process.env.CLAUDECODE = "1";
    // `setup: false`: `.agents/setup` installs dependencies, which belongs to the end-to-end
    // proof in a real project, not to a unit test.
    const result = commands.init({
      root: dir,
      name: "probe",
      binding: "typescript",
      surfaces: ["cli"],
      repo: "GoatInAHat/probe",
      dryRun: true,
      setup: false,
    });

    expect(existsSync(join(dir, ".git"))).toBe(true);
    expect(execFileSync("git", ["log", "--format=%s"], { cwd: dir, encoding: "utf8" }).trim()).toBe(
      "toolfactory init",
    );
    expect(result.repository?.commands[0]).toBe(
      "gh repo create GoatInAHat/probe --private --source . --remote origin --push",
    );
    // Nothing ran: no remote, and no live-tests bootstrap without a declared credential.
    expect(execFileSync("git", ["remote"], { cwd: dir, encoding: "utf8" }).trim()).toBe("");
    expect(result.repository?.secrets).toEqual([]);
    expect(result.nextSteps[1]).toBe(RELOAD.find((row) => row.harness === "Claude Code")?.line);
    expect(result.nextSteps[2]).toContain("src/ops.ts");
  });
});
