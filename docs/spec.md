# toolfactory specification (v0)

Normative. MUST, MUST NOT and SHOULD carry RFC 2119 force. This document describes what
toolfactory does today; anything listed under §10 as out of scope is not implied elsewhere.

## 1. Thesis

toolfactory is a **scaffolder and a keeper-in-sync**. It is not a runtime, not an abstraction
layer and not a manifest standard. It writes each surface in exactly the shape that surface's own
upstream tooling would have written, then proves it by running that surface's own validator. Its
only invention is one authored config file (`dev.toolfactory/tool.json`) plus a derived operation
snapshot; every other artifact is a mechanical projection, committed in-tree and diffed in CI.

Three consequences are load-bearing:

- **toolfactory can be deleted from any repo it generated** and every surface still installs,
  builds, tests and publishes. There is no toolfactory runtime library in any language.
- **A single-surface author gets their ecosystem's own scaffold plus one directory.** A
  ten-surface author gets ten repos' worth of correctness from one version bump.
- **toolfactory never abstracts a host SDK.** It wires, validates, and gets out of the way.

## 2. The shared plane

### 2.1 Entities

| Entity | Lives in | Kind |
|---|---|---|
| **Identity**: `name`, `version`, `description`, `author{name,email,url}`, `homepage`, `repository`, `license`, `keywords` | the identity file (§2.2 S1) | authored |
| **Operations**: MCP tool definitions (`name`, `description`, `inputSchema`, `outputSchema`, `annotations`) plus `_meta["dev.toolfactory"].requires` | the author's code, behind the kernel MCP server | authored (code) |
| **Operation snapshot**: the `tools/list` result | `dev.toolfactory/ops.json` | derived, committed |
| **Instructions**: when and why an agent should use the tool | `skills/<N>/SKILL.md` body | authored (prose) |
| **Config and secrets**: JSON Schema 2020-12 object, secrets marked `x-toolfactory.sensitive` | `dev.toolfactory/tool.json` → `config` | authored |
| **Surfaces, binding, bundle runtime, test examples, per-surface options** | `dev.toolfactory/tool.json` | authored |
| **Coverage verdicts**: operation × surface | `dev.toolfactory/coverage.json`, `COVERAGE.md` | derived, committed |
| **Generation lock**: `toolfactoryVersion`, `files{path:{sha256,state}}` | `dev.toolfactory/lock.json` | derived, committed |
| **tool.json schema** | `dev.toolfactory/tool.schema.json` | derived, committed |
| **Inspector config** for the kernel | `dev.toolfactory/inspector.json` | derived, committed |
| Every host manifest, `mcp.json`, `server.json`, package metadata, kernel files, workflows | §3 | derived, committed |
| Build products | `dist/`, `.venv/`, `hosts/*/dist/`, `hosts/*/node_modules/` | derived, ignored |

Derived data is **committed**, not built, because every consuming host installs from git
(`openclaw plugins install git:owner/repo@ref`, `hermes plugins install owner/repo`,
`npx skills add owner/repo`, VS Code "Install Plugin From Source", marketplace commits).
`toolfactory check` is the CI drift gate.

**One directory.** Everything toolfactory owns lives in `dev.toolfactory/`. When a bundle surface is
selected that directory is simultaneously the Agent Plugins extension directory for the
`dev.toolfactory` namespace, which every host ignores. toolfactory MUST NOT write into
`plugin.json.extensions`: the extensions map is data every host parses, the directory is private.

### 2.2 Source-of-truth laws

**S1: One identity file, authored.** `tool.json.identity` names one file, chosen by `init`:

1. `plugin.json` (Agent Plugins 1.0.0, repo root) when any bundle or skills surface is selected;
2. else the root package manifest (`package.json` or `pyproject.toml`).

Identity is authored, never generated. `tool.json` MUST NOT duplicate any identity field. Every
other identity-bearing file is a projection. A Python CLI-only repo therefore carries no
`plugin.json`, and a ten-surface repo is a valid Agent Plugin with toolfactory uninstalled.

**S2: Operations come from the code.** Never from a manifest. `toolfactory introspect` spawns the
kernel MCP server, calls `tools/list`, and snapshots the result to `ops.json`. Every downstream
generator reads the snapshot, so `build` and `coverage` are offline and deterministic. `check`
re-runs the introspection and fails when the snapshot is stale, so a forgotten `introspect`
cannot pass CI.

**S3: Capability requirements come from the code too.** Each operation declares
`_meta["dev.toolfactory"].requires: string[]` on its MCP tool definition (the generated kernel does
this from the operation's `requires` field). Because it rides into `ops.json`, coverage is
computed offline with no running server. `introspect` rejects a term outside the closed set (§4.2).

**S4: Everything else is generated, in-tree, SHA-locked.** Every generated file's SHA-256 is
recorded in `lock.json`. `check` compares the tree against what `build` would write and fails on a
missing, changed, orphaned or unmarked file.

**S5: Two states, never three.** A file is `generated` or `manual`. `adopt <path>` makes one file
manual permanently; `eject <surface>` adopts every file that surface owns; `unadopt <path>`
returns a file to generated and rewrites it. Manual files are counted in `COVERAGE.md`, so a repo
cannot silently drift to majority-manual.

**S6: Prose is never generated.** There is one skill per tool, not one per operation. toolfactory
writes only the SKILL.md frontmatter and the `<!-- tf:operations -->` … `<!-- /tf:operations -->`
block; the body is the author's.

**S7: Never parse what we can write.** toolfactory owns no reader for `openclaw.plugin.json`,
`plugin.yaml`, `SKILL.md`, `package.json` or `pyproject.toml` beyond the shallow structural reads
that S8 requires. It writes them and asks the upstream validator for an exit code.

**S8: Preserve the unknown.** Region files keep everything outside their markers. Merge files
(`package.json`, `pyproject.toml`) own only the keys in their patch and leave every other key
alone. The identity file's unrecognised top-level keys are preserved on rewrite.

**S9: Schema direction is native → JSON only.** Zod or Pydantic produce JSON Schema 2020-12 for the
wire and for generated manifests. toolfactory never converts JSON Schema back into a native schema;
where a host needs a native schema object (TypeBox), the JSON Schema is wrapped, not translated.

### 2.3 The name projection

The canonical name `N` is the Agent Plugins name
(`^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$`), authored once in the identity file and
projected by a total function (`src/identity/name.ts`):

| Target | Projection |
|---|---|
| `package.json.name` | `N`, or `@<scope>/N` when `tool.json.npm.scope` is set |
| `pyproject.toml [project].name` | `N` with `.` → `-` |
| Python import package | previous, with `-` → `_` |
| `.claude-plugin/plugin.json.name`, `.codex-plugin/plugin.json.name` | `N` |
| `.cursor-plugin/plugin.json.name` | `N` with `.` → `-` |
| `openclaw.plugin.json.id`; OpenClaw `package.json.name` | `N`; `openclaw-plugin-<N>` |
| `hosts/hermes/plugin.yaml.name`; Hermes toolset | `N`; `N` with `.`/`-` → `_` |
| `server.json.name` | `io.github.<owner>/<N>`, owner from `repository` |
| `mcp.json` server key, `inspector.json` server key | `N` |
| `skills/<N>/` and SKILL.md `name` | `N` |

`N` is wire-visible (bundle tools appear as `N__<tool>` in OpenClaw and `mcp__N__<tool>` in
Hermes) and therefore frozen after first publish. Renaming is done by editing the identity file and
running `build`; `check` never rewrites anything.

### 2.4 Layout law

- **L1.** A file exists iff a selected surface owns it, with one always-on owner besides
  `workflows`: the binding's kernel (`types`, `config`, `mcp`) is generated for every tool because
  the author's operation module imports it and `introspect` spawns it, even for a tool with zero
  operations. `build` deletes orphans left by removing a surface from `tool.json`; `check` reports them.
- **L2.** The repo root belongs to the binding's package (`package.json` or `pyproject.toml`).
  Host-native packages nest under `hosts/<id>/`.
- **L3.** The portable bundle (`plugin.json`, `mcp.json`, `skills/`) sits at the repo root iff a
  bundle or skills surface is selected.
- **L4.** `hosts/<id>/` exists iff the author selected that host-native surface. Nothing else
  creates it. A tool targeting five bundle surfaces grows no `hosts/` directory.
- **L5.** The Claude projection is unconditional when selected: `.claude-plugin/plugin.json` with
  inline `mcpServers` is emitted and `claude plugin validate .` is a gate. Claude Code is not an
  Agent Plugins TSC member; betting on manifestless discovery is not permitted.
- **L6.** Build products are ignored. One exception: with `bundle.runtime = "bundled"` the
  single-file kernel `bin/mcp.js` is committed by the author, because a git install has no
  dependency-resolution step.

## 3. Surfaces

Every surface is one pure projector, `plan(project) → PlannedFile[]`, plus optional `validate`
(upstream commands) and `verdict` (§4.3). Three file kinds exist: whole files, region files
(author-owned with marker-delimited generated regions) and merge files (JSON/TOML where
toolfactory owns exactly the keys in its patch).

| Surface | Emits | Validates with (all upstream) | Verdict rule |
|---|---|---|---|
| `skill` | `skills/<N>/SKILL.md` (frontmatter + operations block; body authored) | `uvx --from skills-ref agentskills validate` | portable → `bridged:agent-mediated`; `channel` → `excluded:no-channel-bridge` |
| `agent-plugins` | `mcp.json`; requires identity in `plugin.json` | Ajv 2020 against the vendored 1.0.0 schemas (`schemas/agent-plugins/`) | as `mcp` |
| `claude` | `.claude-plugin/plugin.json` (`userConfig` from `config`, inline `mcpServers` using `${CLAUDE_PLUGIN_ROOT}` and `${user_config.K}`) | `claude plugin validate .` | as `mcp` |
| `codex` | `.codex-plugin/plugin.json` with the required `interface` block and inline `mcpServers` | schema-shaped; loader not exercised | `degraded:loader-unverified` |
| `cursor` | `.cursor-plugin/plugin.json` with `variables` from `config`, pointing at `./mcp.json` | schema-shaped; loader not exercised | `degraded:loader-unverified` |
| `mcp` | ships the kernel MCP server (stdio by default; `mcp --http [port]` serves the same server over streamable HTTP at `/mcp`): `dev.toolfactory/inspector.json`, `mcp.json` references | MCP Inspector `--cli --method tools/list` | portable → `native`; else `excluded:mcp-no-host-capabilities` |
| `cli` | the binding's CLI file, one subcommand per operation | `<cli> --help` | portable or `user-input` → `native` (a CLI has a human at the terminal); else `excluded:cli-no-host-capabilities` |
| `mcp-registry` | `server.json` (name `io.github.<owner>/<N>`, package entry, `environmentVariables` with `isSecret`) | schema-shaped; published by `mcp-publisher` | metadata only |
| `npm` | merge into `package.json`: identity, `type`, `bin`, `files`, `mcpName` | `npm pack --dry-run` | library |
| `pypi` | merge into `pyproject.toml`: identity, `[project.scripts]`, registry marker | `uv build` | library |
| `openclaw-native` | `hosts/openclaw/` mirroring `openclaw plugins init --type tool`: `package.json` with `openclaw{}`, `openclaw.plugin.json` (`configSchema` from `config`, `uiHints.<key>.sensitive` for secrets), `src/index.ts` (`defineToolPlugin`, TypeBox `Type.Unsafe` over each operation's JSON Schema) | `npm install`, `npm run build`, `openclaw plugins build --check`, `openclaw plugins validate`, `@openclaw/plugin-inspector`, and a scaffold diff against a fresh `openclaw plugins init` | TypeScript + portable → `native`; Python + portable → `degraded:out-of-process`; else `excluded:implement-in-hosts` |
| `hermes-native` | `hosts/hermes/{pyproject.toml, README.md, <pkg>/{plugin.yaml, __init__.py}}`: manifest v2 (`requires_env` = schema-required config, `optional_env` the rest, secrets flagged `password`, each `{name, description, prompt, password, url}`), `register(ctx)` → `ctx.register_tool(...)`, handlers always return JSON and `{"error": ...}` instead of raising, the `hermes_agent.plugins` entry point; the shim reads `<N>_ROOT` to find the kernel when installed outside its checkout | `hermes plugins doctor hosts/hermes/<pkg> --ci` | Python + portable → `native`; TypeScript + portable → `degraded:out-of-process`; else `excluded:implement-in-hosts` |
| `web` | `web/`: a Vite + React + Tailwind v4 + shadcn/ui project mirrored from `npm create vite` and `shadcn init`; one form per operation over shadcn's Field composition, CLI and MCP `tools/call` previews, a live call to the kernel through the dev server's `/mcp` proxy; the shadcn component files are vendor code the shadcn CLI copies into the author's tree | `npm install`, `shadcn add`, scaffold drift against a fresh init, `vite build`, Playwright smoke | as `mcp` |
| `workflows` (always on) | `.github/workflows/ci.yml`; `release.yml` when a registry surface is selected; `compose.toolfactory.yaml` when a host-native surface is selected; `.env.example`; `renovate.json`. One check sequence (install, build, `toolfactory check`, the validator CLIs the selected surfaces need, `toolfactory validate`, the author's `check` and `test` scripts) is shared by `ci.yml` and the release gate; the package manager is read from `package.json` `packageManager` (npm or pnpm) | YAML parse; the workflow runs in CI | — |
| `clawhub` | nothing new; a `release.yml` leg publishing `hosts/openclaw/` | `clawhub package publish --wait` | — |
| `dsh` | nothing native: DSH (DeepSeek Harness) reaches the kernel through its own MCP client | — | `degraded:mcp-tools-only` |

The OpenClaw and Hermes **bundle** installs need no surface of their own: both hosts consume the
root Agent Plugins bundle natively, so selecting `agent-plugins` covers them (with the documented
lossiness: OpenClaw executes bundle skills, commands and `mcp.json`, and only detects agents and
hooks).

### 3.1 How `mcp.json` reaches the kernel

toolfactory ships no installer. `tool.json.bundle.runtime` picks one of two spec-conformant shapes:

| `bundle.runtime` | `mcp.json` entry | When |
|---|---|---|
| `package` (default) | `npx -y <pkg>@<version> mcp` or `uvx --from <pypi>==<version> <N> mcp` | the kernel is published; the registry resolves dependencies |
| `bundled` | `node ${PLUGIN_ROOT}/bin/mcp.js` or `python3 ${PLUGIN_ROOT}/bin/mcp.py` | git-install only; the author commits a single-file build |

Secrets MUST NOT appear in `mcp.json`; toolfactory emits only names of non-sensitive config as
`env` placeholders, never values.

## 4. The boundary

### 4.1 The law

> Core logic is a pure function of (JSON arguments, environment/config, filesystem). Anything a
> host provides that is not one of those three is not available to core; a host-native shim MUST
> convert it into one of them before the call.

There is no capability-injection layer, no callback into the host, no adapter pair. MCP 2026-07-28
deprecated Roots, Sampling and Logging: the transport itself removed the capabilities an
abstraction would have wrapped.

### 4.2 Capability vocabulary: closed, eight terms

Each term is an author assertion; toolfactory checks only membership.

| Term | Portable | The operation … |
|---|---|---|
| `net` | yes | makes outbound network calls with its own credentials |
| `fs` | yes | reads or writes paths that arrive as arguments or config |
| `shell` | yes | spawns its own subprocess |
| `secret` | yes | reads a `config` property marked `x-toolfactory.sensitive` |
| `browser` | no | needs a controllable browser page |
| `model` | no | needs an LLM completion it does not pay for itself |
| `user-input` | no | needs an answer from the human mid-execution |
| `channel` | no | needs to post into a live conversation |

An operation is **portable iff `requires ⊆ {net, fs, shell, secret}`**.

### 4.3 Verdicts

Per operation × surface, `coverage` computes one of `native`, `bridged`, `degraded`, `excluded`,
with a machine-readable reason (`excluded:mcp-no-host-capabilities`, `degraded:out-of-process`,
…). An excluded operation is **omitted from that surface's tool list entirely**; degradation is
omission plus an explanation, never a stub that fails at call time. The generated kernels enforce
this at registration from each operation's own `requires` (the MCP server registers portable
operations, the CLI also `user-input` ones), so the surface and `COVERAGE.md` agree by
construction; `introspect` sets `TOOLFACTORY_INTROSPECT=1` so the snapshot still sees everything. Verdicts are written to
`coverage.json`, `COVERAGE.md`, and each skill's operations block, so the agent sees at runtime
only what works on its host.

### 4.4 The three bridges

Verified against the OpenClaw and Hermes sources: neither host exposes a browser, model or
channel as an in-process API to a third-party tool plugin. The bridges, in the order toolfactory
applies them:

1. **Agent-mediated** (every skills host, zero code): the operations block tells the agent, per
   capability, what to do before calling the operation (drive the host's browser tools; do the
   reasoning itself; ask the user). ⇒ `bridged`.
2. **Endpoint-injected** (MCP, CLI, host-native): the operation takes the resource as an argument
   (`cdpUrl`, a provider key from `config`). ⇒ `bridged`.
3. **Host-native escape hatch**: `hosts/<id>/`, scaffolded by the host's own generator. Portable
   operations are wired automatically; operations needing host capabilities are the author's to
   implement there against the full host SDK, then `adopt`-ed. ⇒ `native`.

### 4.5 The authoring pattern: decompose, don't inject

A browser-needing tool is two operations: `analyze_page({html, url})` declares nothing and exists
on every surface; `analyze_url({url})` declares `requires: ["browser"]` and exists only where a
browser does. The capability is satisfied before the call and arrives as an ordinary argument.

## 5. Language agnosticism

toolfactory is TypeScript. The tool it builds is not. A **binding** is the whole language-specific
part: a kernel MCP template over the language's official SDK, a kernel CLI template over the
same operation objects, a package metadata projection, a scaffold written once by `init`, and a
`kernelCommand` for introspection. The kernel files are regenerated on every build; the operation
module (`src/ops.ts`, `src/<pkg>/ops.py`) is the author's.

| | TypeScript | Python |
|---|---|---|
| Operation module | `src/ops.ts`: `operation({name, input: z.object, output?, requires?, annotations?, handler})` | `src/<pkg>/ops.py`: `Operation(name, input=BaseModel, output=…, requires=[…], handler=…)` |
| Scaffold (written once) | `package.json` (toolfactory as a devDependency), `tsconfig.json`, `.gitignore` | `pyproject.toml` (hatchling), `src/<pkg>/__init__.py`, `.gitignore` |
| Kernel | `src/toolfactory/{types,config,mcp,cli}.ts` over `@modelcontextprotocol/server` 2.x (HTTP through `@modelcontextprotocol/node`) and commander | `src/<pkg>/toolfactory/{types,config,mcp,cli}.py` over `mcp` 2.x (HTTP through its built-in uvicorn transport) and argparse |
| Package | `package.json`, `npm` | `pyproject.toml` (hatchling), `uv` |
| Kernel command | `node --import tsx src/toolfactory/mcp.ts` | `uv run --quiet python -m <pkg>.toolfactory.mcp` |
| HTTP | `<cli> mcp --http [port]` or `mcp.ts --http [port]`: stateless streamable HTTP at `127.0.0.1:3000/mcp`, loopback host-header guard | `<cli> mcp --http [port]` or `python -m <pkg>.toolfactory.mcp --http [port]`: `MCPServer.run("streamable-http", stateless_http=True)` |

**There is never a toolfactory runtime library.** A generated tool's dependency closure is the
upstream SDKs plus the author's own dependencies. **A tool is never polyglot**: where the core's
language and a host's language differ, the host-native surface is a shim that spawns the kernel
CLI, and `COVERAGE.md` says `degraded:out-of-process`.

## 6. Validation

| Tier | What | Command |
|---|---|---|
| T0 unit | the author's own tests | the binding's test runner |
| T1 contract | every selected surface's upstream validator, offline | `toolfactory validate` |
| T2 surface smoke | kernel `tools/list` via MCP Inspector; CLI `--help` | `toolfactory validate` |
| T3 host e2e | the generated `compose.toolfactory.yaml`: install into the real host image, assert the tools appear | `docker compose -f compose.toolfactory.yaml up` |

Every tier is a real upstream invocation; toolfactory owns no validator. The only schemas it vendors
are the two Agent Plugins 1.0.0 schemas (the spec forbids fetching at load time). The generated CI
installs the validator CLIs the selected surfaces need: uv for `agentskills`, Claude Code, and
Hermes through its own installer pinned to a commit (Hermes refuses wheel builds from git and
the PyPI release predates `plugins doctor`); the OpenClaw chain runs the generated package's own
pinned `openclaw` devDependency, so no global install is assumed.

**Credentials, one declaration.** A credential is a `config` property with
`x-toolfactory: {sensitive: true}`. From that one declaration toolfactory writes `.env.example`,
Claude `userConfig`, Cursor `variables`, OpenClaw `configSchema` and `uiHints`, Hermes
`requires_env`/`optional_env`, `server.json.environmentVariables[].isSecret`, and the kernel's
environment reads. Values live in the environment or a gitignored `.env`, never in git.

## 7. Release

One version, in the identity file, projected everywhere by `build`. The generated `release.yml`
fires on `v*` tags, repeats the CI check sequence as a gate job, and publishes in a forced order: npm or PyPI (OIDC trusted publishing) → MCP
Registry (`mcp-publisher login github-oidc`, second because it validates the package version
exists) → ClawHub (last; content-fingerprint deduplicated and retry-safe; needs a stored
`CLAWHUB_TOKEN`, since its OIDC path covers `workflow_dispatch` only). toolfactory runs no publish
itself. Registering each trusted publisher in the registry's web UI is a one-time human step.

## 8. Upstream compatibility

- **C1: Own no validator.** Every conformance check shells to the ecosystem's own tool.
- **C2: Mirror scaffolds by execution.** The OpenClaw validator diffs the generated package against
  a fresh `openclaw plugins init`, so an upstream scaffold change fails validation by name instead
  of rotting silently.
- **C3: Preserve the unknown** (S8).
- **C4: Grow by fixed location.** A new host location means a projector, a validator and a coverage
  row. No model change, because the model is the ecosystem's own specs.
- **C5: Version the lock.** `lock.json` records the toolfactory version that wrote it.
- **C6: Break toolfactory, never users.** Committed files keep working when upstream moves;
  regeneration is opt-in per version bump.

## 9. toolfactory itself

### 9.1 First-party tooling

toolfactory's own agent configuration (`.agents/`) relies on the skills and MCP servers the
covered platforms and its stack publish themselves, installed through their own mechanisms
(`npx skills add <owner/repo>@<skill>`, the vendor's `mcpServers` snippet): the `shadcn`,
`skill-creator` and `mcp-builder` skills, and the `shadcn`, `playwright`, `github` and
`openai-docs` MCP servers. Projects that publish nothing first-party (Hermes, Cursor, Gemini,
TypeScript, Biome, Vitest, Zod, Vite, Tailwind, uv) get no substitute: agents use their CLIs.


toolfactory is described by its own `dev.toolfactory/tool.json` and every generated artifact in
its repo is produced by `toolfactory build`. `toolfactory check` and `toolfactory validate` run in
its own CI. Its operations (`init`, `introspect`, `build`, `check`, `validate`, `coverage`,
`adopt`, `unadopt`, `eject`, `doctor`) are declared once in `src/ops.ts`; the CLI and the MCP
server are generated from them exactly as for any other tool. Its selected surfaces include the
OpenClaw-native and Hermes-native shims, because those generators track the fastest-moving hosts
and must be exercised by toolfactory's own release.

## 10. Scope

**Ships in v0.** Bindings: TypeScript, Python. Surfaces: every row of §3. Commands: those listed
in §9 plus `mcp`.

**Not in v0** (each is a documented gap, not an implied feature): yarn and bun workflows (the
loader rejects other `packageManager` values with a message); a release ledger and
`release --dry-run`; a `bootstrap-repo` command for protected environments; generated T4 live-test
skeletons with skip guards; nightly golden tests of generators against upstream `latest` and
`@beta`; GUI (Tauri), MCPB and GitHub Releases binaries; Go and Rust bindings; a native DSH
generator (gated on DSH's first non-alpha tag); A2A, WebMCP, UTCP.

**Out permanently:** a TUI (`mcp-inspector` exists); a toolfactory runtime library in any
language; JSON Schema → native-schema conversion; any reimplementation of a validator that exists.
