import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import type { Operation, Project } from "../model.js";
import { DSH_PIN, surface as dsh } from "./dsh.js";

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
    surfaces: ["mcp", "npm", "dsh"],
    bundle: { runtime: "package" },
    tests: { examples: {} },
    config: {
      properties: {
        apiKey: { type: "string", "x-toolfactory": { sensitive: true } },
        region: { type: "string" },
      },
      required: ["apiKey"],
    },
  },
  identity: { name: "hello.tool", version: "0.1.0", license: "MIT" },
  identityExtra: {},
  operations: [echo, browse],
  toolfactoryVersion: "0.1.0",
  packageManager: "npm",
};

const files = Object.fromEntries(
  dsh.plan(project).map((file) => {
    if (file.kind !== "file") throw new Error("expected whole files only");
    return [file.path, file.content];
  }),
);

describe("dsh", () => {
  it("is two shipped files and no code: the bundle manifest and one mcp-client insert row", () => {
    // `dsh.bundle.patch` is DSH's whole acceptance test for a bundle; a dependency would be wrong,
    // because @deepseek-ai/dsh-mcp-client is @deepseek-ai/dsh's own.
    expect(JSON.parse(files["hosts/dsh/package.json"] as string)).toMatchObject({
      name: "hello.tool-dsh",
      version: "0.1.0",
      license: "MIT",
      files: ["cordis.patch.yml"],
      dsh: { bundle: { patch: "./cordis.patch.yml" } },
    });
    expect(JSON.parse(files["hosts/dsh/package.json"] as string).dependencies).toBeUndefined();

    const patch = files["hosts/dsh/cordis.patch.yml"] as string;
    expect(parseYaml(patch, { logLevel: "silent" })).toEqual([
      {
        insert: [
          {
            // serverName is `[A-Za-z0-9_-]{1,32}`, validated at DSH boot: the dot in N is illegal.
            id: "mcp-hello-tool",
            name: "@deepseek-ai/dsh-mcp-client",
            config: {
              serverName: "hello-tool",
              transport: "stdio",
              command: "npx",
              args: ["-y", "hello.tool@0.1.0", "mcp"],
              env: {
                APIKEY: "process.env.APIKEY",
                REGION: "process.env.REGION",
              },
              failOnStartupError: true,
            },
          },
        ],
      },
    ]);
    // DSH scrubs KEY/PASSWORD/SECRET/TOKEN names before spawning, so every config variable is
    // restated as the `!!js` expression DSH evaluates when it loads the patch.
    expect(patch).toContain("APIKEY: !!js process.env.APIKEY");
  });

  it("validates by booting the checkout keylessly, and carries only MCP tool calls", () => {
    // The local row is the same shape against this working tree, and stays out of `files`.
    const local = parseYaml(files["hosts/dsh/cordis.local.patch.yml"] as string, {
      logLevel: "silent",
    });
    expect(local[0].insert[0].config).toMatchObject({
      command: "node",
      args: ["--import", "tsx", "src/toolfactory/mcp.ts"],
    });

    const [command] = dsh.validate?.(project) ?? [];
    expect(command?.command).toBe("sh");
    const script = command?.args[1] ?? "";
    expect(script).toContain(`@deepseek-ai/dsh@${DSH_PIN}`);
    expect(script).toContain("--patch hosts/dsh/cordis.local.patch.yml");
    // Pass signature: everything before the model call is a hard failure, so reaching the missing
    // DeepSeek credential proves the patch, the row, the spawn and `tools/list` all succeeded.
    expect(script).toContain("grep -qF 'MISSING_CREDENTIAL: llm-deepseek'");

    expect(dsh.verdict?.(echo, project)).toEqual({ kind: "native" });
    expect(dsh.verdict?.(browse, project)).toEqual({
      kind: "excluded",
      reason: "excluded:mcp-no-host-capabilities",
    });
  });
});
