import { describe, expect, it } from "vitest";
import type { Project } from "../model.js";
import {
  systemPackageConfigSchema,
  systemPackageJobs,
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
    expect(() =>
      systemPackageConfigSchema.parse({
        id: "scoop",
        path: "packaging/scoop",
        identity: "tool.json",
        name: "tool",
        versionCommand: "Get-Content VERSION",
        buildCommand: "./build.ps1",
        asset: "../tool.zip",
        bucket: "acme/scoop-bucket",
        bucketName: "acme",
        catalogPath: "bucket/tool.json",
      }),
    ).toThrow(/path must stay/);
    expect(() => systemPackageSteps(project([], ["chocolatey"]))).toThrow(/exactly one/);
  });
  it("packages with checkout-relative paths", () => {
    const steps = systemPackageSteps(project([choco]), { local: false });
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
      buildCommand: "./build-installer.ps1",
      asset: "dist/tool.msi",
    };
    const apt = {
      id: "apt",
      path: "packaging/debian/source",
      identity: "debian/control",
      name: "tool",
      versionCommand: "dpkg-parsechangelog -S Version | cut -d- -f1",
      ppa: "acme/tool",
      buildDependencies: ["debhelper"],
    };
    const steps = systemPackageSteps(project([winget, apt]), { local: false });
    expect(steps.find((step) => step.name === "WinGet catalog submission")?.run).toContain(
      "test -d 'packaging/winget/manifests/a/acme/tool/1.2.3'",
    );
    const debian = steps.find((step) => step.name === "Debian source package")?.run;
    expect(debian).toContain("find 'packaging/debian/source/..'");
    expect(debian).toContain("'dist/release/system/apt'");
    expect(debian).not.toContain("../dist/release");
  });
  it("gates direct jobs and commits author-controlled Homebrew metadata after release", () => {
    const brew = {
      id: "homebrew",
      path: "packaging/brew",
      identity: "tool.rb",
      name: "tool",
      versionCommand: "grep VERSION tool.rb",
      buildCommand: "make release-archive",
      asset: "dist/tool.tar.gz",
      tap: "acme/homebrew-tap",
      catalogPath: "Formula/tool.rb",
    };
    const jobs = systemPublishJobs(
      project([choco, brew]),
      "release-assets",
      "${{ needs.gate.outputs.sha }}",
    );
    expect(jobs["publish-chocolatey"]?.if).toBe("needs.gate.outputs.chocolatey == 'true'");
    expect(jobs["publish-homebrew"]?.needs).toEqual(["gate", "release"]);
    expect(JSON.stringify(jobs["publish-homebrew"])).toContain("git -C .system-catalog push");
    expect(JSON.stringify(jobs["publish-homebrew"])).toContain("system-homebrew");
    expect(JSON.stringify(jobs["publish-homebrew"])).toContain("toolfactory-postrelease/tap");
    expect(JSON.stringify(jobs["publish-chocolatey"])).toContain("system-chocolatey");
    expect(JSON.stringify(jobs)).not.toContain("/local/never-in-output");
    expect(systemRegistryRows(project([choco])).at(0)?.secrets).toEqual(["CHOCOLATEY_API_KEY"]);
  });
  it("uses dedicated native runners and upload names instead of the Ubuntu package job", () => {
    const brew = {
      id: "homebrew",
      path: "packaging/brew",
      identity: "tool.rb",
      name: "tool",
      versionCommand: "grep VERSION tool.rb",
      buildCommand: "make release-archive",
      asset: "dist/tool.tar.gz",
      tap: "acme/homebrew-tap",
      catalogPath: "Formula/tool.rb",
    };
    const jobs = systemPackageJobs(project([choco, brew]), "${{ github.sha }}");
    expect(jobs["system-homebrew"]?.["runs-on"]).toBe("macos-latest");
    expect(jobs["system-chocolatey"]?.["runs-on"]).toBe("windows-latest");
    expect(JSON.stringify(jobs["system-chocolatey"])).toContain("system-chocolatey");
    expect(JSON.stringify(jobs)).not.toContain("/local/never-in-output");
  });
});
