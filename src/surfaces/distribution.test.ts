import { describe, expect, it } from "vitest";
import type { Operation, Project, SurfaceId } from "../model.js";
import { surface as claude } from "./claude.js";
import { surface as npm } from "./npm.js";
import { INSTALL_BEGIN, INSTALL_END, surface as readme } from "./readme.js";

const echo: Operation = { name: "echo", inputSchema: { type: "object" }, requires: [] };

function project(surfaces: SurfaceId[], overrides: Partial<Project> = {}): Project {
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
    identity: {
      name: "hello",
      version: "0.1.0",
      description: "Say hello",
      author: { name: "GoatInAHat" },
      repository: "https://github.com/GoatInAHat/Hello-Tool",
    },
    identityExtra: {},
    operations: [echo],
    toolfactoryVersion: "0.1.0",
    packageManager: "npm",
    ...overrides,
  };
}

function region(target: Project): string {
  const [file] = readme.plan(target);
  if (file?.kind !== "region") throw new Error("expected a region file");
  return file.regions[0]?.content ?? "";
}

describe("npm", () => {
  it("writes the repository in npm's object form, preserving the slug's case, and lints with publint", () => {
    const [file] = npm.plan(project(["npm", "cli"]));
    if (file?.kind !== "merge") throw new Error("expected a merge file");
    expect(file.patch.repository).toEqual({
      type: "git",
      url: "git+https://github.com/GoatInAHat/Hello-Tool.git",
    });
    expect(npm.validate?.(project(["npm"])).map((command) => command.args.join(" "))).toContain(
      "--yes publint --strict",
    );
  });
});

describe("claude", () => {
  it("makes the repository its own single-plugin marketplace", () => {
    const files = claude.plan(project(["claude", "mcp"]));
    const file = files.find((entry) => entry.path === ".claude-plugin/marketplace.json");
    if (file?.kind !== "file") throw new Error("expected a whole file");
    expect(JSON.parse(file.content)).toMatchObject({
      name: "hello",
      owner: { name: "GoatInAHat" },
      plugins: [{ name: "hello", source: "./", description: "Say hello" }],
    });
  });
});

describe("readme", () => {
  it("plans one install line per selected surface inside an author-owned template", () => {
    const [file] = readme.plan(project(["skill", "mcp", "claude", "npm"]));
    if (file?.kind !== "region") throw new Error("expected a region file");
    expect(file.path).toBe("README.md");
    expect(file.template).toContain(`${INSTALL_BEGIN}\n${INSTALL_END}`);
    const body = file.regions[0]?.content ?? "";
    expect(body).toContain("## Install");
    expect(body).toContain("`npx skills add GoatInAHat/Hello-Tool`");
    expect(body).toContain(
      "[![skills.sh](https://skills.sh/b/GoatInAHat/Hello-Tool)](https://skills.sh/GoatInAHat/Hello-Tool)",
    );
    expect(body).toContain("`npx -y hello mcp`");
    expect(body).toContain("`claude plugin marketplace add GoatInAHat/Hello-Tool`");
    expect(body).toContain("`claude plugin install hello@hello`");
    expect(body).toContain("`npm install hello`");
    expect(body).not.toContain("openclaw");
  });

  it("falls back to the local checkout when the identity carries no GitHub repository", () => {
    const surfaces: SurfaceId[] = [
      "skill",
      "claude",
      "openclaw-native",
      "hermes-native",
      "clawhub",
      "dsh",
      "pypi",
    ];
    const local = region(
      project(surfaces, {
        identity: { name: "hello", version: "0.1.0", description: "Say hello" },
        tool: { ...project(surfaces).tool, binding: "python" },
      }),
    );
    expect(local).not.toContain("skills.sh");
    expect(local).not.toContain("npx skills add");
    expect(local).toContain("`claude plugin marketplace add .`");
    expect(local).toContain("`hermes plugins install file://$PWD#hosts/hermes/hello_hermes`");
    expect(local).toContain("openclaw plugins install --link hosts/openclaw");
    expect(local).toContain("openclaw plugins install clawhub:openclaw-plugin-hello");
    expect(local).toContain("dsh plugin --profile <profile> add ./hosts/dsh");
    expect(local).toContain("`uv add hello`");
  });
});
