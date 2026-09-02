import { describe, expect, it } from "vitest";
import type { Operation, Project } from "../model.js";
import { GEMINI_PIN, surface as gemini } from "./gemini.js";

const echo: Operation = { name: "echo", inputSchema: { type: "object" }, requires: [] };
const browse: Operation = {
  name: "browse",
  inputSchema: { type: "object" },
  requires: ["browser"],
};

const project: Project = {
  root: "/repo",
  tool: {
    schemaVersion: 1,
    identity: "plugin.json",
    binding: "typescript",
    surfaces: ["mcp", "npm", "skill", "gemini"],
    bundle: { runtime: "package" },
    tests: { examples: {} },
    config: {
      properties: {
        apiKey: { type: "string", title: "API key", "x-toolfactory": { sensitive: true } },
        region: { type: "string", description: "Service region." },
      },
      required: ["apiKey"],
    },
  },
  identity: { name: "hello.tool", version: "0.1.0", description: "Says hello.", license: "MIT" },
  identityExtra: {},
  operations: [echo, browse],
  toolfactoryVersion: "0.1.0",
  packageManager: "npm",
};

const [manifestFile, ...rest] = gemini.plan(project);
if (manifestFile?.kind !== "file") throw new Error("expected one whole file");
const manifest = JSON.parse(manifestFile.content) as Record<string, unknown>;

describe("gemini", () => {
  it("is one root manifest: a dashed name, the kernel launch, AGENTS.md as the context file", () => {
    expect(rest).toEqual([]);
    expect(manifestFile.path).toBe("gemini-extension.json");
    expect(manifest).toEqual({
      // Gemini rejects anything outside [A-Za-z0-9-], so the dot in N becomes a dash.
      name: "hello-tool",
      version: "0.1.0",
      description: "Says hello.",
      mcpServers: { "hello.tool": { command: "npx", args: ["-y", "hello.tool@0.1.0", "mcp"] } },
      // Not GEMINI.md: the always-on `agents` surface writes AGENTS.md, and Gemini's own
      // validator fails when the named context file is missing.
      contextFileName: "AGENTS.md",
      // Gemini passes an extension no shell environment beyond what `settings[].envVar`
      // allowlists, so every config key is declared here and none in an `env` map.
      settings: [
        { name: "API key", description: "apiKey", envVar: "APIKEY", sensitive: true },
        { name: "region", description: "Service region.", envVar: "REGION" },
      ],
    });
    // `skills/` and `commands/` are auto-discovered from the extension root; no key names them.
    expect(manifestFile.content).not.toContain('"skills"');
  });

  it("validates through Gemini's own manifest validator, and carries only MCP tool calls", () => {
    expect(gemini.validate?.(project)).toEqual([
      {
        label: "gemini extensions validate",
        command: "npx",
        args: ["-y", `@google/gemini-cli@${GEMINI_PIN}`, "extensions", "validate", "."],
        cwd: "/repo",
      },
    ]);

    expect(gemini.verdict?.(echo, project)).toEqual({ kind: "native" });
    expect(gemini.verdict?.(browse, project)).toEqual({
      kind: "excluded",
      reason: "excluded:mcp-no-host-capabilities",
    });
  });
});
