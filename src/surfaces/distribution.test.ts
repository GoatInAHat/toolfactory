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
    // The MCP line carries both first-party install badges once a package registry is selected,
    // computed from the same unpinned `npx -y hello mcp` launch as the text line.
    expect(body).toContain(
      "https://vscode.dev/redirect/mcp/install?name=hello&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22hello%22%2C%22mcp%22%5D%7D",
    );
    expect(body).toContain("https://cursor.com/en/install-mcp?name=hello&config=");
    expect(body).toContain("https://cursor.com/deeplink/mcp-install-dark.svg");
    expect(body).toContain("`claude plugin marketplace add GoatInAHat/Hello-Tool`");
    expect(body).toContain("`claude plugin install hello@hello`");
    expect(body).toContain("`npm install hello`");
    expect(body).not.toContain("openclaw");
  });

  it("adds the Codex, Gemini, MCPB and browser-extension lines, and skips the badges without a registry", () => {
    const body = region(project(["mcp", "codex", "gemini", "mcpb", "browser-extension"]));
    expect(body).not.toContain("vscode.dev/redirect/mcp/install");
    expect(body).not.toContain("cursor.com/en/install-mcp");
    expect(body).toContain("`codex plugin marketplace add GoatInAHat/Hello-Tool`");
    expect(body).toContain("`codex plugin add hello@hello`");
    expect(body).toContain("`gemini extensions install https://github.com/GoatInAHat/Hello-Tool`");
    expect(body).toContain(
      "download `hello.mcpb` from the GitHub Release and double-click to install",
    );
    // The extension's three channels — unpacked from a checkout, the release assets (only the
    // signed xpi installs itself), the store listings — and the pairing step that ends each.
    expect(body).toContain("Load unpacked → `hosts/browser/.output/chrome-mv3`");
    expect(body).toContain("web-ext run");
    expect(body).toContain(
      "`hello-0.1.0-chrome.zip`, `hello-0.1.0-firefox.zip`, `hello-0.1.0-edge.zip`",
    );
    expect(body).toContain("Mozilla-signed `.xpi`");
    expect(body).toContain("`npx -y hello mcp --http --pair`");
  });

  it("falls back to the local checkout when the identity carries no GitHub repository", () => {
    const surfaces: SurfaceId[] = [
      "skill",
      "claude",
      "codex",
      "gemini",
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
    expect(local).toContain("`codex plugin marketplace add .`");
    expect(local).toContain("`gemini extensions link .` from a checkout");
    expect(local).toContain("`hermes plugins install file://$PWD#hosts/hermes/hello_hermes`");
    expect(local).toContain("openclaw plugins install --link hosts/openclaw");
    expect(local).toContain("openclaw plugins install clawhub:openclaw-plugin-hello");
    expect(local).toContain("dsh plugin --profile <profile> add ./hosts/dsh");
    expect(local).toContain("`uv add hello`");
  });
});
