import { describe, expect, it } from "vitest";
import type { Project } from "../model.js";
import {
  systemPackageConfigSchema,
  systemPackageSteps,
  systemPublishJobs,
  systemRegistryRows,
} from "./system.js";

function project(
  entries: unknown[],
  surfaces = entries.map((entry) => (entry as { id: string }).id),
): Project {
  return {
    root: "/local/never-in-output",
    tool: {
      schemaVersion: 1,
      identity: "package.json",
      binding: "typescript",
      surfaces: surfaces as unknown as Project["tool"]["surfaces"],
      bundle: { runtime: "package" },
      tests: { examples: {} },
      systemPackages: entries,
    } as unknown as Project["tool"],
    identity: { name: "tool", version: "1.2.3" },
    identityExtra: {},
    operations: [],
    toolfactoryVersion: "0.1.0",
  };
}
const choco = {
  id: "chocolatey",
  path: "packaging/choco",
  identity: "tool.nuspec",
  name: "tool",
  versionCommand: "node -p \"require('./tool.nuspec.version.json').version\"",
};

describe("system packages", () => {
  it("requires real catalog/repository configuration", () => {
    expect(() => systemPackageConfigSchema.parse({ ...choco, id: "apt" })).toThrow(/PPA/);
    expect(() => systemPackageSteps(project([], ["chocolatey"]))).toThrow(/exactly one/);
  });
  it("packages with checkout-relative paths", () => {
    const steps = systemPackageSteps(project([choco]));
    expect(steps.at(-1)?.run).toContain("choco pack 'packaging/choco/tool.nuspec'");
    expect(steps.at(-1)?.run).not.toContain("/local/never-in-output");
  });
  it("stages a non-root WinGet manifest directory and Debian source changes portably", () => {
    const winget = {
      id: "winget",
      path: "packaging/winget",
      identity: "manifests/a/acme/tool/1.2.3",
      name: "Acme.Tool",
      versionCommand: "cat VERSION",
      asset: "dist/tool.msi",
    };
    const apt = {
      id: "apt",
      path: "packaging/debian/source",
      identity: "debian/control",
      name: "tool",
      versionCommand: "dpkg-parsechangelog -S Version | cut -d- -f1",
      ppa: "acme/tool",
    };
    const steps = systemPackageSteps(project([winget, apt]));
    expect(steps.find((step) => step.name === "WinGet catalog submission")?.run).toContain(
      "test -d 'packaging/winget/manifests/a/acme/tool/1.2.3'",
    );
    const debian = steps.find((step) => step.name === "Debian source package")?.run;
    expect(debian).toContain("find 'packaging/debian/source/..'");
    expect(debian).toContain("'dist/release/system/apt'");
    expect(debian).not.toContain("../dist/release");
  });
  it("gates direct jobs and leaves reviewed catalogs out of direct publication", () => {
    const brew = {
      id: "homebrew",
      path: "packaging/brew",
      identity: "tool.rb",
      name: "tool",
      versionCommand: "grep VERSION tool.rb",
      asset: "dist/tool.tar.gz",
      tap: "acme/homebrew-tap",
    };
    const jobs = systemPublishJobs(
      project([choco, brew]),
      "release-assets",
      "${{ needs.gate.outputs.sha }}",
    );
    expect(jobs["publish-chocolatey"]?.if).toBe("needs.gate.outputs.chocolatey == 'true'");
    expect(jobs["publish-homebrew"]).toBeUndefined();
    expect(JSON.stringify(jobs["publish-chocolatey"])).toContain(
      "release-assets/system/chocolatey",
    );
    expect(JSON.stringify(jobs)).not.toContain("/local/never-in-output");
    expect(systemRegistryRows(project([choco])).at(0)?.secrets).toEqual(["CHOCOLATEY_API_KEY"]);
  });
});
