/**
 * The shared plane. Every generator and command works only with these types.
 *
 * Identity is authored in one file the ecosystem already defines (plugin.json,
 * package.json, pyproject.toml, or a host manifest). Operations come from the
 * author's code, snapshotted from the kernel MCP server's `tools/list`. The
 * rest is derived and written in-tree, tracked by a lock file.
 */
import { z } from "zod";

export const CAPABILITIES = [
  "net",
  "fs",
  "shell",
  "secret",
  "browser",
  "model",
  "user-input",
  "channel",
] as const;
export type Capability = (typeof CAPABILITIES)[number];
export const PORTABLE_CAPABILITIES: ReadonlySet<Capability> = new Set([
  "net",
  "fs",
  "shell",
  "secret",
]);

export const SURFACE_IDS = [
  "skill",
  "agent-plugins",
  "claude",
  "codex",
  "cursor",
  "mcp",
  "mcp-registry",
  "cli",
  "npm",
  "pypi",
  "openclaw-native",
  "hermes-native",
  "clawhub",
  "web",
  "dsh",
  "workflows",
  "agents",
  "readme",
  "gemini",
  "mcpb",
] as const;
export type SurfaceId = (typeof SURFACE_IDS)[number];

export const BINDINGS = ["typescript", "python"] as const;
export type Binding = (typeof BINDINGS)[number];

/** Package managers the generated workflows know how to drive; read from package.json `packageManager`. */
export const PACKAGE_MANAGERS = ["npm", "pnpm"] as const;
export type PackageManager = (typeof PACKAGE_MANAGERS)[number];

/** Agent Plugins 1.0.0 name rule; the canonical name N every projection derives from. */
export const NAME_PATTERN = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;

const jsonObject = z.record(z.string(), z.unknown());

/** `dev.toolfactory/tool.json` — the one file toolfactory owns. */
export const ToolConfigSchema = z
  .object({
    $schema: z.string().optional(),
    schemaVersion: z.literal(1),
    identity: z
      .string()
      .describe(
        "Repo-relative path of the authored identity file (plugin.json, package.json, pyproject.toml, or a host manifest).",
      ),
    binding: z.enum(BINDINGS).describe("Language of the core logic and its kernel surfaces."),
    surfaces: z
      .array(z.enum(SURFACE_IDS))
      .min(1)
      .describe("Selected surfaces. A file exists iff a selected surface owns it."),
    kernel: z
      .object({
        command: z.string(),
        args: z.array(z.string()).default([]),
      })
      .optional()
      .describe("How to spawn the kernel MCP server for introspection; defaults from the binding."),
    bundle: z
      .object({ runtime: z.enum(["package", "bundled"]).default("package") })
      .default({ runtime: "package" })
      .describe(
        "How mcp.json reaches the kernel: a published package (npx/uvx) or a committed single-file build.",
      ),
    config: jsonObject
      .optional()
      .refine(
        (schema) =>
          Object.values(
            (schema?.properties ?? {}) as Record<string, Record<string, unknown>>,
          ).every(
            (property) =>
              !(property["x-toolfactory"] as { sensitive?: boolean } | undefined)?.sensitive ||
              property.default === undefined,
          ),
        "A sensitive config property must not declare a default: it would be committed into every manifest.",
      )
      .describe(
        "JSON Schema 2020-12 object for the tool's configuration; mark secrets with x-toolfactory.sensitive.",
      ),
    tests: z
      .object({ examples: z.record(z.string(), jsonObject).default({}) })
      .default({ examples: {} })
      .describe("Example arguments per operation, used by the generated surface-smoke tests."),
    npm: z.object({ scope: z.string().optional() }).optional(),
    codex: z.object({ interface: jsonObject.optional() }).optional(),
    mcpb: z
      .object({ privacyPolicies: z.array(z.string()).optional() })
      .optional()
      .describe(
        "Privacy-policy URLs of the services this tool talks to; Anthropic's Connectors Directory submission requires them in the MCPB manifest.",
      ),
    hermes: z.object({ toolset: z.string().optional() }).optional(),
    openclaw: z
      .object({
        registers: z
          .array(
            z.object({
              api: z
                .string()
                .describe("OpenClawPluginApi method, e.g. registerRealtimeVoiceProvider"),
              contract: z
                .string()
                .describe("openclaw.plugin.json contracts key, e.g. realtimeVoiceProviders"),
              ids: z.array(z.string()).default([]).describe("Ids registered under that contract"),
            }),
          )
          .optional()
          .describe(
            "Host registrations the plugin makes beyond tools; one declaration drives the manifest contracts, the plugin inspector's expectations and the generated test.",
          ),
        activation: jsonObject
          .optional()
          .describe("openclaw.plugin.json activation; default onStartup."),
        pluginApi: z
          .string()
          .optional()
          .describe("Plugin API range for compat.pluginApi and the openclaw peer dependency."),
        dependencies: z.record(z.string(), z.string()).optional(),
        peerDependencies: z.record(z.string(), z.string()).optional(),
        devDependencies: z.record(z.string(), z.string()).optional(),
      })
      .optional(),
  })
  .strict();
export type ToolConfig = z.infer<typeof ToolConfigSchema>;

export interface Author {
  name?: string;
  email?: string;
  url?: string;
}

/** Authored once, in the identity file; projected everywhere else. */
export interface Identity {
  name: string;
  version?: string;
  description?: string;
  author?: Author;
  homepage?: string;
  repository?: string;
  license?: string;
  keywords?: string[];
}

/** One MCP tool definition as returned by `tools/list`, plus the requirements it declares. */
export interface Operation {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  requires: Capability[];
}

export type VerdictKind = "native" | "bridged" | "degraded" | "excluded";
export interface Verdict {
  kind: VerdictKind;
  /** Machine-readable reason, e.g. `excluded:mcp-no-host-capabilities`. Empty for `native`. */
  reason?: string;
}

/** A whole generated file. */
export interface FullFile {
  kind: "file";
  path: string;
  content: string;
  mode?: number;
  /**
   * A build output: generated and locked like any other file, but not expected to exist.
   * `check` does not report it missing (it is gitignored and rebuilt), only stale when present.
   */
  output?: true;
  /** `content` is a link target, not file bytes: the file is a symbolic link (`.agents/skills/<N>`). */
  symlink?: true;
}

export interface Region {
  begin: string;
  end: string;
  content: string;
}

/**
 * A file the author owns, in which toolfactory maintains one or more delimited regions.
 * `template` is written when the file does not exist and must contain every marker.
 */
export interface RegionFile {
  kind: "region";
  path: string;
  regions: Region[];
  template: string;
}

/**
 * A structured file shared with the author (package.json, pyproject.toml): toolfactory
 * owns exactly the keys in `patch` (deep-merged) and leaves every other key alone.
 */
export interface MergeFile {
  kind: "merge";
  path: string;
  format: "json" | "toml";
  patch: Record<string, unknown>;
  /** Dotted paths inside `patch` whose object toolfactory owns whole: replaced, never merged. */
  owned?: string[];
}

export type PlannedFile = FullFile | RegionFile | MergeFile;

export interface Command {
  /** Human label used in reports. */
  label: string;
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface Project {
  root: string;
  tool: ToolConfig;
  identity: Identity;
  /** Unknown top-level keys of the identity file, preserved on rewrite. */
  identityExtra: Record<string, unknown>;
  operations: Operation[];
  toolfactoryVersion: string;
  /** From the root package.json `packageManager` field; npm when absent. */
  packageManager?: PackageManager;
}

export interface Surface {
  id: SurfaceId;
  /** Pure: no I/O. Everything this surface writes for the project. */
  plan(project: Project): PlannedFile[];
  /** Upstream validators to run for this surface (tier 1). */
  validate?(project: Project): Command[];
  /** Per-operation verdict on this surface. Default: portable ⇒ native, else excluded. */
  verdict?(operation: Operation, project: Project): Verdict;
  /**
   * Surfaces this one reads the output of. A selection that omits one is refused by name at
   * plan time instead of emitting an artifact that points at a file nobody writes.
   */
  requires?: SurfaceId[];
}

export function isPortable(operation: Operation): boolean {
  return operation.requires.every((capability) => PORTABLE_CAPABILITIES.has(capability));
}
