import { describe, expect, it } from "vitest";
import type { Operation, PlannedFile, Project, SurfaceId } from "../model.js";
import {
  AGENTS_BEGIN,
  AGENTS_END,
  IGNORE_PATH,
  reloadLine,
  SETUP_PATH,
  surface,
} from "./agents.js";
import { TEMPLATE_FILES } from "./agents.template.js";

const echo: Operation = { name: "echo", inputSchema: { type: "object" }, requires: [] };

function project(surfaces: SurfaceId[], overrides: Partial<Project["tool"]> = {}): Project {
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
          api_key: { type: "string", description: "key", "x-toolfactory": { sensitive: true } },
        },
        required: ["api_key"],
      },
      ...overrides,
    },
    identity: { name: "hello", version: "0.1.0", description: "Say hello" },
    identityExtra: {},
    operations: [echo],
    toolfactoryVersion: "0.1.0",
    packageManager: "npm",
  };
}

function planned(target: Project, path: string): PlannedFile {
  const file = surface.plan(target).find((candidate) => candidate.path === path);
  if (!file) throw new Error(`the agents surface no longer plans ${path}`);
  return file;
}

function region(target: Project, path: string): string {
  const file = planned(target, path);
  if (file.kind !== "region") throw new Error(`${path} is not a region file`);
  return file.regions[0]?.content ?? "";
}

describe("agents", () => {
  it("plans AGENTS.md as one region under an author-owned bootstrap notice", () => {
    const file = planned(project(["cli", "mcp"]), "AGENTS.md");
    if (file.kind !== "region") throw new Error("expected a region file");
    expect(file.template).toContain("# hello\n");
    expect(file.template).toContain(`${AGENTS_BEGIN}\n${AGENTS_END}`);
    // `.agents/setup` deletes the notice on its first run, so it must sit outside the region a
    // rebuild rewrites, and without the `keep=` slug that makes the template itself keep it.
    const notice = file.template.slice(0, file.template.indexOf(AGENTS_BEGIN));
    expect(notice).toContain("<!-- setup -->");
    expect(notice).not.toContain("keep=");
    const body = file.regions[0]?.content ?? "";
    expect(body).not.toContain(AGENTS_BEGIN);
    for (const verb of ["introspect", "build", "check", "validate", "coverage"]) {
      expect(body).toContain(`npx toolfactory ${verb}`);
    }
    expect(body).toContain("npm run test:live");
    // The reload table and the host worktree commands, both generated from one source each.
    expect(body).toContain("| Claude Code | Reconnect from `/mcp`");
    expect(body).toContain("claude --worktree <name>");
  });

  it("carries only the lines the selected surfaces and binding need", () => {
    const bare = region(
      project(["cli"], { config: { properties: {}, required: [] } }),
      "AGENTS.md",
    );
    expect(bare).not.toContain("test:live");
    expect(bare).not.toContain("plugins install");
    expect(bare).toContain("No host-native surface");

    const hosts = region(
      project(["openclaw-native", "hermes-native", "web", "mcp", "browser-extension"], {
        binding: "python",
      }),
      "AGENTS.md",
    );
    expect(hosts).toContain("openclaw plugins install --link hosts/openclaw --force");
    expect(hosts).toContain("hermes plugins install file://");
    // C7: `hermes gateway restart` is the messaging gateway, not the plugin loader.
    expect(hosts).toContain("only for the\n  messaging gateway daemon");
    expect(hosts).toContain("uv run --with pytest pytest -q tests/test_live.py");
    expect(hosts).toContain("src/hello/ops.py");
    // The extension: how it loads, how it pairs with this checkout's own kernel, how it reloads,
    // and whose job the content script's selectors are.
    expect(hosts).toContain("Load unpacked → `hosts/browser/.output/chrome-mv3`");
    expect(hosts).toContain("`uv run --quiet python -m hello.toolfactory.cli mcp --http --pair`");
    expect(hosts).toContain("selectors are yours to maintain");
    expect(hosts).toContain("wxt dev");
  });

  it("vendors the template's carriers and keeps its head inside the setup region", () => {
    const files = surface.plan(project(["cli"]));
    for (const path of [".agents/sync.py", ".claude/settings.json", ".gitattributes"]) {
      const file = files.find((candidate) => candidate.path === path);
      if (file?.kind !== "file") throw new Error(`${path} is not a whole file`);
      expect(file.content).toBe(TEMPLATE_FILES[path]);
    }
    const setup = region(project(["cli"]), SETUP_PATH);
    expect(setup).toContain('cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"');
    expect(setup).not.toContain("# Project setup goes here");
    // Owner ask #11: a commit cannot leave a generated file stale, with or without CI.
    expect(setup).toContain("npx toolfactory check >/dev/null");
    expect(setup).toContain("npm install --no-audit --no-fund");
  });

  it("owns the agent adapters, the binding's ignores and the build outputs in .gitignore", () => {
    const bare = region(project(["cli"]), IGNORE_PATH);
    const agentBlocks = (TEMPLATE_FILES[IGNORE_PATH] ?? "").split("# ─── Secrets")[0] ?? "";
    for (const line of agentBlocks.split("\n").filter((line) => line.startsWith("/"))) {
      expect(bare).toContain(`\n${line}\n`);
    }
    expect(bare).toContain("\ndev.toolfactory/coverage.json\n");
    expect(bare).not.toContain("web/src/ops.json");
    expect(bare).not.toContain("hosts/*/package-lock.json");
    const hosts = region(project(["openclaw-native", "web", "mcp"]), IGNORE_PATH);
    expect(hosts).toContain("\nhosts/*/package-lock.json\n");
    expect(hosts).toContain("\nweb/src/ops.json\n");
    // The author's half of a fresh file keeps the template's other blocks and no duplicates.
    const template = planned(project(["cli"]), IGNORE_PATH);
    if (template.kind !== "region") throw new Error("expected a region file");
    const author = template.template.slice(template.template.indexOf("# /tf:ignore"));
    expect(author).toContain("*.pem");
    expect(author).not.toContain("node_modules/");
  });

  it("merges MCP servers by name, and never shadows toolfactory's own checkout", () => {
    const file = planned(project(["mcp", "web"]), ".agents/mcp/servers.json");
    if (file.kind !== "merge") throw new Error("expected a merge file");
    expect(file.patch.hello).toEqual({
      command: "node",
      args: ["--import", "tsx", "src/toolfactory/mcp.ts"],
    });
    expect(file.patch.toolfactory).toEqual({ command: "npx", args: ["toolfactory", "mcp"] });
    expect(Object.keys(file.patch)).toEqual(file.owned);
    expect(file.owned).toContain("playwright");
    // Only one repository has the collision: toolfactory's own, where the published package would
    // shadow the checkout entry under the same key.
    const own = project(["mcp"]);
    own.identity.name = "toolfactory";
    const dogfood = planned(own, ".agents/mcp/servers.json");
    if (dogfood.kind !== "merge") throw new Error("expected a merge file");
    expect(Object.keys(dogfood.patch)).toEqual(["toolfactory"]);
    expect(dogfood.patch.toolfactory).toEqual({
      command: "node",
      args: ["--import", "tsx", "src/toolfactory/mcp.ts"],
    });

    // A tool with no server to run registers only the generator that maintains the repo.
    const cliOnly = planned(project(["cli"]), ".agents/mcp/servers.json");
    if (cliOnly.kind !== "merge") throw new Error("expected a merge file");
    expect(Object.keys(cliOnly.patch)).toEqual(["toolfactory"]);
  });

  it("lists the surfaces' submission portals and the Gemini host-install line", () => {
    const body = region(
      project(["mcp", "claude", "agent-plugins", "codex", "gemini"]),
      "AGENTS.md",
    );
    expect(body).toContain("## Listing");
    expect(body).toContain("docker/mcp-registry");
    expect(body).toContain("cline/mcp-marketplace");
    expect(body).toContain("chatmcp/mcpso");
    expect(body).toContain("punkpeye/awesome-mcp-servers");
    expect(body).toContain("claude.com/docs/plugins/submit");
    expect(body).toContain("kiro.dev/powers/submit");
    expect(body).toContain("developers.openai.com/plugins/deploy/submission");
    expect(body).toContain("`gemini extensions link .`");

    // No listing-eligible surface, no section; the bare `cli` project also gets no Gemini bullet.
    const bare = region(project(["cli"]), "AGENTS.md");
    expect(bare).not.toContain("## Listing");
    expect(bare).not.toContain("gemini extensions link");
  });

  it("prints the reload line of the harness it is running inside", () => {
    expect(reloadLine({ CLAUDECODE: "1" })).toContain("reconnect from `/mcp`");
    expect(reloadLine({ HERMES_HOME: "/h" })).toContain("hermes skills trust");
    expect(reloadLine({})).toContain("restart it or use its own reload command");
  });
});
