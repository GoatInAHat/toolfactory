import { describe, expect, it } from "vitest";
import type { Project } from "../model.js";
import {
  nativeInstallLines,
  nativePackageConfigSchema,
  nativePackageSteps,
  nativePublishJobs,
  nativeRegistryRows,
} from "./native.js";

function project(
  entries: unknown[],
  surfaces = entries.map((entry) => (entry as { id: string }).id),
): Project {
  return {
    root: "/repo",
    tool: {
      schemaVersion: 1,
      identity: "package.json",
      binding: "typescript",
      surfaces: surfaces as unknown as Project["tool"]["surfaces"],
      bundle: { runtime: "package" },
      tests: { examples: {} },
      nativePackages: entries,
    } as unknown as Project["tool"],
    identity: { name: "tool", version: "1.2.3", repository: "https://github.com/acme/tool" },
    identityExtra: {},
    operations: [],
    toolfactoryVersion: "0.1.0",
  };
}
const cargo = {
  id: "cargo",
  path: "native/cli",
  identity: "Cargo.toml",
  name: "acme-cli",
  versionCommand: "cargo pkgid | sed 's/.*@//'",
};

describe("native package configuration", () => {
  it("requires the package path, authored identity, and registry identity", () => {
    expect(() => nativePackageConfigSchema.parse({ id: "cargo", path: "native" })).toThrow();
    expect(nativePackageConfigSchema.parse(cargo)).toEqual(cargo);
  });

  it("rejects a selected registry with no config or duplicate configuration", () => {
    expect(() => nativePackageSteps(project([], ["cargo"]))).toThrow(/requires exactly one/);
    expect(() => nativePackageSteps(project([cargo, cargo]))).toThrow(/repeats/);
  });

  it("packages authored crates and checks their version against the release", () => {
    const steps = nativePackageSteps(project([cargo]));
    expect(steps.map((step) => step.name)).toEqual([
      "cargo version matches release",
      "Cargo crate",
    ]);
    expect(steps[0]?.run).toContain("= '1.2.3'");
    expect(steps[1]?.run).toContain("cargo package --manifest-path 'native/cli/Cargo.toml'");
    expect(steps[1]?.run).toContain("--target-dir 'dist/release/native/cargo/target'");
    expect(steps[1]?.run).not.toContain("/repo");
  });

  it("uses ecosystem commands that need no Node runtime for default versions", () => {
    const cargoDefault = {
      id: "cargo",
      path: "native/cli",
      identity: "Cargo.toml",
      name: "acme-cli",
    };
    const nuget = {
      id: "nuget",
      path: "dotnet",
      identity: "Tool.csproj",
      name: "Acme.Tool",
    };
    const steps = nativePackageSteps(project([cargoDefault, nuget]));
    expect(steps[0]?.run).toContain(
      "cargo metadata --no-deps --format-version 1 --manifest-path 'Cargo.toml'",
    );
    expect(steps[0]?.run).not.toContain("node -e");
    expect(steps[2]?.run).toContain("dotnet msbuild 'Tool.csproj' -nologo -getProperty:Version");
    expect(steps[2]?.run).not.toContain("sed -n");
  });

  it("leaves VCS-discovered Packagist and Go modules for the final release tag", () => {
    const entries = [
      {
        id: "packagist",
        path: ".",
        identity: "composer.json",
        name: "acme/tool",
      },
      {
        id: "go-module",
        path: ".",
        identity: "go.mod",
        name: "github.com/acme/tool",
      },
    ];
    expect(nativePackageSteps(project(entries))).toEqual([]);
    expect(nativeInstallLines(project(entries))).toEqual([
      "`composer require acme/tool`",
      "`go get github.com/acme/tool@v1.2.3`",
    ]);
  });

  it("uses direct upstream publishing commands and exposes only their actual credentials", () => {
    const entries = [
      cargo,
      {
        id: "nuget",
        path: "dotnet",
        identity: "Tool.csproj",
        name: "Acme.Tool",
        versionCommand: "dotnet msbuild -getProperty:Version Tool.csproj",
      },
    ];
    const jobs = nativePublishJobs(
      project(entries),
      "release-assets",
      "${{ needs.gate.outputs.sha }}",
    );
    expect(jobs["publish-cargo"]?.steps).toContainEqual(
      expect.objectContaining({ run: expect.stringContaining("cargo publish") }),
    );
    expect(jobs["publish-nuget"]?.steps).toContainEqual(
      expect.objectContaining({ run: expect.stringContaining("dotnet nuget push") }),
    );
    expect(jobs["publish-nuget"]?.steps).toContainEqual(
      expect.objectContaining({
        uses: "actions/setup-dotnet@v5",
        with: { "dotnet-version": "8.0.x" },
      }),
    );
    expect(nativeRegistryRows(project(entries)).map((row) => row.secrets)).toEqual([
      ["CARGO_REGISTRY_TOKEN"],
      ["NUGET_API_KEY"],
    ]);
    expect(jobs["publish-cargo"]?.needs).toEqual(["gate", "package"]);
    expect(jobs["publish-cargo"]?.if).toBe("needs.gate.outputs.cargo == 'true'");
    expect(jobs["publish-cargo"]?.steps).not.toContainEqual(
      expect.objectContaining({ uses: "dtolnay/rust-toolchain@stable" }),
    );
  });

  it("builds a gem from its package directory before moving the resulting asset", () => {
    const steps = nativePackageSteps(
      project([
        {
          id: "rubygems",
          path: "native/ruby",
          identity: "acme.gemspec",
          name: "acme",
          versionCommand: "ruby -e 'puts 1.2.3'",
        },
      ]),
    );
    expect(steps[1]?.run).toContain("(cd 'native/ruby' && gem build --strict 'acme.gemspec')");
    expect(steps[1]?.run).toContain("mv 'native/ruby/acme-1.2.3.gem'");
  });
});
