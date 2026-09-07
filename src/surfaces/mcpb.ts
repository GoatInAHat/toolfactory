/**
 * MCPB (MCP Bundle): the one-click `.mcpb` Claude Desktop installs, and the only channel
 * Anthropic's Connectors Directory takes a *local* server through.
 *
 * A bundle is a zip whose root is the server plus its dependencies plus a `manifest.json`. That
 * root is a staging tree, not the repository: TypeScript stages the npm tarball with production
 * dependencies, while Python stages its `pyproject.toml` and source for host-managed uv. This
 * surface emits one tracked file — the manifest — and the packaging step copies it in.
 *
 * TypeScript uses `manifest_version` `0.2`, the floor Anthropic's directory submission requires.
 * Python uses v0.4's official `uv` server type, which keeps the bundle portable without shipping
 * an interpreter or a virtual environment.
 *
 * `privacy_policies` (the URLs of the privacy policies of the services a bundle talks to, which
 * Anthropic's directory submission requires) comes from `tool.json` `mcpb.privacyPolicies`; a
 * homepage is not one, so nothing is invented when the key is absent.
 */
import { kernelDir as pythonKernelDir, pythonPackage } from "../bindings/python.js";
import { KERNEL_DIR, NODE_ENGINES } from "../bindings/typescript.js";
import type { Project, Surface } from "../model.js";
import {
  compact,
  configProperties,
  envName,
  has,
  isSensitive,
  json,
  mcpVerdict,
} from "./shared.js";

export const HOST_DIR = "hosts/mcpb";
export const MANIFEST_PATH = `${HOST_DIR}/manifest.json`;

/**
 * The `@anthropic-ai/mcpb` release `validate()` and the packaging step run. Pinned so the gate is
 * reproducible; Renovate bumps this constant (`renovate.json` `customManagers`).
 */
export const MCPB_PIN = "2.1.2";

/** What `mcpb init` writes for a new bundle, and the floor the directory submission requires. */
export const MANIFEST_VERSION = "0.2";
export const UV_MANIFEST_VERSION = "0.4";

/**
 * The kernel's built `mcp` entry inside the bundle root — the same file the `mcp-registry`
 * surface's Dockerfile runs, because both start from the published package's `dist/`.
 */
function entryPoint(): string {
  // A function, not a module-level constant: `mcpb` sits in an import cycle with the
  // TypeScript binding, and a `const` derived from another module's `const` at evaluation
  // time is only defined for one of the two possible orders.
  return `${KERNEL_DIR.replace(/^src\//, "dist/")}/mcp.js`;
}

/**
 * `compatibility.runtimes.node`: the kernel's own floor, mirroring the TypeScript scaffold's
 * `engines.node` (`mcpb.test.ts` fails when the two drift apart). Claude Desktop ships a Node it
 * runs bundles with, and reads this to refuse a bundle that one is too old for.
 */

/** JSON Schema types `user_config` has a field type for; anything else is collected as text. */
const USER_CONFIG_TYPES = new Set(["string", "number", "boolean"]);

export const surface: Surface = {
  id: "mcpb",
  plan(project: Project) {
    const python = project.tool.binding === "python";
    if (python && !has(project, "pypi")) {
      throw new Error(
        'Surface "mcpb" with the python binding requires the "pypi" surface, the canonical runtime distribution.',
      );
    }
    const { identity } = project;
    const properties = configProperties(project);
    const required = new Set(project.tool.config?.required as string[] | undefined);
    const userConfig = Object.entries(properties).map(([key, property]) => [
      key,
      compact({
        type: USER_CONFIG_TYPES.has(property.type as string) ? property.type : "string",
        title: (property.title as string | undefined) ?? key,
        description: (property.description as string | undefined) ?? key,
        required: required.has(key) || undefined,
        sensitive: isSensitive(property) || undefined,
      }),
    ]);
    // Claude Desktop substitutes `${user_config.K}` from the settings UI it generates, so the
    // kernel reads its configuration from the same environment names it does everywhere else.
    const env = Object.fromEntries(
      Object.keys(properties).map((key) => [envName(key), `\${user_config.${key}}`]),
    );
    const manifest = compact({
      manifest_version: python ? UV_MANIFEST_VERSION : MANIFEST_VERSION,
      name: identity.name,
      display_name: identity.name,
      version: identity.version,
      description: identity.description,
      author: identity.author?.name ? identity.author : { name: identity.name },
      homepage: identity.homepage,
      documentation: identity.homepage,
      repository: identity.repository ? { type: "git", url: identity.repository } : undefined,
      license: identity.license,
      privacy_policies: project.tool.mcpb?.privacyPolicies,
      keywords: identity.keywords,
      server: {
        type: python ? "uv" : "node",
        entry_point: python ? `${pythonKernelDir(project)}/mcp.py` : entryPoint(),
        // `${__dirname}` is the installed bundle's own directory: an install is an unzip
        // somewhere else, so nothing in the launch may be repository-relative. For `uv`, this
        // delegates dependency resolution and Python provisioning to the host's supported runtime.
        mcp_config: python
          ? compact({
              command: "uv",
              args: [
                "run",
                "--directory",
                "${__dirname}",
                "python",
                "-m",
                `${pythonPackage(project)}.toolfactory.mcp`,
              ],
              env: Object.keys(env).length ? env : undefined,
            })
          : compact({
              command: "node",
              args: [`\${__dirname}/${entryPoint()}`],
              env: Object.keys(env).length ? env : undefined,
            }),
      },
      // Exactly the operations the kernel's own `tools/list` serves (§4.3): the manifest is what
      // the install UI shows before the server ever runs, so it must not promise more.
      tools: project.operations
        .filter((operation) => mcpVerdict(operation).kind !== "excluded")
        .map((operation) => compact({ name: operation.name, description: operation.description })),
      user_config: userConfig.length ? Object.fromEntries(userConfig) : undefined,
      compatibility: { runtimes: python ? { python: ">=3.11" } : { node: NODE_ENGINES } },
    });
    return [{ kind: "file", path: MANIFEST_PATH, content: json(manifest) }];
  },
  validate(project) {
    return [
      {
        label: "mcpb validate",
        command: "npx",
        args: ["-y", `@anthropic-ai/mcpb@${MCPB_PIN}`, "validate", MANIFEST_PATH],
        cwd: project.root,
      },
    ];
  },
  // The bundle carries MCP tool calls and nothing else: the rule is the `mcp` surface's own.
  verdict: mcpVerdict,
};
