import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Operation, Project, SurfaceId } from "../model.js";
import { buildPlan } from "../project/plan.js";
import { surface as claude } from "./claude.js";
import { surface as npm } from "./npm.js";
import { MCP_NAME_BEGIN, MCP_NAME_END, surface as pypi } from "./pypi.js";
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

  it("makes a Python npm package a thin uvx launcher for its canonical PyPI distribution", () => {
    const python = project(["npm", "pypi", "cli", "mcp"], {
      tool: { ...project([]).tool, binding: "python", surfaces: ["npm", "pypi", "cli", "mcp"] },
    });
    const files = npm.plan(python);
    const launcher = files.find((file) => file.path === "bin/hello.mjs");
    const packageJson = files.find((file) => file.path === "package.json");
    if (launcher?.kind !== "file" || packageJson?.kind !== "merge") {
      throw new Error("expected a launcher and package metadata");
    }
    expect(launcher.content).toContain('spawnSync("uvx", ["--from", "hello==0.1.0", "hello"');
    expect(launcher.content).toContain("...process.argv.slice(2)");
    expect(packageJson.patch).toMatchObject({
      name: "hello",
      version: "0.1.0",
      bin: { hello: "./bin/hello.mjs" },
      files: ["bin", "README.md", "LICENSE"],
    });
    expect(region(python)).toContain(
      "requires `uv`, and `hello` delegates to `uvx --from hello==0.1.0 hello`",
    );
  });

  it("ships the built web page in Python's prebuilt wheel before release publication", () => {
    const python = project(["pypi", "web"], {
      tool: { ...project([]).tool, binding: "python", surfaces: ["pypi", "web"] },
    });
    const [file] = pypi.plan(python);
    if (file?.kind !== "merge") throw new Error("expected Python package metadata");
    expect(file.patch).toMatchObject({
      tool: {
        hatch: {
          build: {
            artifacts: ["web/dist/**"],
            targets: {
              wheel: {
                "only-include": ["src/hello", "web/dist"],
                sources: { src: "", "web/dist": "hello/web" },
              },
            },
          },
        },
      },
    });
    expect(JSON.stringify(file.patch)).not.toContain("force-include");
  });
});

const uv = spawnSync("uv", ["--version"], { encoding: "utf8" }).status === 0;

describe.skipIf(!uv)("Python release source", () => {
  it("stages the built page and metadata from the canonical sdist for a uv bundle", () => {
    const root = mkdtempSync(join(tmpdir(), "toolfactory-python-sdist-"));
    mkdirSync(join(root, "src", "hello"), { recursive: true });
    mkdirSync(join(root, "web", "dist"), { recursive: true });
    writeFileSync(
      join(root, "pyproject.toml"),
      `[project]
name = "hello"
version = "0.1.0"
readme = "README.md"

[build-system]
requires = ["hatchling"]
build-backend = "hatchling.build"

[tool.hatch.build]
artifacts = ["web/dist/**"]

[tool.hatch.build.targets.wheel]
packages = ["src/hello"]
only-include = ["src/hello", "web/dist"]

[tool.hatch.build.targets.wheel.sources]
src = ""
"web/dist" = "hello/web"

[tool.hatch.build.targets.sdist]
only-include = ["pyproject.toml", "README.md", "LICENSE", "src/hello", "web/dist"]
`,
    );
    writeFileSync(join(root, "README.md"), "# hello\n");
    writeFileSync(join(root, "LICENSE"), "MIT\n");
    writeFileSync(join(root, ".gitignore"), "dist/\n");
    writeFileSync(join(root, "src", "hello", "__init__.py"), "");
    mkdirSync(join(root, "web", "dist", "assets"), { recursive: true });
    writeFileSync(
      join(root, "web", "dist", "index.html"),
      '<link rel="stylesheet" href="assets/app.css"><script src="assets/app.js"></script>\n',
    );
    writeFileSync(join(root, "web", "dist", "assets", "app.css"), "main{color:#000}\n");
    writeFileSync(join(root, "web", "dist", "assets", "app.js"), "console.log('hello')\n");
    const build = spawnSync("uv", ["build", "--out-dir", "dist/release/pypi"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(build.status, build.stderr).toBe(0);
    const wheel = spawnSync(
      "unzip",
      ["-l", join(root, "dist", "release", "pypi", "hello-0.1.0-py2.py3-none-any.whl")],
      { encoding: "utf8" },
    );
    expect(wheel.status, wheel.stderr).toBe(0);
    expect(wheel.stdout).toContain("hello/web/assets/app.css");
    expect(wheel.stdout).toContain("hello/web/assets/app.js");
    const stage = join(root, "dist", "mcpb");
    mkdirSync(stage, { recursive: true });
    const extract = spawnSync(
      "tar",
      [
        "-xzf",
        join(root, "dist", "release", "pypi", "hello-0.1.0.tar.gz"),
        "-C",
        stage,
        "--strip-components=1",
      ],
      { encoding: "utf8" },
    );
    expect(extract.status, extract.stderr).toBe(0);
    const sync = spawnSync("uv", ["sync", "--quiet", "--no-dev"], { cwd: stage, encoding: "utf8" });
    expect(sync.status, sync.stderr).toBe(0);
    expect(existsSync(join(stage, "README.md"))).toBe(true);
    expect(existsSync(join(stage, "LICENSE"))).toBe(true);
    expect(existsSync(join(stage, "web", "dist", "index.html"))).toBe(true);
    expect(existsSync(join(stage, "web", "dist", "assets", "app.css"))).toBe(true);
    expect(existsSync(join(stage, "web", "dist", "assets", "app.js"))).toBe(true);
  });
});

describe("claude", () => {
  it("makes the repository its own single-plugin marketplace", () => {
    const files = claude.plan(project(["claude", "mcp"]));
    const file = files.find((entry) => entry.path === ".claude-plugin/marketplace.json");
    if (file?.kind !== "merge") throw new Error("expected a merge file");
    expect(file.patch).toMatchObject({
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
      "[![Agent Skill](https://img.shields.io/badge/Agent_Skill-available-5B5BD6)](https://github.com/GoatInAHat/Hello-Tool)",
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
    // The extension's three channels — unpacked from a checkout, release assets (including an
    // optional signed XPI), and store listings — and the pairing step that ends each.
    expect(body).toContain("Load unpacked → `hosts/browser/.output/chrome-mv3`");
    expect(body).toContain("web-ext run");
    expect(body).toContain(
      "`hello-0.1.0-chrome.zip`, `hello-0.1.0-firefox.zip`, `hello-0.1.0-edge.zip`",
    );
    expect(body).toContain(
      "When Firefox signing credentials are configured, it also attaches a\n  Mozilla-signed `.xpi`",
    );
    expect(body).not.toContain("Chrome no longer keeps side-loaded unpacked");
    expect(body).toContain("`npx -y hello mcp --http --pair`");
  });

  it("names the one command that opens the web app, and only when that surface is selected", () => {
    expect(region(project(["mcp", "web"]))).toContain("`npx -y hello mcp --http --open`");
    expect(region(project(["mcp"]))).not.toContain("--http --open");
  });

  it("carries pypi's mcp-name region beside its own, in one README the plan merges", () => {
    const surfaces: SurfaceId[] = ["pypi", "mcp-registry"];
    const python = project(surfaces, {
      root: "/nonexistent",
      tool: { ...project(surfaces).tool, binding: "python" },
    });
    const file = buildPlan(python).find((planned) => planned.path === "README.md");
    if (file?.kind !== "region") throw new Error("expected a region file");
    expect(file.regions.map((entry) => entry.begin).sort()).toEqual(
      [INSTALL_BEGIN, MCP_NAME_BEGIN].sort(),
    );
    expect(file.template).toContain(`${INSTALL_BEGIN}\n${INSTALL_END}`);
    expect(file.template).toContain(`${MCP_NAME_BEGIN}\n${MCP_NAME_END}`);
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
