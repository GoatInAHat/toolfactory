# toolfactory

Build an agent tool once; ship it as an Agent Skill, an Agent Plugins bundle, a Claude Code,
Codex or Cursor plugin, an MCP server, a CLI, an npm or PyPI package, an MCP Registry entry, an
OpenClaw or Hermes native plugin, and a web page, from one operation module and one config file.

toolfactory is a scaffolder and a keeper-in-sync, not a runtime. It writes each surface in the
shape that surface's own tooling would have written, proves it with that surface's own validator,
and records every generated file in a lock so drift fails CI. Delete toolfactory from a repo it
generated and every surface still installs, builds and publishes.

<!-- tf:install -->
## Install

[![Agent Skill](https://img.shields.io/badge/Agent_Skill-available-5B5BD6)](https://github.com/GoatInAHat/toolfactory)

- **Agent Skill** — `npx skills add GoatInAHat/toolfactory`
- **MCP server** — `npx -y toolfactory mcp` [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect/mcp/install?name=toolfactory&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22toolfactory%22%2C%22mcp%22%5D%7D) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=toolfactory&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsInRvb2xmYWN0b3J5IiwibWNwIl19)
- **Claude Desktop extension** — download `toolfactory.mcpb` from the GitHub Release and double-click to install
- **Claude Code plugin** — `claude plugin marketplace add GoatInAHat/toolfactory`, then `claude plugin install toolfactory@toolfactory`
- **Codex plugin** — `codex plugin marketplace add GoatInAHat/toolfactory`, then `codex plugin add toolfactory@toolfactory`
- **Gemini CLI extension** — `gemini extensions install https://github.com/GoatInAHat/toolfactory`
- **OpenClaw plugin** — `openclaw plugins install --link hosts/openclaw` from a checkout
- **Hermes plugin** — `hermes plugins install https://github.com/GoatInAHat/toolfactory#hosts/hermes/toolfactory_hermes`
- **DSH plugin** (experimental) — `dsh plugin --profile <profile> add ./hosts/dsh` from a checkout, or the release tarball `toolfactory-dsh-0.2.0.tgz`
- **Web app** — `npx -y toolfactory mcp --http --open` serves the operations page beside the
  MCP endpoint on one port and opens it; over MCP or a skill, the `web` operation does the same and
  returns the URL.
- **npm package** — `npm install toolfactory`

<!-- /tf:install -->

## Quickstart

```sh
mkdir hello && cd hello
npx toolfactory init --name hello --binding typescript --surfaces skill,agent-plugins,claude,mcp,cli,npm
```

`init` writes `plugin.json` (identity), `dev.toolfactory/tool.json` (surfaces, binding, config),
the kernel scaffold, the `.agents/` agent-config canon (skills, MCP servers, `sync.py`, `setup`
and the per-harness hook carriers, so the tool is developable in any harness), and the first
build. It also does what a human would do next: `git init` and a first commit, then
`bash .agents/setup`, which renders the harness adapters, installs the git hooks that keep them
in sync, and installs the dependencies. Its `nextSteps` end with the one reload line of the
harness it is running inside, because reload is the one part a repository cannot automate.

Add `--repo <owner>/<name>` and it creates that GitHub repository through `gh` and pushes to it —
**private unless you pass `--public`** — with one topic per selected surface, and prepares the
live-tests environment when a `.env` is there. `--dryRun` prints the `gh` invocations instead.
None of it is required: with no GitHub, plain git or no git at all, everything below still works.

### Instruction-only Codex plugin

Use `--runtime none --surfaces skill,codex` when a plugin is only SKILL.md instructions for
Codex. ToolFactory then emits no MCP server, operation snapshot, language scaffold, or consumer
runtime dependency. `binding` remains required for config compatibility but is unused in this
mode. This is available in the published npm package starting with ToolFactory 0.1.1.

1. Write operations in `src/ops.ts` (TypeScript) or `src/<pkg>/ops.py` (Python). Each one is a
   name, a description, an input schema, an optional output schema, an optional `requires`
   list, and a handler.
2. `npx toolfactory introspect` spawns the kernel MCP server and snapshots `tools/list` into
   `dev.toolfactory/ops.json`.
3. `npx toolfactory build` regenerates every selected surface in-tree.
4. `npx toolfactory gate` runs what CI runs, here: build, the drift check, every surface's
   upstream validator, your own checks and tests, and the credential-free host end-to-end.
5. Commit everything. `npx toolfactory package` builds the release assets into `dist/release/`;
   CI runs the same gate and, on a `v*` tag, the same package job before publishing.

A TypeScript operation:

```ts
operation({
  name: "echo",
  description: "Echo text back.",
  input: z.object({ text: z.string() }),
  output: z.object({ text: z.string() }),
  annotations: { readOnlyHint: true },
  handler: async ({ text }) => ({ text }),
})
```

## Commands

Every command exists as a CLI subcommand and as an MCP tool (`toolfactory mcp`), because
toolfactory is built with toolfactory.

| Command | Does |
|---|---|
| `init` | new tool: identity file (`keywords` defaults to `[name]`, the Kiro Powers/Agent Plugins activation trigger; `--keywords` overrides), `tool.json`, kernel scaffold, first build, `git init` + first commit, `.agents/setup`; `--repo <owner>/<name>` creates the GitHub repository (private; `--public` opts out) and pushes it |
| `introspect` | snapshot the kernel's `tools/list` into `ops.json` |
| `build` | regenerate every selected surface; delete orphans; write the lock |
| `check` | fail if the operation snapshot or any generated file drifted from the code (the CI gate) |
| `validate [--surface]` | run each surface's upstream validator |
| `coverage` | the operation × surface verdict matrix |
| `gate` | run what CI runs, here: build, drift check, validators, your checks and tests, host e2e — stopping at the first failure |
| `package` | build every release asset into `dist/release/` (npm tarball, distributions, plugin tarball and bundle zip, web build, coverage) |
| `adopt` / `unadopt` / `eject` | take a file (or a whole surface) over from toolfactory, or give it back |
| `doctor` | which upstream CLIs this machine can delegate to |
| `secrets` | every credential the project needs — its own sensitive config keys and the release registries' tokens — with where to mint each, whether it is present locally and on GitHub, and (`--action check`) whether the registry accepts it; never a value |
| `bootstrap-repo` | push `.env` to GitHub through `gh` (config keys to the `live-tests` environment, release tokens to the repository), enable Pages, configure npm trusted publishing once the package exists, and print the one-time steps that are left |
| `unpublish` | retract every registry a surface dropped since the previous tag published to; the release runs it, `--dryRun` shows it |

## Surfaces

Skills first. `init` selects the minimum that already serves every harness — `skill`,
`agent-plugins`, `mcp`, `cli` and the binding's package registry — because everywhere that
takes a plugin also takes a skill plus an MCP server, and a skill is one file with no upstream to
track. Every host-specific plugin below is opt-in: add it only when that host needs what a skill
and an MCP server cannot give it (a gateway tab, browser capability, a store listing).

| Surface | Emits | Validated by |
|---|---|---|
| `skill` | `skills/<name>/SKILL.md` (frontmatter + operations block; body is yours), plus `.agents/skills/<name>`, a symlink to it, so Copilot, Codex, Hermes, DSH and `.agents/sync.py` see the same one skill | `agentskills validate` |
| `agent-plugins` | root `plugin.json` + `mcp.json` (consumed by OpenClaw, Hermes, Copilot, Cursor, Codex) | Ajv against the 1.0.0 schemas |
| `claude` | `.claude-plugin/plugin.json` | `claude plugin validate` |
| `codex` | `.codex-plugin/plugin.json` + `.agents/plugins/marketplace.json` (`codex plugin marketplace add <owner>/<repo>`) | real Codex CLI: marketplace add, plugin add, plugin list |
| `cursor` | `.cursor-plugin/` manifest | schema-shaped |
| `gemini` | root `gemini-extension.json` — a Gemini CLI extension installable straight from the repo, reading your `AGENTS.md` and `skills/` | `gemini extensions validate` |
| `mcp`, `cli` | the kernel MCP server (stdio, or `--http`) and a CLI over your operations; each lists only the operations it can run | MCP Inspector, `--help` |
| `npm`, `pypi` | package metadata merged into `package.json` / `pyproject.toml` | `npm pack`, `uv build` |
| `cargo`, `nuget`, `maven-central`, `rubygems`, `packagist`, `go-module` | releases for author-owned native packages alongside the tool; metadata stays in its native format | Cargo, .NET, Maven, RubyGems, Composer, Go |
| `homebrew`, `winget`, `scoop`, `chocolatey`, `apt`, `rpm` | native packaging and catalog/repository distribution on the appropriate OS | the manager's own tooling |
| `mcp-registry` | `server.json` | `mcp-publisher` |
| `mcpb` | `hosts/mcpb/manifest.json` and a `.mcpb` release asset packed from the npm tarball — the one-click install Claude Desktop takes | `mcpb validate` |
| `openclaw-native` | `hosts/openclaw/`, mirroring `openclaw plugins init --type tool` | `openclaw plugins build --check`, `validate`, plugin-inspector |
| `hermes-native` | `hosts/hermes/`, a manifest v2 plugin | `hermes plugins doctor --ci` |
| `web` | `web/`, a shadcn/ui (Vite, React, Tailwind) app with a form per operation; your own pages sit beside it in `App.tsx` | `vite build`, Playwright |
| `browser-extension` | `hosts/browser/`, one WXT extension built for Chromium, Firefox and Safari: the worker calls your kernel over loopback MCP, the popup is the `web` app, and the operations that need a page are yours to write in `entrypoints/` | `wxt build`, `web-ext lint`, Playwright against a real Chromium |
| `vscode-extension` | `hosts/vscode/`, a native TypeScript extension with MCP discovery, command palette operations, settings and SecretStorage; activation and native contributions are yours | Microsoft `generator-code` scaffold comparison, `vsce package`, real Extension Development Host |
| `dsh` (experimental) | `hosts/dsh/`, a zero-code DSH (DeepSeek Harness) bundle: one Cordis patch row attaching your MCP server through `@deepseek-ai/dsh-mcp-client` | a keyless `dsh --profile headless` boot |
| workflows (always) | `ci.yml`, `release.yml` (gate → package → publish legs → GitHub Release, plus Pages), `compose.toolfactory.yaml`, `.env.example`, `renovate.json`; every step is one `toolfactory gate` / `toolfactory package` runs without GitHub | the workflow itself |
| readme (always) | the Install section of `README.md` (a marked region): one install line per selected surface, plus a static Agent Skill badge | — |

Select `vscode-extension` together with `mcp`, `cli`, and the runtime registry (`npm` for
TypeScript, `pypi` for Python). Set `vscode.publisher` in `dev.toolfactory/tool.json`, then build.
Open `hosts/vscode` and press F5 to use the checkout's runtime, or run `npm run vsix` in that
directory to package it. Native commands, views, webviews, language services, chat participants,
and language-model tools use the full VS Code API in your own `src/extension.ts`. Add contribution
points directly to its `package.json`; rebuilds preserve author entries and additional fields
on generated entries. Marketplace and Open VSX release jobs use `VSCE_PAT` and `OVSX_PAT` after
you register the publisher. Both can be disabled individually in `tool.json`.

The same native customization rule applies to the other surfaces: JSON, TOML and YAML manifests
merge only projected fields, and host entry points retain your code outside the marked regions.
OpenClaw, Hermes, DSH and browser shims can use their host's complete native API. `adopt` and
`eject` remain available when replacing a generated integration entirely.

Package distribution is opt-in. PyPI supports both `pip install` and `uv add`; pip uses the same
published wheel/sdist. Other ecosystems consume real native packages and metadata supplied by the
author. See [native package releases](docs/native-package-releases.md) and
[system package releases](docs/system-package-releases.md) for configuration and registry setup.
Toolfactory itself continues to use npm as its package registry.

## Driving toolfactory from an agent

Every command is an MCP tool, so a host can drive the whole loop without a shell — and nothing is
registered by hand. Every generated project carries the `.agents/` canon, so `toolfactory` and the
tool's own kernel are already entries in `.agents/mcp/servers.json`, which `bash .agents/setup`
renders into whichever harnesses are on the machine (`.mcp.json`, `.cursor/mcp.json`,
`.codex/config.toml`, …) and keeps in sync from every one of them. `root` is an argument of every
tool, so one registration serves every repository on the machine; from inside a host worktree,
pass it explicitly.

Reload is the one part a repository cannot automate, so `init` prints the line that matches the
harness it is running inside, and the generated `AGENTS.md` carries the table it comes from.
Inside OpenClaw, install the tool you are building with
`openclaw plugins install --link <repo>/hosts/openclaw --force`; inside Hermes, commit and run
`hermes plugins install file://<repo>#hosts/hermes/<pkg>` — every `hermes` run is a fresh process,
and `hermes gateway restart` is only for the messaging gateway.

GSD uses the same skills, CLI and MCP server; no GSD-specific surface is needed. From a generated
project, run `bash .agents/setup --all` so `.mcp.json` is rendered even on a GSD-only machine,
then discover its server in an interactive GSD session before unattended use. GSD launched by
OpenClaw or Hermes loads the child project's configuration separately from the outer agent.
See [GSD compatibility](docs/gsd.md) for setup, runtime boundaries and the repeatable smoke test.

## The boundary

Core logic is a pure function of JSON arguments, environment/config and the filesystem. An
operation declares what it needs from a closed vocabulary: `net`, `fs`, `shell`, `secret` are
portable; `browser`, `model`, `user-input`, `channel` are not. Every surface gets a per-operation
verdict (`native`, `bridged`, `degraded`, `excluded`, with a reason) in `COVERAGE.md`, and an
excluded operation is left off that surface's tool list rather than stubbed. A tool that needs a
browser is written as two operations: one that takes the page content as an argument and runs
everywhere, and one that declares `browser` and runs only where a browser exists.

See [docs/spec.md](docs/spec.md) for the normative design.

## Repository

toolfactory's own repo is generated by `toolfactory build` from its `dev.toolfactory/tool.json`.
`pnpm check`, `pnpm test`, `pnpm toolfactory check` and `pnpm toolfactory validate` are the gates.
