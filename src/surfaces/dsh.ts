/**
 * DSH (DeepSeek Harness), experimental: a zero-code Cordis bundle that attaches the tool's own
 * MCP server through DSH's first-party `@deepseek-ai/dsh-mcp-client`.
 *
 * `hosts/dsh/` is two files and no code — a `package.json` whose only load-bearing key is
 * `dsh.bundle.patch` (that one expression is DSH's whole acceptance test for a bundle) and the
 * Cordis patch it names, one `insert` row. Nothing else is emitted, on purpose: a bundle that
 * shipped a Cordis plugin would have to track the `ToolDefinition`/`inject` API — the fastest
 * moving part of an alpha harness — and would put its package name and version into the
 * `dsh_plugin_packages` inventory DSH sends to the model endpoint on every request. The row keys
 * this file writes are byte-identical across every published DSH version; the parts that did
 * move (profile templates, `patchReload`) are DSH-owned state written by `dsh plugin`.
 *
 * The bundle declares no dependency: `@deepseek-ai/dsh-mcp-client` is a direct dependency of
 * `@deepseek-ai/dsh` itself, symlinked into `$DSH_HOME/profiles/node_modules/` as every
 * profile's resolution fallback, so declaring it would only invite a version mismatch on a
 * package the user cannot independently satisfy.
 *
 * Every DSH-specific string lives here and nowhere else.
 */
import { Scalar, stringify as yamlStringify } from "yaml";
import { getBinding } from "../bindings/index.js";
import { projectName } from "../identity/name.js";
import type { Project, Surface } from "../model.js";
import { compact, configProperties, envName, json, kernelLaunch, mcpVerdict } from "./shared.js";

/**
 * The `@deepseek-ai/dsh` release `validate()` boots. Pinned, not `@alpha`: npm's `latest` tag
 * lags the alpha line by weeks, so an unpinned install is neither current nor reproducible.
 * Renovate bumps this constant (`renovate.json` `customManagers`).
 */
export const DSH_PIN = "0.1.2-alpha.5";

export const HOST_DIR = "hosts/dsh";
/** The patch file name `dsh.bundle.patch` points at; DSH's own convention for a Cordis overlay. */
export const PATCH_FILE = "cordis.patch.yml";
/**
 * The same row against this checkout instead of the published package. Kept out of `files`, so
 * `npm pack ./hosts/dsh` never ships it: it is what `validate()` boots and what a developer
 * passes to `dsh --patch` to drive the working tree.
 */
export const LOCAL_PATCH_FILE = "cordis.local.patch.yml";

/** DSH's first-party MCP bridge; the only plugin the bundle names. */
const MCP_CLIENT = "@deepseek-ai/dsh-mcp-client";
/** `headless` is one-shot and ships an app bundle; a profile without one blocks forever. */
export const PROFILE = "headless";
/**
 * The pass signature of the keyless boot probe. Reaching it proves, in order: the patch parsed,
 * the row is a valid loader entry, the mcp-client resolved, its config passed the plugin schema,
 * the MCP server spawned, and `initialize` + `tools/list` succeeded — `failOnStartupError` makes
 * every one of those a hard failure before the model is ever consulted. The run then dies on the
 * DeepSeek credential nobody has in CI, which is the exit this validator asserts.
 */
const MISSING_CREDENTIAL = "MISSING_CREDENTIAL: llm-deepseek";

/** `!!js <expr>` — the `tag:yaml.org,2002:js` scalar DSH evaluates when it loads a patch. */
function jsExpression(source: string): Scalar {
  const scalar = new Scalar(source);
  scalar.tag = "!!js";
  return scalar;
}

/**
 * One `insert` row for the mcp-client. `env` restates every config variable as a `!!js` lookup
 * because DSH scrubs any parent name matching /KEY|PASSWORD|SECRET|TOKEN/i (and every `DSH_*`)
 * before spawning an MCP server: an unrestated credential simply never arrives.
 */
function patch(project: Project, launch: { command: string; args: string[] }): string {
  const serverName = projectName.dshServer(project.identity.name);
  const env = Object.fromEntries(
    Object.keys(configProperties(project)).map((key) => [
      envName(key),
      jsExpression(`process.env.${envName(key)}`),
    ]),
  );
  const row = {
    id: rowId(project),
    name: MCP_CLIENT,
    config: compact({
      serverName,
      transport: "stdio",
      ...launch,
      env: Object.keys(env).length ? env : undefined,
      failOnStartupError: true,
    }),
  };
  return yamlStringify([{ insert: [row] }], { lineWidth: 0 });
}

/** The public name a bridged MCP tool takes in DSH; `mcp__<serverName>__<rawName>` is its contract. */
export function toolName(project: Project, operation: string): string {
  return `mcp__${projectName.dshServer(project.identity.name)}__${operation}`;
}

/** The row id and, with it, the `# == <bundle>` layer `--dump-config` prints. */
export function rowId(project: Project): string {
  return `mcp-${projectName.dshServer(project.identity.name)}`;
}

/** The tarball `npm pack ./hosts/dsh` writes into the release assets, by name. */
export function dshTarball(project: Project): string {
  const name = projectName.dshPackage(project.identity.name);
  return `${name}-${project.identity.version ?? "0.0.0"}.tgz`;
}

export const surface: Surface = {
  id: "dsh",
  plan(project) {
    const { identity } = project;
    const manifest = compact({
      name: projectName.dshPackage(identity.name),
      version: identity.version,
      description: `DSH bundle for ${identity.name}: attaches its MCP server through ${MCP_CLIENT}.`,
      license: identity.license,
      files: [PATCH_FILE],
      dsh: { bundle: { patch: `./${PATCH_FILE}` } },
    });
    return [
      { kind: "file", path: `${HOST_DIR}/package.json`, content: json(manifest) },
      {
        kind: "file",
        path: `${HOST_DIR}/${PATCH_FILE}`,
        // `cwd` is deliberately absent: an installed bundle has no path to point at, and the
        // published launch resolves through the registry from wherever DSH is running.
        content: patch(project, kernelLaunch(project, ".")),
      },
      {
        kind: "file",
        path: `${HOST_DIR}/${LOCAL_PATCH_FILE}`,
        // The kernel as `introspect` and `inspector.json` spawn it: repo-relative, so it resolves
        // against the directory DSH itself was started in.
        content: patch(project, getBinding(project.tool.binding).kernelCommand(project)),
      },
    ];
  },
  validate(project) {
    // A fresh DSH_HOME per run: an id already present from an installed bundle would collide
    // (`duplicate loader entry id`), and the profile is initialised on first use anyway.
    const script = [
      'DSH_HOME="$(mktemp -d)"; export DSH_HOME DSH_TELEMETRY_DISABLED=1',
      `out="$(env -u DEEPSEEK_API_KEY -u DEEPSEEK_BASE_URL npx -y @deepseek-ai/dsh@${DSH_PIN} --profile ${PROFILE} --patch ${HOST_DIR}/${LOCAL_PATCH_FILE} 'toolfactory dsh surface probe' 2>&1)"`,
      'rm -rf "$DSH_HOME"',
      'printf "%s\\n" "$out"',
      `printf "%s" "$out" | grep -qF '${MISSING_CREDENTIAL}'`,
    ].join("\n");
    return [
      {
        label: "dsh headless boot (keyless)",
        command: "sh",
        args: ["-c", script],
        cwd: project.root,
      },
    ];
  },
  // The tools reach the model as `mcp__<serverName>__<operation>`: DSH's MCP client carries tool
  // calls and nothing else, so the rule is the `mcp` surface's own.
  verdict: mcpVerdict,
};
