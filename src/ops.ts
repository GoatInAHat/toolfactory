/**
 * toolfactory's own operations. toolfactory is a tool built with toolfactory: this file is
 * the author-owned operation module, and `src/toolfactory/{cli,mcp}.ts` are generated from
 * it by `toolfactory build`, exactly as for any other tool.
 */
import { z } from "zod";
import * as commands from "./commands.js";
import { BINDINGS, SURFACE_IDS } from "./model.js";
import { operation } from "./toolfactory/types.js";

const root = z
  .string()
  .default(".")
  .describe("Project root (directory containing dev.toolfactory/)");
const surfaceId = z.enum(SURFACE_IDS);

export const operations = [
  operation({
    name: "init",
    description:
      "Create a new tool: dev.toolfactory/tool.json, the authored identity file, the kernel scaffold for the chosen language, and the first build of every selected surface.",
    input: z.object({
      root,
      name: z
        .string()
        .describe("Tool name: lowercase letters, digits, hyphens, dots (Agent Plugins rule)"),
      binding: z.enum(BINDINGS).describe("Language of the core logic: typescript or python"),
      surfaces: z.array(surfaceId).min(1).describe("Surfaces to generate"),
      description: z.string().optional().describe("One-line description"),
      license: z.string().optional().describe("SPDX license identifier"),
      repository: z
        .string()
        .optional()
        .describe("Source repository URL (GitHub URL enables the MCP Registry name)"),
      author: z.string().optional().describe("Author name"),
      keywords: z
        .array(z.string())
        .optional()
        .describe(
          "Activation triggers for hosts that key off them (Kiro Powers, Agent Plugins); defaults to [name]",
        ),
      git: z
        .boolean()
        .default(true)
        .describe("git init when the directory is not a repository yet, and make the first commit"),
      setup: z
        .boolean()
        .default(true)
        .describe(
          "Run .agents/setup: render the harness adapters, install the git hooks, install dependencies",
        ),
      repo: z
        .string()
        .optional()
        .describe("owner/name of a GitHub repository to create with gh and push to"),
      public: z.boolean().default(false).describe("Create that repository public, not private"),
      dryRun: z
        .boolean()
        .default(false)
        .describe("Print the gh invocations instead of running them"),
      reviewers: z
        .array(z.string())
        .default([])
        .describe(
          "GitHub logins that must approve a live run, when the repository gets a live tier",
        ),
    }),
    output: z.object({
      written: z.array(z.string()),
      agentConfig: z.object({ setup: z.boolean(), harnesses: z.array(z.string()) }),
      repository: z
        .object({
          repository: z.string(),
          visibility: z.string(),
          topics: z.array(z.string()),
          secrets: z.array(z.string()),
          commands: z.array(z.string()),
          dryRun: z.boolean(),
        })
        .optional(),
      nextSteps: z.array(z.string()),
    }),
    annotations: { idempotentHint: true },
    requires: ["shell", "net", "fs"],
    handler: async (args) => commands.init(args),
  }),
  operation({
    name: "introspect",
    description:
      "Spawn the kernel MCP server, list its tools, and snapshot them to dev.toolfactory/ops.json.",
    input: z.object({ root }),
    output: z.object({ path: z.string(), changed: z.boolean(), operations: z.number() }),
    annotations: { idempotentHint: true },
    handler: async ({ root }) => {
      const { path, changed, ops } = await commands.introspect(root);
      return { path, changed, operations: ops.tools.length };
    },
  }),
  operation({
    name: "build",
    description:
      "Generate every selected surface in-tree from the identity file and the operation snapshot, and refresh the lock.",
    input: z.object({ root }),
    output: z.object({
      written: z.array(z.string()),
      deleted: z.array(z.string()),
      unchanged: z.array(z.string()),
      manual: z.array(z.string()),
      stripped: z
        .array(z.string())
        .describe(
          "Region files whose generated regions were emptied because their surface is no longer selected; the authored remainder stays.",
        ),
    }),
    annotations: { idempotentHint: true },
    handler: async ({ root }) => commands.build(root).result,
  }),
  operation({
    name: "check",
    description:
      "Fail if the operation snapshot or any generated file drifted from the code (the CI drift gate).",
    input: z.object({ root }),
    output: z.object({ ok: z.literal(true) }),
    annotations: { readOnlyHint: true },
    handler: async ({ root }) => {
      await commands.check(root);
      return { ok: true as const };
    },
  }),
  operation({
    name: "validate",
    description:
      "Run each selected surface's own upstream validator (agentskills, claude plugin validate, MCP Inspector, openclaw, hermes, npm pack, uv build).",
    input: z.object({ root, surface: surfaceId.optional().describe("Only this surface") }),
    output: z.object({
      outcomes: z.array(z.object({ label: z.string(), command: z.string(), ok: z.boolean() })),
    }),
    annotations: { readOnlyHint: true },
    handler: async ({ root, surface }) => ({
      outcomes: commands
        .validate(root, surface)
        .map(({ label, command, ok }) => ({ label, command, ok })),
    }),
  }),
  operation({
    name: "coverage",
    description:
      "The operation × surface verdict matrix: native, bridged, degraded, or excluded, with reasons.",
    input: z.object({ root }),
    output: z.object({
      surfaces: z.array(z.string()),
      rows: z.array(
        z.object({
          operation: z.string(),
          verdicts: z.record(
            z.string(),
            z.object({ kind: z.string(), reason: z.string().optional() }),
          ),
        }),
      ),
    }),
    annotations: { readOnlyHint: true },
    handler: async ({ root }) => commands.coverage(root),
  }),
  operation({
    name: "adopt",
    description:
      "Stop regenerating one file; it becomes the author's (recorded as manual in the lock).",
    input: z.object({ root, path: z.string().describe("Repo-relative path of a generated file") }),
    output: z.object({ adopted: z.string() }),
    handler: async ({ root, path }) => {
      commands.adopt(root, path);
      return { adopted: path };
    },
  }),
  operation({
    name: "unadopt",
    description: "Return an adopted file to toolfactory and regenerate it.",
    input: z.object({ root, path: z.string().describe("Repo-relative path of an adopted file") }),
    output: z.object({ regenerated: z.string() }),
    handler: async ({ root, path }) => {
      commands.unadopt(root, path);
      return { regenerated: path };
    },
  }),
  operation({
    name: "eject",
    description: "Adopt every file a surface owns, so the author takes it over entirely.",
    input: z.object({ root, surface: surfaceId }),
    output: z.object({ adopted: z.array(z.string()) }),
    handler: async ({ root, surface }) => ({ adopted: commands.eject(root, surface) }),
  }),
  operation({
    name: "bootstrap-repo",
    description:
      "Prepare the GitHub repository for the live-test tier: create the `live-tests` environment with required reviewers, then set every required sensitive config key as an environment secret from the local .env.",
    input: z.object({
      root,
      reviewers: z
        .array(z.string())
        .default([])
        .describe("GitHub logins that must approve a live run"),
      dryRun: z
        .boolean()
        .default(false)
        .describe("Print the gh invocations instead of running them"),
    }),
    output: z.object({
      repository: z.string(),
      environment: z.string(),
      reviewers: z.array(z.string()),
      secrets: z.array(z.string()),
      commands: z.array(z.string()),
      dryRun: z.boolean(),
    }),
    requires: ["shell", "net", "secret"],
    handler: async (args) => commands.bootstrapRepo(args),
  }),
  operation({
    name: "gate",
    description:
      "Run the gate here, in order: build, the drift check, every selected surface's upstream validator, the author's checks and tests, and the credential-free host end-to-end. The same step list the generated ci.yml renders, so a project with no CI has the identical gate.",
    input: z.object({ root }),
    output: z.object({
      steps: z.array(z.object({ name: z.string(), ok: z.boolean(), durationMs: z.number() })),
    }),
    requires: ["shell", "net", "fs"],
    handler: async ({ root }) => commands.gate(root),
  }),
  operation({
    name: "package",
    description:
      "Build every release asset into dist/release/ — npm tarball, Python distributions, OpenClaw plugin tarball, plugin bundle zip, web build, coverage — by the same steps the release workflow's package job runs. Publishing stays a CI concern.",
    input: z.object({ root }),
    output: z.object({
      steps: z.array(z.object({ name: z.string(), ok: z.boolean(), durationMs: z.number() })),
    }),
    requires: ["shell", "net", "fs"],
    handler: async ({ root }) => commands.packageRelease(root),
  }),
  operation({
    name: "doctor",
    description:
      "Report which upstream CLIs this machine can delegate to (git, gh, npm, uv, claude, openclaw, clawhub, hermes, uvx, agentskills, MCP Inspector, docker).",
    input: z.object({}),
    output: z.object({
      toolfactory: z.string(),
      node: z.string(),
      tools: z.record(z.string(), z.string()),
    }),
    annotations: { readOnlyHint: true },
    handler: async () => commands.doctor(),
  }),
];
