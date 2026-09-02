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
| **Agent config**: `.agents/{sync.py,setup,README.md,mcp/servers.json,skills/}`, the per-harness hook carriers (`.claude/settings.json`, `.cursor/environment.json`, `.devcontainer/`), `.gitattributes`, `.gitignore` and the agent-config workflows | §3 `agents` | derived (vendored from `GoatInAHat/template`), committed |
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
missing, changed, orphaned or unmarked file. A file a projector flags as an **output** — a build
product the `agents` surface gitignores (`dev.toolfactory/coverage.json`,
`dev.toolfactory/inspector.json`, `web/src/ops.json`) — is generated and locked like any other, but
`check` does not fail when it is absent, only when a copy that is present has gone stale. A file a
projector flags as a **symlink** (`.agents/skills/<N>`) is likewise generated and locked, by its
target string rather than its bytes: `check` reads the link back, reports a regular file or
directory standing in its place as changed, and `build` replaces whatever it finds with the link.

**S5: Two states, never three.** A file is `generated` or `manual`. `adopt <path>` makes one file
manual permanently; `eject <surface>` adopts every file that surface owns; `unadopt <path>`
returns a file to generated and rewrites it. Manual files are counted in `COVERAGE.md`, so a repo
cannot silently drift to majority-manual (which is why `COVERAGE.md` is tracked and its JSON half is
not). The `output` flag of S4 is not a third state: it says where a generated file lives, not who
authored it.

**S6: Prose is never generated.** There is one skill per tool, not one per operation. toolfactory
writes only the SKILL.md frontmatter and the `<!-- tf:operations -->` … `<!-- /tf:operations -->`
block; the body is the author's.

**S7: Never parse what we can write.** toolfactory owns no reader for `openclaw.plugin.json`,
`plugin.yaml`, `SKILL.md`, `package.json` or `pyproject.toml` beyond the shallow structural reads
that S8 requires. It writes them and asks the upstream validator for an exit code.

**S8: Preserve the unknown.** Region files keep everything outside their markers. Merge files
(`package.json`, `pyproject.toml`) own only the keys in their patch and leave every other key
alone; a file that already carries the patch is not rewritten at all, so a rebuild keeps the
author's formatting and TOML comments (a patch that does change a value reserializes the file,
which drops TOML comments). Objects a projector owns whole (`bin`, `[project.scripts]`) are
replaced, so a renamed key does not leave its old name behind. Every merge file carries its inverse
in the lock: `files[<path>].keys` records the dotted paths its patch wrote, so the next `build`
removes the ones the current patch no longer writes — pruning the objects that empties — before
merging. Dropping a key from a patch, or deselecting the surface that added it, therefore
uninstalls the key instead of stranding it, and a merge file that leaves the plan altogether loses
its keys, not its existence: the author keeps the file and everything else in it. Every region file
carries the same inverse: `files[<path>].regions` records the marker pairs its projector wrote, so a
region the current plan no longer writes is emptied before the current ones are filled, and a region
file that leaves the plan loses its regions, not its existence — the author keeps the file, the
markers and every byte outside them, and re-selecting the surface refills the markers the strip
preserved. The identity file's unrecognised top-level keys are preserved on rewrite.

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
| `gemini-extension.json.name` | `N` with `.` → `-` (Gemini rejects anything outside `[A-Za-z0-9-]`) |
| `openclaw.plugin.json.id`; OpenClaw `package.json.name` | `N`; `openclaw-plugin-<N>` |
| `hosts/hermes/plugin.yaml.name`; Hermes toolset | `N`; `N` with `.`/`-` → `_` |
| `hosts/dsh/package.json.name`; DSH `serverName` | `<N>-dsh`; `N` with `.` → `-`, capped at 32 characters (`[A-Za-z0-9_-]{1,32}`, validated at DSH boot) |
| `server.json.name` | `io.github.<owner>/<N>`, owner from `repository` |
| `mcp.json` server key, `inspector.json` server key | `N` |
| `skills/<N>/` and SKILL.md `name` | `N` |

`N` is wire-visible (bundle tools appear as `N__<tool>` in OpenClaw, `mcp__N__<tool>` in Hermes and
`mcp__<serverName>__<tool>` in DSH) and therefore frozen after first publish. Renaming is done by editing the identity file and
running `build`; `check` never rewrites anything.

### 2.4 Layout law

- **L1.** A file exists iff a selected surface owns it, with one always-on owner besides
  `workflows`: the binding's kernel (`types`, `config`, `mcp`) is generated for every tool because
  the author's operation module imports it and `introspect` spawns it, even for a tool with zero
  operations. `build` deletes the generated orphans left by removing a surface from `tool.json`
  and empties the regions of the authored ones; `check` reports both.
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

A surface may also declare `requires: SurfaceId[]`: the surfaces whose output its projection points
at — `cursor` → `agent-plugins` (`.cursor-plugin/plugin.json` names `./mcp.json`), `web` → `mcp`
(the page calls the `mcp --http` endpoint only that surface's CLI subcommand serves), `dsh` → `mcp`
(its whole bundle is one row launching the kernel MCP server), `gemini` → `mcp` (its manifest's
only payload is that same launch row), `mcpb` → `mcp` + `npm` (its bundle root is the npm tarball
with the kernel's production dependencies installed into it), `browser-extension` → `mcp` (its background worker POSTs to that same
`mcp --http` endpoint on loopback). `buildPlan`
refuses a selection that omits one, naming both surfaces, instead of emitting an artifact that
points at a file nobody writes.

| Surface | Emits | Validates with (all upstream) | Verdict rule |
|---|---|---|---|
| `skill` | `skills/<N>/SKILL.md` (frontmatter + operations block; body authored), plus `.agents/skills/<N>` — a symbolic link (§2.2 S4) to `../../skills/<N>`, because the bundle formats fix `skills/` at the bundle root while Copilot, Codex, Hermes and DSH read a project's skills only from `.agents/skills/`; the link is also what puts the tool's own skill in the `.agents/` canon, so `sync.py` fans it out to every other harness directory, and every reader still sees exactly one skill (on Windows the checkout needs `git config core.symlinks true`, otherwise git writes the link as a text file and `check` reports it changed) | `uvx --from skills-ref agentskills validate` | portable → `bridged:agent-mediated`; `channel` → `excluded:no-channel-bridge` |
| `agent-plugins` | `mcp.json`; requires identity in `plugin.json` | Ajv 2020 against the vendored 1.0.0 schemas (`schemas/agent-plugins/`) | as `mcp` |
| `claude` | `.claude-plugin/plugin.json` (`userConfig` from `config`, inline `mcpServers` using `${CLAUDE_PLUGIN_ROOT}` and `${user_config.K}`) and `.claude-plugin/marketplace.json` (`{name, owner, plugins:[{name, source:"./"}]}`), which makes the repository its own single-plugin marketplace — the only shape `claude plugin marketplace add <owner>/<repo>` (and Copilot CLI's identical command) installs | `claude plugin validate .` | as `mcp` |
| `codex` | `.codex-plugin/plugin.json` with the required `interface` block and inline `mcpServers` (Agent Plugins placeholders; data-directory and secret conventions unverified against OpenAI's docs), plus `.agents/plugins/marketplace.json` listing the repository's own plugin (`source: {source: "local", path: "."}`, `policy.installation`/`policy.authentication`/`category` required on every entry per the build guide) — the shape `codex plugin marketplace add <owner>/<repo>` (or a local path) reads | real Codex CLI (`@openai/codex`, pinned), under a fresh `CODEX_HOME`, from a staged copy of the checkout without `.git`, `node_modules` or `dist` (the tree a clone gives Codex; `plugin add` copies the plugin directory verbatim, and a checkout's OpenClaw host links back to the repository): `plugin marketplace add . → plugin add <name>@<name> → plugin list --available`, proven to install and fail correctly against a generated bundle | `degraded:loader-unverified` (conservative: the ChatGPT/Codex-agent tool-invocation path through the installed plugin, as opposed to the marketplace/install path just proven, stays unverified) |
| `cursor` | `.cursor-plugin/plugin.json` with `variables` from `config`, pointing at `./mcp.json` | schema-shaped; loader not exercised | `degraded:loader-unverified` |
| `gemini` | `gemini-extension.json` at the repository root — the whole Gemini CLI install channel, since `gemini extensions install https://github.com/<owner>/<repo>` takes any public repository carrying one and geminicli.com/extensions lists it from the same manifest. `mcpServers` is the kernel launch under `${extensionPath}`; `contextFileName` is `AGENTS.md`, not a second `GEMINI.md`; `config` projects onto `settings[]` (`envVar`, `sensitive`), which is the only way a variable reaches the server, because Gemini passes an extension no shell environment beyond what the manifest allowlists. No `skills`/`commands` key: Gemini auto-discovers both directories from the extension root, so the `skill` surface's `skills/<N>/` already is the extension's skills | `gemini extensions validate .` (keyless: it parses the manifest, enforces the name and version rules and fails when `contextFileName` names a missing file) | as `mcp` |
| `mcp` | ships the kernel MCP server (stdio by default; `mcp --http [port]` serves the same server over streamable HTTP at `/mcp`, `mcp --http --pair` under the optional pairing token of §5): `dev.toolfactory/inspector.json`, `mcp.json` references. With `web`, that same listener also serves the built page — `/mcp` is the endpoint, `/env` is the Secrets panel's route (§4.6) and everything else is a file under `web/dist` — behind one exported `handler(options)` a host with its own listener can mount instead (the OpenClaw route below); `mcp --http --open` ensures a token (environment, else the existing `relay-token`, else a fresh one — never rotating the extension's), opens `<base>/#<token>` with the OS opener, and the page reads that fragment once, strips it and presents it as `Authorization: Bearer` on the two API routes, which are the only guarded ones (a browser cannot put a header on its own document request). The binding also generates the `web` operation (§5) | MCP Inspector `--cli --method tools/list` | portable → `native`; else `excluded:mcp-no-host-capabilities` |
| `cli` | the binding's CLI file, one subcommand per operation | `<cli> --help` | portable or `user-input` → `native` (a CLI has a human at the terminal); else `excluded:cli-no-host-capabilities` |
| `mcp-registry` | `server.json` (name `io.github.<owner>/<N>`, one `packages[]` entry per selected package registry with `environmentVariables`/`isSecret`, plus an unconditional `oci` entry — `ghcr.io/<owner, lowercased>/<N>:<version>`, `transport: stdio`) and a root `Dockerfile`, one multi-stage build per binding, `LABEL io.modelcontextprotocol.server.name` set to `server.json`'s own `name` in the final stage, `ENTRYPOINT` running the kernel's `mcp` entrypoint directly (`dist/toolfactory/mcp.js`, or `python -m <pkg>.toolfactory.mcp`) — stdio only, since the kernel exposes no `--host` flag to bind past loopback (§4.1) | schema-shaped; published by `mcp-publisher` and, for the image, `docker/build-push-action` | metadata only |
| `mcpb` | `hosts/mcpb/manifest.json`, an MCP Bundle manifest: `manifest_version` `0.2` (what `mcpb init` itself writes for a new bundle, and the floor Anthropic's Connectors-Directory submission takes), the identity, `server.type: node` whose `entry_point` is the published package's built kernel entry (`dist/toolfactory/mcp.js`, the same file the `mcp-registry` Dockerfile runs) launched under `${__dirname}`, `user_config` from `config` (`sensitive` for secrets) reaching the kernel through `mcp_config.env` as `${user_config.K}`, `tools[]` the operations the `mcp` verdict admits, and `compatibility.runtimes.node`. The bundle *root* is not the repository: `packageSteps` (§7) stages `dist/mcpb/` out of the npm tarball, installs its production dependencies into it (`npm install --omit=dev --ignore-scripts`), copies the manifest in and runs `mcpb pack`, so what Claude Desktop installs is exactly what npm publishes. TypeScript only — a Python bundle would have to vendor an interpreter's site-packages, which `npm pack` gives the TypeScript binding for free and `uv` gives no equivalent of, so the projector refuses that binding by name. `privacy_policies` comes from `tool.json` `mcpb.privacyPolicies` (the directory submission requires them, and a homepage is not one; the README "Privacy Policy" section the same form asks for is the author's). Deliberately absent: an `mcpb` entry in `server.json`, because the registry schema makes `fileSha256` **required** for MCPB packages and the bundle's hash cannot be known at plan time | `mcpb validate hosts/mcpb/manifest.json` | as `mcp` |
| `npm` | merge into `package.json`: identity (`repository` in npm's object form, `git+https://github.com/<owner>/<repo>.git`, the slug's case preserved), `type`, `bin`, `files`, `mcpName` | `npm pack --dry-run`, `publint --strict` | library |
| `pypi` | merge into `pyproject.toml`: identity, `[project.scripts]`, registry marker | `uv build` | library |
| `openclaw-native` | `hosts/openclaw/` mirroring `openclaw plugins init --type tool`: `package.json` with `openclaw{}` (plus `pluginInspector` expectations and the author's `openclaw.dependencies`/`peerDependencies`/`devDependencies`/`pluginApi` from `tool.json`), `openclaw.plugin.json` (`configSchema` from `config`, `uiHints.<key>.sensitive` for secrets, `activation`, `contracts` = tools plus every `openclaw.registers` entry), `src/index.ts` as a region file (the region: `defineToolPlugin`, TypeBox `Type.Unsafe` over each operation's JSON Schema, the data directory from `resolveStateDir()`; the tail: the author's host registrations wrapping `entry.register`) and `src/index.test.ts` asserting each declared registration fires; with `web` and the TypeScript binding the region also wraps `entry.register` to add `registerHttpRoute({path: "/plugins/<N>/web", match: "prefix", auth: "gateway"})` — handled by the core package's own exported `handler`, so `<prefix>/mcp` is answered in-process by the same operations and the rest is `web/dist`, with `/env` off because the gateway's working directory is not the author's checkout — plus a `surface: "tab"` Control UI descriptor pointing at it, the bundled canvas plugin's pattern, so the page is a sidebar tab rather than a URL to go and find (neither is a manifest contract key, so `contracts` is unchanged; both are added to the inspector's expected registrations); `.npmrc` with `install-links=true`, because OpenClaw's install-time safety scan refuses the `node_modules` symlink npm otherwise makes of the `file:` core dependency; and, whenever `tool.json`'s `tests.examples` names an operation the plugin carries, the credential-free end-to-end lane `e2e/{fixtures.json,openclaw.e2e.test.ts}` + `vitest.e2e.config.ts` + a `test:e2e` script + the `@copilotkit/aimock` devDependency. A plugin with zero operations is a valid host plugin: its `COVERAGE.md` and README list what it registers | `npm install`, `npm run build`, `openclaw plugins build --check`, `openclaw plugins validate`, `@openclaw/plugin-inspector inspect --check` and `check --runtime --mock-sdk` (the runtime lane imports the entry against a stubbed SDK, so module load has to be side-effect-free), and a scaffold diff against a fresh `openclaw plugins init` | TypeScript + portable → `native`; Python + portable → `degraded:out-of-process`; else `excluded:implement-in-hosts` |
| `hermes-native` | `hosts/hermes/{pyproject.toml, README.md, tests/test_plugin.py, <pkg>/{plugin.yaml, __init__.py}}`: manifest v2 (`requires_env` = schema-required config, `optional_env` the rest, secrets flagged `secret`, each `{name, description, secret?, url?}`), `register(ctx)` → `ctx.register_tool(...)`, handlers always return JSON and `{"error": ...}` instead of raising, the `hermes_agent.plugins` entry point; the shim reads `<N>_ROOT` to find the kernel when installed outside its checkout; `tests/test_plugin.py` is a fake `PluginContext` (a `state.data_dir` and a `register_tool` collector, no Hermes import) that drives `register(ctx)` and, when `tool.json` `tests.examples` supplies one, one real handler call asserted against its output schema's own marker — the behavioural half `doctor` never proves, deliberately not built on `hermes_cli.plugin_dev`'s private doctor machinery | `uv run --with pytest pytest -q` (in `hosts/hermes`, no Hermes install); `hermes plugins doctor hosts/hermes/<pkg> --ci` | Python + portable → `native`; TypeScript + portable → `degraded:out-of-process`; else `excluded:implement-in-hosts` |
| `web` | `web/`: a Vite + React + Tailwind v4 + shadcn/ui project mirrored from `npm create vite` and `shadcn init`; one form per operation over shadcn's Field composition, CLI and MCP `tools/call` previews, a live call to the kernel — at `new URL("mcp", document.baseURI)`, relative, so one build is served the same under `/` by `mcp --http`, under a plugin route's prefix and on Pages, with the dev server proxying that path; a **Secrets** panel driven entirely by the kernel's `/env` (the declared names, which of them `.env` carries, a masked input per name, and the `toolfactory secrets check` line), absent wherever that route is not answered — a static host, or a project that declares no secret; `src/App.tsx` is a region file (the region: the operations page; the tail: the author's `pages` array and shell, where a d3 page survives every build) and `web/package.json` a merge file that keeps the author's own dependencies; `vite.config.ts` reads `base: process.env.PAGES_BASE ?? "./"` — relative, so the asset URLs of one build resolve wherever it is mounted (`/`, a plugin route's prefix, `/<repo>/` on Pages), with `PAGES_BASE` left as the override for a deployment that needs an absolute one and the dev server always at `/`; `web/src/ops.json`, a lossy duplicate of `dev.toolfactory/ops.json` for the page to read, is an `output` file (§2.2 S4) — rebuilt by `npm run build`, not tracked; the shadcn component files are vendor code the shadcn CLI copies into the author's tree. `web/smoke.mjs` runs no server of its own: it starts the real kernel on an ephemeral port with a token of its own, loads the page from that origin with the token in the fragment, and round-trips a real `tools/call` — the first `readOnlyHint` operation, never any other, because it runs against the author's own project | `npm install`, `shadcn add`, scaffold drift against a fresh init, `vite build`, Playwright smoke against the real kernel | as `mcp` |
| `browser-extension` | `hosts/browser/`, one WXT project (`wxt init --template react`, pinned) built for Chromium, Firefox and Safari out of one codebase. `wxt.config.ts` is a region file whose generated half carries the modules, the `@web` alias and the **projected manifest**: `permissions` from the included operations' capabilities (`storage` always, `activeTab` when one declares `browser`, `cookies` and `sidePanel` for the two `tool.json` opt-ins) filtered per target, so a Chromium-only permission never reaches a Firefox manifest; `host_permissions` `http://127.0.0.1/*` + `http://localhost/*` — the portable form, because Firefox rejects a port in a match pattern — plus `browserExtension.authDomains`; `browser_specific_settings.gecko` from `browserExtension.geckoId` or the `<N>@<owner>.github.io` default. `entrypoints/background.ts` is a region file whose generated half is the router that POSTs stateless MCP to the `mcp --http` endpoint (an MV3 worker fetch to a `host_permissions` host is CORS-exempt and sends no preflight, so the kernel needs no change) and whose tail is where operations that need a page are implemented; `entrypoints/example.content.ts` is the template for that shim. `utils/mcp.ts` is the paired `call()` — endpoint in `storage.local`, token in `storage.session`, sent as `Authorization: Bearer` — and the popup and options pages mount the `web` surface's own `App` through the alias, behind a fetch bridge that forwards every POST to the worker so a document never holds the token (without `web`, the pairing form alone); the popup — the one page that is not already a full one — carries an **Open full page** button calling `browser.runtime.openOptionsPage()`, which is this surface's whole launch story, since the options page is that same tree. `tests/background.test.ts` is the fake-browser unit tier and `tests/smoke.mjs` side-loads the built `chrome-mv3` output into a real Chromium against a mock loopback kernel; `TARGETS.md` is the per-engine verdict matrix. No manifest is written here — WXT emits one per target (MV2 against MV3, `background.scripts` against `service_worker`, `browser_action` against `action`) — and the placeholder icon set is WXT's binary files, copied in by the drift host rather than planned, exactly as the shadcn CLI writes `web/src/components/ui/` | `npm install`, `wxt prepare`, scaffold drift against a fresh `wxt init`, `wxt build` for chrome and firefox, `web-ext lint` (addons-linter, the only keyless manifest validator any engine publishes), the WxtVitest unit tier, the Playwright smoke | portable, `user-input` and `browser` → `native` (the browser is present: this is bridge 3); `model` → `excluded:no-model-bridge`; `channel` → `excluded:no-channel-bridge` |
| `workflows` (always on) | `.github/workflows/ci.yml`; `release.yml` when a registry surface is selected; `compose.toolfactory.yaml` when a host-native surface is selected (`openclaw plugins install --link /work/hosts/openclaw --force --accept-capabilities`, then `plugins inspect`); `.env.example`; `renovate.json` (a merge file, so an author's own keys such as a `customManagers` survive: `config:recommended` plus `ignorePaths` for the SHA-locked projections `.github/workflows/**`, `hosts/*/package.json`, `web/package.json`, so a Renovate PR cannot make `toolfactory check` fail). The commands are not this surface's own: `src/project/gate.ts` holds the gate and the packaging as step data (§7), and this surface renders them into `ci.yml`'s matrix job and `release.yml`'s `gate`/`package` jobs; only the `uses:` steps (checkout, toolchains, the Hermes cache, the publishers) are the surface's. The package manager is read from `package.json` `packageManager` (npm or pnpm) | YAML parse, `actionlint`; the workflow runs in CI | — |
| `readme` (always on) | the `<!-- tf:install -->` region of `README.md`: an Install section with one line per selected distribution surface, in the shape that surface's own installer accepts — `npx skills add <owner>/<repo>` plus the skills.sh badge, `npx -y <npm> mcp` / `uvx <pypi> mcp` (when `mcp` is joined by `npm` or `pypi`, the same launch also carries the VS Code `vscode.dev/redirect/mcp/install` and Cursor `cursor.com/en/install-mcp` one-click badges, `{command, args, env}`-encoded — URL-encoded JSON and base64 respectively — so a badge can never point somewhere the text line does not), the `<N>.mcpb` GitHub Release asset line when `mcpb` is selected, `claude plugin marketplace add <owner>/<repo>`, `codex plugin marketplace add <owner>/<repo>` then `codex plugin add <name>@<name>`, `gemini extensions install https://github.com/<owner>/<repo>` (or `gemini extensions link .` without a repository), `openclaw plugins install --link hosts/openclaw` (and the `clawhub:` id when `clawhub` is selected), `hermes plugins install <repo url>#hosts/hermes/<pkg>`, `dsh plugin --profile <profile> add ./hosts/dsh` or the release tarball (experimental), the browser extension's three channels (`wxt build` then Load unpacked from `hosts/browser/.output/chrome-mv3`, or `web-ext run` for Firefox; the release's per-browser zips plus the Mozilla-signed `.xpi`, the only download-and-install channel now that Chrome drops side-loaded unpacked extensions; the store listings the release's opt-in submit produces) ending in the `<cli> mcp --http --pair` pairing step, `<cli> mcp --http --open` when `web` is selected (the one command that puts the page in front of a human, with the `web` operation named as the agent's equivalent), `npm install <npm>` / `uv add <pypi>`. Lines that need a GitHub repository appear only when the identity file carries one, so a tool built without GitHub still gets an accurate section; the prose around the region is the author's | — | — |
| `agents` (always on) | the agent-config machinery every generated project carries, so it works the same inside every harness. `AGENTS.md`, a region file: the generated region carries the commands, layout, boundary law, how the tool installs into the running host (Gemini `extensions link .`, OpenClaw `--link`, Hermes `file://`, DSH `plugin add`, the browser extension's `wxt build` + Load unpacked and its `mcp --http --pair` pairing step, with the warning that the content script's selectors are the author's to maintain), a Launch section with `web` — one line per way of reaching the one listener (`<cli> mcp --http --open`, the `web` operation from any agent, the OpenClaw Control UI tab, the extension's Open full page, and the CLI line for every harness with no page surface of its own) — a Listing section — one line per curated directory or marketplace a selected surface is a fit for (`mcp` → Docker MCP Catalog, GitHub MCP registry, Cline marketplace, mcp.so, awesome-mcp-servers; `claude` → the Anthropic plugin directory; `agent-plugins` → Kiro Powers; `codex` → the OpenAI plugin directory), every one a human-reviewed portal step or PR the surface deliberately never automates, present only when a listed surface is selected — one Reload row per harness — plus, with `browser-extension`, how the extension itself reloads (`wxt dev`, the `chrome://extensions` Reload button, `web-ext run`) — and the host worktree commands; the prose around it — including the one-time `<!-- setup -->` bootstrap notice `.agents/setup` deletes on its first run — is the author's. Whole vendored files where the template has no per-project content (`.agents/{sync.py,README.md,skills/.gitkeep}`, `.claude/settings.json`, `.cursor/environment.json`, `.devcontainer/{Dockerfile,devcontainer.json}` with the binding's feature, `.gitattributes`, `.github/workflows/{agent-config,copilot-setup-steps}.yml`); `.gitignore` a region (`# tf:ignore`) carrying the template's agent blocks — `sync.py check` fails unless every rendered adapter is ignored — the binding's ignores and every `output` path; `.agents/setup` a region (`# tf:setup`) carrying the template's head plus the binding's dependency install and the `toolfactory check` pre-commit gate, with the author's codegen and migrations after the marker; `.agents/mcp/servers.json` a merge file owning the tool's own kernel, `toolfactory`, and `shadcn`/`playwright` when `web` is selected, by name, because `sync.py absorb()` writes other people's servers into the same document. `init` runs `npx skills add` for the first-party skills of the selected surfaces, best-effort | `hosts/template.ts`: a shallow clone of `GoatInAHat/template`, diffed against the vendored bytes | — |
| `clawhub` | nothing new; two independent `release.yml` legs. With `openclaw-native`: a `publish-clawhub` leg publishing `hosts/openclaw/`'s built tarball via ClawHub's own `package-publish.yml`. With `skill`: a `publish-clawhub-skill` leg publishing `skills/<N>` via ClawHub's own `skill-publish.yml` — a separate track (its own catalog, its own CLI subcommand, its own reusable workflow), so it needs only `skill`, not `openclaw-native` | `clawhub package publish --wait`; `clawhub skill publish --dry-run` | — |
| `dsh` (**experimental**) | `hosts/dsh/`, a DSH (DeepSeek Harness) Cordis bundle with **no code**: `package.json` — whose one load-bearing key, `dsh.bundle.patch`, is DSH's entire acceptance test — and the `cordis.patch.yml` it names, a single `insert` row attaching the kernel MCP server through DSH's first-party `@deepseek-ai/dsh-mcp-client` (`serverName`, `transport: stdio`, the published launch of §3.1, `failOnStartupError: true`, and every config variable restated in `env:` as `!!js process.env.<NAME>`, because DSH scrubs any parent name matching KEY/PASSWORD/SECRET/TOKEN before spawning an MCP server). The bundle declares **no dependency**: `@deepseek-ai/dsh-mcp-client` is `@deepseek-ai/dsh`'s own, symlinked into `$DSH_HOME/profiles/node_modules/` as every profile's resolution fallback. A third file, `cordis.local.patch.yml`, is the same row against this checkout (the kernel as `introspect` spawns it, repo-relative); it is kept out of `files`, so `npm pack ./hosts/dsh` never ships it, and it is what `validate()` boots. **No Cordis plugin code**, deliberately: it would have to track `ToolDefinition`/`inject`, the fastest-moving API of an alpha harness, and it would enter the `dsh_plugin_packages` inventory DSH sends to the model endpoint on every request — a zero-code bundle does not appear there at all | a keyless headless boot, `npx -y @deepseek-ai/dsh@<pin> --profile headless --patch hosts/dsh/cordis.local.patch.yml` in a fresh `DSH_HOME` with `DSH_TELEMETRY_DISABLED=1`, which passes **iff** the run reaches `MISSING_CREDENTIAL: llm-deepseek`: `failOnStartupError` makes the patch parse, the loader entry, the mcp-client config schema, the MCP spawn and `initialize` + `tools/list` hard failures *before* the model is consulted, so that message is the proof they all succeeded. `--dump-config` is deliberately not added — it composes the tree without validating row config schemas, so it proves a strict subset. The probe pulls `@deepseek-ai/dsh` (~300 MB) through `npx`, on the Node-24 leg with the rest of `toolfactory validate` | as `mcp` |

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
   `browser-extension` is this bridge for the `browser` capability: the extension *is* a browser,
   so an operation declaring it is `native` there and authored in `hosts/browser/entrypoints/`,
   turning page state into JSON arguments before the call.

### 4.5 The authoring pattern: decompose, don't inject

A browser-needing tool is two operations: `analyze_page({html, url})` declares nothing and exists
on every surface; `analyze_url({url})` declares `requires: ["browser"]` and exists only where a
browser does. The capability is satisfied before the call and arrives as an ordinary argument.

The same pattern covers a human in the loop. A setup flow that must wait for a verification code
or a passkey ceremony is `setup_begin` (starts the flow, returns what the user must do) and
`setup_complete({answer})` (finishes it); both are portable and exist on every surface. An
operation that declares `user-input` instead exists only where a human is reachable: the CLI
(native, the author prompts on stdin), a skill (bridged: the agent asks the user), and nowhere
else. MCP elicitation in 2026-07-28 is `InputRequiredResult` plus a mid-request tool round (MRTR),
and its form mode MUST NOT carry secrets; no generated kernel can know what to ask, and no client
yet declares the URL mode that would let one hand a browser page over, so elicitation is not a
toolfactory mechanism at all — the future rung, not a shipped one. OpenClaw's public plugin SDK
has no ask-user primitive (`excluded:no-user-input-bridge`); on Hermes the author may import
`tools.clarify_tool` in the host-native shim.

The one operation toolfactory generates rather than the author is the same pattern read the other
way. `web` (with the `web` surface, §5) needs a socket and a browser — neither of which an
operation may hold, since a handler is a pure function of (arguments, config, filesystem) and a
stdio server must stay one — so it does not hold them: it spawns the kernel's own
`mcp --http --open` detached, which binds the port and opens the page on the machine the tool runs
on, reads back the `Serving MCP streamable HTTP on <url>` line and returns `{url}` (the page, never
the token — an operation's result travels through an agent). That is what makes "open the web app"
reachable from MCP, a skill, a plugin and the CLI at once without any host having to open a URL a
tool returns.

### 4.6 Secrets: one declaration, never a value in an argument

A secret reaches a kernel through **config** (the environment its host injects), never through an
operation argument: **no operation's input may declare a property named like an
`x-toolfactory.sensitive` config key** (`src/model.ts`, enforced by `introspect` and `check`). That
one rule is what keeps every projection of the operation schema — MCP `tools/call`, the CLI, the
skill block, the web form, each host manifest — from ever being a paste-a-secret-into-chat path,
and it is why MCP form-mode elicitation (which the spec forbids for secrets anyway) is not a
toolfactory mechanism. Values enter where an agent cannot see them: the host's own masked store,
projected from the same declaration (Claude Code `userConfig.sensitive` → Keychain, Gemini
`settings[].sensitive`, Claude Desktop `user_config`, OpenClaw `uiHints.sensitive` in its
Control UI, Hermes `.env` at `hermes config env-path`; Cursor, Codex, Kiro and Factory only read
the environment); the developer's gitignored `.env`; the kernel-served web page's Secrets panel
(§3 `web`) over its token-guarded loopback `/env` route; and, for CI, `toolfactory bootstrap-repo`,
which pushes `.env` to GitHub through `gh` with values only ever on stdin. `toolfactory secrets`
is the inventory of all of it — the tool's own sensitive keys and the selected registries' tokens
from `registries(project)` (§7), each with where to mint it, whether it is present locally and on
GitHub, the exact per-host action, and (`check`) whether the registry accepts it, delegated to
that registry's own CLI; the T4 live test is the check for the tool's own keys. The data
directory (§6.1) is the fallback for caches such as sessions. Only OpenClaw's
`configSchema` carries schema composition keywords (`anyOf`, `oneOf`); every other host enforces
the flat `required` list, so a cross-field rule such as "VUnetID or email" is validated in the
kernel's own config code.

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
| With `web` | `src/toolfactory/web.ts`: the generated `web` operation, appended to `operations` by the `mcp` and `cli` templates so `introspect` snapshots it like any authored one; `web/dist` ships in `package.json` `files` | `src/<pkg>/toolfactory/web.py`, appended the same way; the wheel carries the page through `[tool.hatch.build.targets.wheel.force-include]` `web/dist` → `<pkg>/web`, which is where `serve_http` looks first |
| Package | `package.json`, `npm` | `pyproject.toml` (hatchling), `uv` |
| Kernel command | `node --import tsx src/toolfactory/mcp.ts` | `uv run --quiet python -m <pkg>.toolfactory.mcp` |
| HTTP | `<cli> mcp --http [port]` or `mcp.ts --http [port]`: stateless streamable HTTP at `127.0.0.1:3000/mcp` from one `node:http` listener, loopback host-header guard | `<cli> mcp --http [port]` or `python -m <pkg>.toolfactory.mcp --http [port]`: one Starlette app — the SDK's own `streamable_http_app()` (its session-manager lifespan with it) with the extra routes appended to its router — under `uvicorn` |

The HTTP endpoint takes an optional **pairing token**, because any local process can POST to
loopback: when `<N>_MCP_TOKEN` is set in the environment or `dataDir()/relay-token` (§6.1) exists,
every request MUST carry `Authorization: Bearer <token>`, compared in constant time, and anything
else is `401`. With neither, nothing changes and a read-only tool works with zero setup.
`mcp --http --pair` mints a fresh token into that file (0600), prints the `<url>#<token>` pairing
string the `browser-extension` surface's options page accepts, and serves with it required. It is
the minimum bar the `browser-extension` surface pairs against; anything stronger is OpenClaw's
`relay-auth-v2`, never a third scheme. `--http 0` binds an ephemeral port, so the URL is only known
once it is bound — both bindings therefore listen first and print the `Serving MCP streamable HTTP
on <url>` line from the bound address, which is also what the `web` operation reads back from its
child. With the `web` surface, `--open` ensures a token the same way `--pair` mints one (without
ever rotating an existing one) and opens `<base>/#<token>`: `execFile` of `open` / `cmd /c start` /
`xdg-open` by platform on Node — best effort, because a container or an SSH session has no opener
and that must not fail the command — and stdlib `webbrowser.open` on Python.

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
| T3 host e2e | the real host runs the real tool: `hosts/openclaw/e2e/` drives one OpenClaw agent turn against a scripted OpenAI-compatible model (`@copilotkit/aimock`, no LLM key) whose fixtures are projected from `ops.json` and `tests.examples`, and answer OK only when the tool's own result comes back; `hosts/hermes/tests/test_plugin.py` calls a real handler through a fake `PluginContext` (reached by `toolfactory validate`, so it needs no step of its own); the generated `compose.toolfactory.yaml` installs into the real host image and asserts the tools appear | the gate's own step `npm --prefix hosts/openclaw run --if-present test:e2e` (Node-24 leg only); `docker compose -f compose.toolfactory.yaml up` |
| T4 live | credential-gated tests against a real account: `tests/live.test.ts` / `tests/test_live.py`, generated with a skip guard on the config keys that are both required and sensitive, the body the author's; a `live` job in `ci.yml` bound to the `live-tests` GitHub Environment, created by `toolfactory bootstrap-repo` or by `init --repo` when a `.env` is already there | `npm run test:live` (loads `.env`), the CI job |

Live-test pass or skip state is the test runner's own report; `coverage.json` and `COVERAGE.md`
stay projection verdicts.

T0 through T3 are one command: `toolfactory gate` runs the step list of §7 in order, in this
checkout, stopping at the first failure and skipping only the steps marked as runner
provisioning. It is the same list `ci.yml` renders, so a project with no CI — no GitHub, plain
git or none — has the identical definition of green.

**Credentials, one declaration.** A config property marked `x-toolfactory.sensitive` is a
secret everywhere: masked in every host that can mask, listed by `toolfactory secrets`, pushed by
`bootstrap-repo`, never accepted as an operation argument (§4.6). The release registries' tokens
are declared once too, as rows of `registries(project)` in `src/project/gate.ts` (§7), and read by
exactly four consumers: `secrets status`, `secrets check`, the release gate's presence step and
the unpublish step.

### 6.1 The data directory

Every kernel exposes `context.dataDir`, resolved in the kernel from the variables hosts already
export: `<N>_DATA_DIR`, else `PLUGIN_DATA` (every Agent Plugins client, OpenClaw's bundled MCP
servers), else `CLAUDE_PLUGIN_DATA` (Claude Code exports it to MCP subprocesses), else an
XDG-style default under the user's data directory. No projected manifest maps it; only the two
in-process hosts set `<N>_DATA_DIR` themselves, the OpenClaw plugin from its state directory and
the Hermes plugin from `ctx.state.data_dir`. Session caches and similar durable state live there;
operations touching it declare `fs`.

### 6.2 T3 without Docker

An agent developing inside the host it targets (OpenClaw or Hermes on a VPS, where there is no
Docker daemon and, on some images, no git) runs the same commands the compose file carries,
against the live host: OpenClaw `openclaw plugins install --link <abs path>/hosts/openclaw --force`
then `openclaw plugins inspect <N> --runtime --json`; Hermes `uv run --with pytest pytest -q` in
`hosts/hermes` for a real handler call with no Hermes install at all
(`hosts/hermes/tests/test_plugin.py`, a fake `PluginContext`), `hermes plugins doctor
<path>/hosts/hermes/<pkg> --ci` for the structural check (registration only — `doctor` never
dispatches a tool call), and, once installed, `hermes plugins install
file://<repo>#hosts/hermes/<pkg> --force` (after committing; `file://`, like `http://`, triggers a
security warning at install time, expected for a local source) to load it. `hermes gateway
restart` is not part of this loop: each `hermes` invocation is a fresh process that already
re-reads the plugin, and the command only matters for the separate, long-running messaging
gateway daemon.

Every tier is a real upstream invocation; toolfactory owns no validator. The only schemas it vendors
are the two Agent Plugins 1.0.0 schemas (the spec forbids fetching at load time). The generated CI
installs the validator CLIs the selected surfaces need: uv for `agentskills`, Claude Code, and
Hermes through its own installer pinned to a commit, cached per pin so it runs only when the pin moves, cloning with the job's token because GitHub throttles anonymous clones (Hermes refuses wheel builds from git and
the PyPI release predates `plugins doctor`); the OpenClaw chain runs the generated package's own
pinned `openclaw` devDependency, so no global install is assumed.

**Credentials, one declaration.** A credential is a `config` property with
`x-toolfactory: {sensitive: true}`. From that one declaration toolfactory writes `.env.example`,
Claude `userConfig`, Cursor `variables`, OpenClaw `configSchema` and `uiHints`, Hermes
`requires_env`/`optional_env`, `server.json.environmentVariables[].isSecret`, and the kernel's
environment reads. Values live in the environment or a gitignored `.env`, never in git.

## 7. Release

**The gate is a command; CI is its projection.** `src/project/gate.ts` holds one list of steps —
`gateSteps` (install, build, `toolfactory check`, the validator CLIs the selected surfaces need,
`toolfactory validate`, the author's `check` and `test` scripts, and the credential-free OpenClaw
turn) and `packageSteps` (the release assets into `dist/release/`) — as data, not YAML. It is
rendered three ways: `ci.yml`'s matrix job, `release.yml`'s `gate` and `package` jobs, and `toolfactory gate` / `toolfactory package`, which run the same steps here, in order, stopping at the first failure. So a project with no GitHub at all has
the same definition of green, and CI cannot drift from it. Steps the local runner skips are marked
(`when: "ci"` — a global or system-wide install a checkout must not perform); steps needing Node
>= 24 for the `openclaw` CLI are marked too, and become the matrix guard in `ci.yml`.

**One version, in the identity file**, projected everywhere by `build`. A release therefore
*asserts* the tag against it and never writes it: the gate's first step is
`test "v$(<read the identity file's version>)" = "$RELEASE_TAG"`, where `RELEASE_TAG` is the pushed
tag or, on `workflow_dispatch`, the `tag` input. Setting a version from the tag would rewrite a
SHA-locked file behind `build`'s back and fail the next `check`.

**`release.yml` is always emitted, and a tag with no secrets is green.** Its `gate` job decides
once, in one step, which registries this tag can publish to — each row's `gate` from
`registries(project)` runs with that row's secrets and confirm variable in its environment (npm:
the package exists, so trusted publishing applies, or `NPM_TOKEN` for the first publish; PyPI: a
published release or `vars.PYPI_TRUSTED_PUBLISHER`; the MCP registry: every `packages[]` entry
can publish; ClawHub and the stores: their tokens; Pages: the site exists) — and writes the answer
as job outputs, because `secrets` and `env` are unreadable in a job-level `if` and the
reusable-workflow legs cannot be gated inside a `run:`. Every leg carries
`if: needs.gate.outputs.<id> == 'true'`, and `release` runs unless something failed
(`!cancelled() && needs.package.result == 'success' && !contains(needs.*.result, 'failure')`), so
skipped legs never skip the Release: gate, package, the Release with its assets, and whatever
else applies. `workflow_dispatch` with a `tag` input is the re-run after adding a secret — every
checkout, the assert, the image tag and the Release read `inputs.tag || github.ref` — and never
`gh run rerun`, which replays the original run's secret snapshot.

**Git is the release ledger.** Before the Release, `release` runs `toolfactory unpublish`
(checkout with the full history): it diffs `dev.toolfactory/tool.json` at
`git describe --tags --abbrev=0 <tag>^` against the tag's, and for every registry a dropped
surface published to runs `exists` → the secret guard → `retract` from the same table — `npm
deprecate` (reversible; `npm unpublish --force` behind `--hard`), `mcp-publisher status --status
deleted`, `clawhub … delete`, `gh api DELETE` for the ghcr package and Pages — and a `::notice::`
with the exact page for the registries that have no API (PyPI yank, the three stores, a live
Apple listing). Re-running the same tag is a no-op, and a missing token is a notice, never a red
release. In-repo listings (the Claude, Codex, Cursor and Gemini manifests, `skills/<N>/`) are
retracted by the deselect itself: the file is gone at the tag.

The generated `release.yml` fires on `v*` tags with a top-level `permissions: {contents: read}`,
and every job that runs steps narrows it explicitly:

| Job | When | Needs | Permissions | What |
|---|---|---|---|---|
| `gate` | always | — | `contents: read` | the tag assert, then `gateSteps` |
| `package` | always | `gate` | `contents: read` | `packageSteps` → one `release-assets` artifact (`upload-artifact`): the npm tarball, `uv build`'s distributions, the built `hosts/openclaw` tarball, the `hosts/dsh` bundle tarball, the `.mcpb` bundle packed from `dist/mcpb/`, the plugin-bundle zip, the web tarball, the browser extension's `wxt zip` output for Chrome/Firefox/Edge plus the Firefox sources zip and, only when `FIREFOX_JWT_ISSUER`/`FIREFOX_JWT_SECRET` are set (this job's own `env:`), the Mozilla-signed self-hosted xpi `web-ext sign --channel=unlisted` writes alongside them, `COVERAGE.md` and a freshly computed `coverage.json` |
| `publish-npm` | `npm` | `gate` | `id-token: write`, `contents: read` | `npm publish --access public`; no `--provenance`, which trusted publishing generates itself |
| `publish-pypi` | `pypi` | `gate` | `id-token: write` | `pypa/gh-action-pypi-publish`, environment `pypi` |
| `publish-oci` | `mcp-registry` with a GitHub owner | `gate` | `contents: read`, `packages: write`, `attestations: write`, `id-token: write` | `docker/login-action` → `docker/metadata-action` (the image `server.json`'s `oci` entry names, `type=semver` for the tag, `LABEL io.modelcontextprotocol.server.name`) → `docker/build-push-action` |
| `publish-mcp-registry` | `mcp-registry` | every package leg | `id-token: write`, `contents: read` | `mcp-publisher login github-oidc`; last of the package legs because it validates each `packages[]` entry, `oci` included |
| `publish-clawhub` | `clawhub` + `openclaw-native` | `package` + prior legs | inherited | `openclaw/clawhub/.github/workflows/package-publish.yml`, fed the built tarball from the artifact (`package_artifact_name`/`package_artifact_path`) — the reusable workflow has no build step, so publishing the subdirectory would ship a package whose entry does not exist. Content-fingerprint deduplicated and retry-safe; needs a stored `CLAWHUB_TOKEN`, since its OIDC path covers `workflow_dispatch` only |
| `publish-clawhub-skill` | `clawhub` + `skill` | `gate` | inherited | ClawHub's skill catalog is a separate track from the plugin catalog above: `openclaw/clawhub/.github/workflows/skill-publish.yml`, fed `skill_path: skills/<N>` straight from the checkout — no built artifact to wait on, so it needs only `gate`, independent of `openclaw-native`. The reusable workflow derives slug/name from `SKILL.md` and dedupes by content fingerprint (new skill → `1.0.0`, changed → next patch), retry-safe like the leg above; V1 skill publishing has no OIDC path either, so it reuses the same stored `CLAWHUB_TOKEN` |
| `publish-browser-ext` | `browser-extension` | `gate` + `package` | `contents: read` | `wxt submit --dry-run` (every push and pull request: auth plus zip check, no listing mutation) then, only `if: github.event_name == 'push'` (a tag), the real `wxt submit`, downloading `package`'s own zips from the artifact rather than rebuilding. Env-gated per store on that store's own secrets — Chrome via Web Store API **v2** (service-account auth: `CHROME_EXTENSION_ID`/`CHROME_PUBLISHER_ID`/`CHROME_SERVICE_ACCOUNT_CLIENT_EMAIL`/`CHROME_SERVICE_ACCOUNT_PRIVATE_KEY`; v1/v1.1 shuts off 15 Oct 2026 and used a different client-id/secret/refresh-token shape), Firefox (`FIREFOX_EXTENSION_ID`/`FIREFOX_JWT_ISSUER`/`FIREFOX_JWT_SECRET`), Edge (`EDGE_PRODUCT_ID`/`EDGE_CLIENT_ID`/`EDGE_API_KEY`) — a store left unconfigured is skipped, never a failure, so the leg is green with zero store secrets configured. None of the three stores supports GitHub OIDC, so — like `publish-clawhub` — this is a stored-secrets leg |
| `publish-browser-ext-safari` (opt-in) | `browser-extension` + `tool.json` `browserExtension.safari` | `gate` | `contents: read` | the macOS host-native leg, `runs-on: macos-latest`, never in the default matrix: `xcrun safari-web-extension-converter` on the `wxt build -b safari` payload, then an Xcode archive/export signed with an App Store Connect API key (`ASC_KEY_ID`/`ASC_ISSUER_ID`/`ASC_PRIVATE_KEY`). Submits to App Store Connect, not `dist/release/`, so it never gates `release` |
| `release` | always | `package` + every publish leg | `contents: write` | `download-artifact` → `softprops/action-gh-release` with `generate_release_notes`, so the tag's release carries the same assets the registries got |
| `pages-build` | `web` | `gate` | `contents: read` | `configure-pages`, the web build with `PAGES_BASE=/<repo>/` (a project page is not served from the domain root), `tool.schema.json` + `COVERAGE.md` + `coverage.json` copied in, `upload-pages-artifact` |
| `pages-deploy` | `web` | `pages-build` | `pages: write`, `id-token: write` | `deploy-pages`, environment `github-pages` |

toolfactory runs no publish itself. `bootstrap-repo` does what `gh` can — the secrets, the
`live-tests` environment, enabling Pages with Source = GitHub Actions, and `npm trust` once the
package exists (the very first npm publish can only use a token) — and `secrets status` prints
the rest: the `ghcr.io` image is **private on its first push whatever the repository's visibility**
(a package inherits the repository's access permissions, not its visibility) and GitHub has no API
to change that, so it is made public once by hand; PyPI's pending trusted publisher is web-only,
confirmed with the `PYPI_TRUSTED_PUBLISHER` repository variable; the stores' listings are
dashboard-only. `wxt submit --dry-run` reaches the network only for Chrome (API v2 `fetchStatus`)
and Firefox (`GET /api/v5/addons/addon/{id}`); for Edge it proves the zip, not the token. Everything that is GitHub-only — OIDC publishing, Pages, ghcr, the
live-tests environment — is simply absent from a project built without it; `toolfactory gate` and
`toolfactory package` are not.

## 8. Upstream compatibility

- **C1: Own no validator.** Every conformance check shells to the ecosystem's own tool.
- **C2: Mirror scaffolds by execution.** The OpenClaw validator diffs the generated package against
  a fresh `openclaw plugins init`, so an upstream scaffold change fails validation by name instead
  of rotting silently.
- **C3: Preserve the unknown** (S8). Deselecting a surface uninstalls its keys and empties its
  regions; it never deletes a file the author writes in.
- **C4: Grow by fixed location.** A new host location means a projector, a validator and a coverage
  row. No model change, because the model is the ecosystem's own specs.
- **C5: Version the lock.** `lock.json` records the toolfactory version that wrote it.
- **C6: Break toolfactory, never users.** Committed files keep working when upstream moves;
  regeneration is opt-in per version bump.

## 9. toolfactory itself

### 9.1 First-party tooling

Every project toolfactory generates carries the same agent-config canon as toolfactory's own
(§3, the `agents` surface): skills in `.agents/skills/`, MCP servers in `.agents/mcp/servers.json`,
rendered into every harness by `.agents/sync.py`. Nothing is registered by hand and no generated
document tells a reader to paste a `mcpServers` snippet: `build` writes the tool's own kernel and
the first-party servers of the selected surfaces into that one file, `init` installs the
first-party skills with `npx skills add <owner/repo>@<skill>`, and `.agents/setup` renders both
into whichever harnesses are on the machine. What a repository cannot do is reload a session that
is already open, so `init` prints the one reload line of the harness it is running inside and the
generated `AGENTS.md` carries the table it comes from.

`init` also seeds `keywords` on the identity file, defaulting to `[name]` when `--keywords` is
omitted: Kiro Powers and Agent Plugins hosts key activation off `plugin.json.keywords`, and
`package.json`/`pyproject.toml` carry the same field for the npm/pypi metadata projections, so one
seed at `init` time covers every projection rather than a per-surface default.

toolfactory's own canon adds `github` and `openai-docs`, which are its own repository's business,
not a generated project's; the merge semantics keep them. Projects that publish nothing
first-party (Hermes, Cursor, Gemini, TypeScript, Biome, Vitest, Zod, Vite, Tailwind, uv) get no
substitute: agents use their CLIs.


toolfactory is described by its own `dev.toolfactory/tool.json` and every generated artifact in
its repo is produced by `toolfactory build`. `toolfactory check` and `toolfactory validate` run in
its own CI. Its operations (`init`, `introspect`, `build`, `check`, `validate`, `coverage`,
`adopt`, `unadopt`, `eject`, `gate`, `package`, `doctor`, `secrets`, `bootstrap-repo`, `unpublish`) are declared once in `src/ops.ts`; the CLI and the MCP
server are generated from them exactly as for any other tool. Its selected surfaces include the
OpenClaw-native and Hermes-native shims, because those generators track the fastest-moving hosts
and must be exercised by toolfactory's own release, and the web surface, whose scaffold is
mirrored from upstream generators that move just as fast.

## 10. Scope

**Ships in v0.** Bindings: TypeScript, Python. Surfaces: every row of §3. Commands: those listed
in §9 plus `mcp`.

**Not in v0** (each is a documented gap, not an implied feature): yarn and bun workflows (the
loader rejects other `packageManager` values with a message); nightly golden tests of generators against upstream `latest` and
`@beta`; GUI (Tauri), MCPB and GitHub Releases binaries; Go and Rust bindings; a DSH plugin with
Cordis code of its own — the `dsh` surface ships the zero-code bundle, and anything beyond it is gated
on DSH's first non-alpha tag; A2A, WebMCP, UTCP.

**Out permanently:** a TUI (`mcp-inspector` exists); a toolfactory runtime library in any
language; JSON Schema → native-schema conversion; any reimplementation of a validator that exists.
