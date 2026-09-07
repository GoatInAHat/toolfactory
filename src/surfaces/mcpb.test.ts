import { describe, expect, it } from "vitest";
import { NODE_ENGINES } from "../bindings/typescript.js";
import type { Operation, Project } from "../model.js";
import { MCPB_PIN, surface as mcpb, UV_MANIFEST_VERSION } from "./mcpb.js";

const echo: Operation = {
  name: "echo",
  description: "Echoes.",
  inputSchema: { type: "object" },
  requires: [],
};
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
    surfaces: ["mcp", "npm", "mcpb"],
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
  identity: {
    name: "hello.tool",
    version: "0.1.0",
    description: "Says hello.",
    author: { name: "Ada" },
    homepage: "https://example.com",
    repository: "https://github.com/ada/hello",
    license: "MIT",
  },
  identityExtra: {},
  operations: [echo, browse],
  toolfactoryVersion: "0.1.0",
  packageManager: "npm",
};

const [manifestFile, ...rest] = mcpb.plan(project);
if (manifestFile?.kind !== "file") throw new Error("expected one whole file");
const manifest = JSON.parse(manifestFile.content) as Record<string, unknown>;

describe("mcpb", () => {
  it("is one manifest: the built kernel entry under ${__dirname}, config as user_config, the operations MCP serves", () => {
    expect(rest).toEqual([]);
    expect(manifestFile.path).toBe("hosts/mcpb/manifest.json");
    expect(manifest).toEqual({
      manifest_version: "0.2",
      name: "hello.tool",
      display_name: "hello.tool",
      version: "0.1.0",
      description: "Says hello.",
      author: { name: "Ada" },
      homepage: "https://example.com",
      documentation: "https://example.com",
      repository: { type: "git", url: "https://github.com/ada/hello" },
      license: "MIT",
      server: {
        type: "node",
        // The npm tarball's built entry, the same file the mcp-registry Dockerfile runs.
        entry_point: "dist/toolfactory/mcp.js",
        mcp_config: {
          command: "node",
          args: ["${__dirname}/dist/toolfactory/mcp.js"],
          // Claude Desktop substitutes these from the settings UI `user_config` generates.
          env: { APIKEY: "${user_config.apiKey}", REGION: "${user_config.region}" },
        },
      },
      // `browse` needs a host capability MCP cannot serve, so the install UI must not list it.
      tools: [{ name: "echo", description: "Echoes." }],
      user_config: {
        apiKey: {
          type: "string",
          title: "API key",
          description: "apiKey",
          required: true,
          sensitive: true,
        },
        region: { type: "string", title: "region", description: "Service region." },
      },
      compatibility: { runtimes: { node: NODE_ENGINES } },
    });
    // No privacy_policies unless tool.json names them (see the module docs).
    expect(manifestFile.content).not.toContain("privacy_policies");
  });

  it("uses the official v0.4 uv bundle contract for Python, with its canonical PyPI surface", () => {
    const pythonProject: Project = {
      ...project,
      tool: { ...project.tool, binding: "python", surfaces: ["mcp", "pypi", "mcpb"] },
    };
    const [file] = mcpb.plan(pythonProject);
    if (file?.kind !== "file") throw new Error("expected one whole file");
    expect(JSON.parse(file.content)).toMatchObject({
      manifest_version: UV_MANIFEST_VERSION,
      server: {
        type: "uv",
        entry_point: "src/hello_tool/toolfactory/mcp.py",
        mcp_config: {
          command: "uv",
          args: [
            "run",
            "--directory",
            "${__dirname}",
            "python",
            "-m",
            "hello_tool.toolfactory.mcp",
          ],
        },
      },
      compatibility: { runtimes: { python: ">=3.11" } },
    });
    expect(() =>
      mcpb.plan({ ...pythonProject, tool: { ...pythonProject.tool, surfaces: ["mcp", "mcpb"] } }),
    ).toThrow(/requires the "pypi" surface/);
  });

  it("declares the kernel's own Node floor and validates with the pinned official CLI", () => {
    expect(mcpb.validate?.(project)).toEqual([
      {
        label: "mcpb validate",
        command: "npx",
        args: ["-y", `@anthropic-ai/mcpb@${MCPB_PIN}`, "validate", "hosts/mcpb/manifest.json"],
        cwd: "/repo",
      },
    ]);
  });
});
