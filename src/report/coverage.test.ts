import { describe, expect, it } from "vitest";
import type { Operation, Project } from "../model.js";
import { surface as codex } from "../surfaces/codex.js";
import { mcp } from "../surfaces/kernel.js";
import { surface as skill } from "../surfaces/skill.js";
import {
  computeCoverage,
  defaultVerdict,
  includedOperations,
  renderCoverageMarkdown,
} from "./coverage.js";

const echo: Operation = {
  name: "echo",
  inputSchema: { type: "object", properties: {} },
  requires: ["fs"],
};
const screenshot: Operation = {
  name: "screenshot",
  inputSchema: { type: "object", properties: {} },
  requires: ["browser"],
};
const notify: Operation = {
  name: "notify",
  inputSchema: { type: "object", properties: {} },
  requires: ["channel"],
};

function project(): Project {
  return {
    root: "/repo",
    tool: {
      schemaVersion: 1,
      identity: "package.json",
      binding: "typescript",
      surfaces: ["skill", "mcp", "codex"],
      bundle: { runtime: "package" },
      tests: { examples: {} },
    },
    identity: { name: "hello", version: "1.0.0" },
    identityExtra: {},
    operations: [echo, screenshot, notify],
    toolfactoryVersion: "0.1.0",
  };
}

describe("defaultVerdict", () => {
  it("is native for a portable operation and excluded, reasoned, otherwise", () => {
    expect(defaultVerdict(echo)).toEqual({ kind: "native" });
    expect(defaultVerdict(screenshot)).toEqual({
      kind: "excluded",
      reason: "excluded:requires-browser",
    });
  });
});

describe("computeCoverage across skill, mcp, codex", () => {
  const coverage = computeCoverage(project(), [skill, mcp, codex]);
  const verdicts = Object.fromEntries(coverage.rows.map((row) => [row.operation, row.verdicts]));

  it("a portable operation is native on skill and mcp, degraded (loader-unverified) on codex", () => {
    expect(verdicts.echo.skill).toEqual({ kind: "native" });
    expect(verdicts.echo.mcp).toEqual({ kind: "native" });
    expect(verdicts.echo.codex).toEqual({ kind: "degraded", reason: "degraded:loader-unverified" });
  });

  it("a browser operation is bridged on skill, excluded (no host capabilities) on mcp and codex", () => {
    expect(verdicts.screenshot.skill).toEqual({
      kind: "bridged",
      reason: "bridged:agent-mediated",
    });
    expect(verdicts.screenshot.mcp).toEqual({
      kind: "excluded",
      reason: "excluded:mcp-no-host-capabilities",
    });
    expect(verdicts.screenshot.codex).toEqual({
      kind: "excluded",
      reason: "excluded:mcp-no-host-capabilities",
    });
  });

  it("a channel operation is excluded everywhere, with skill naming the missing channel bridge", () => {
    expect(verdicts.notify.skill).toEqual({
      kind: "excluded",
      reason: "excluded:no-channel-bridge",
    });
    expect(verdicts.notify.mcp).toEqual({
      kind: "excluded",
      reason: "excluded:mcp-no-host-capabilities",
    });
    expect(verdicts.notify.codex).toEqual({
      kind: "excluded",
      reason: "excluded:mcp-no-host-capabilities",
    });
  });

  it("includedOperations drops exactly what its surface excludes", () => {
    expect(includedOperations(project(), skill).map((o) => o.name)).toEqual(["echo", "screenshot"]);
    expect(includedOperations(project(), mcp).map((o) => o.name)).toEqual(["echo"]);
  });

  it("renderCoverageMarkdown puts every surface as a column and every verdict's reason in the cell", () => {
    const markdown = renderCoverageMarkdown(coverage, [], 3);
    expect(markdown).toContain("| operation | skill | mcp | codex |");
    expect(markdown).toContain("bridged (agent-mediated)");
    expect(markdown).toContain("All generated files are managed by toolfactory.");
  });
});
