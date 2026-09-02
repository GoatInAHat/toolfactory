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

[![skills.sh](https://skills.sh/b/GoatInAHat/toolfactory)](https://skills.sh/GoatInAHat/toolfactory)

- **Agent Skill** — `npx skills add GoatInAHat/toolfactory`
- **MCP server** — `npx -y toolfactory mcp` [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect/mcp/install?name=toolfactory&config=%7B%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22toolfactory%22%2C%22mcp%22%5D%7D) [![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=toolfactory&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsInRvb2xmYWN0b3J5IiwibWNwIl19)
- **Claude Desktop extension** — download `toolfactory.mcpb` from the GitHub Release and double-click to install
- **Claude Code plugin** — `claude plugin marketplace add GoatInAHat/toolfactory`, then `claude plugin install toolfactory@toolfactory`
- **Codex plugin** — `codex plugin marketplace add GoatInAHat/toolfactory`, then `codex plugin add toolfactory@toolfactory`
- **Gemini CLI extension** — `gemini extensions install https://github.com/GoatInAHat/toolfactory`
- **OpenClaw plugin** — `openclaw plugins install --link hosts/openclaw` from a checkout
- **Hermes plugin** — `hermes plugins install https://github.com/GoatInAHat/toolfactory#hosts/hermes/toolfactory_hermes`
- **DSH plugin** (experimental) — `dsh plugin --profile <profile> add ./hosts/dsh` from a checkout, or the release tarball `toolfactory-dsh-0.1.0.tgz`
- **Browser extension** — from a checkout: `npm --prefix hosts/browser install && npm --prefix hosts/browser exec --no -- wxt build`,
  then `chrome://extensions` → developer mode → Load unpacked → `hosts/browser/.output/chrome-mv3`
  (Firefox: `npm --prefix hosts/browser exec --no -- web-ext run`). Each GitHub Release attaches the
  store uploads `toolfactory-0.1.0-chrome.zip`, `toolfactory-0.1.0-firefox.zip`, `toolfactory-0.1.0-edge.zip`, and the Mozilla-signed `.xpi`,
  which is the only download-and-install channel now that Chrome no longer keeps side-loaded unpacked
  extensions; the Chrome Web Store, Firefox Add-ons and Edge Add-ons listings appear once the release's
  submit step has each store's credentials. Then pair it: `npx -y toolfactory mcp --http --pair`
  prints the `<url>#<token>` the extension's options page accepts.
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
| `mcp-registry` | `server.json` | `mcp-publisher` |
| `mcpb` | `hosts/mcpb/manifest.json` and a `.mcpb` release asset packed from the npm tarball — the one-click install Claude Desktop takes | `mcpb validate` |
| `openclaw-native` | `hosts/openclaw/`, mirroring `openclaw plugins init --type tool` | `openclaw plugins build --check`, `validate`, plugin-inspector |
| `hermes-native` | `hosts/hermes/`, a manifest v2 plugin | `hermes plugins doctor --ci` |
| `web` | `web/`, a shadcn/ui (Vite, React, Tailwind) app with a form per operation; your own pages sit beside it in `App.tsx` | `vite build`, Playwright |
| `browser-extension` | `hosts/browser/`, one WXT extension built for Chromium, Firefox and Safari: the worker calls your kernel over loopback MCP, the popup is the `web` app, and the operations that need a page are yours to write in `entrypoints/` | `wxt build`, `web-ext lint`, Playwright against a real Chromium |
| `dsh` (experimental) | `hosts/dsh/`, a zero-code DSH (DeepSeek Harness) bundle: one Cordis patch row attaching your MCP server through `@deepseek-ai/dsh-mcp-client` | a keyless `dsh --profile headless` boot |
| workflows (always) | `ci.yml`, `release.yml` (gate → package → publish legs → GitHub Release, plus Pages), `compose.toolfactory.yaml`, `.env.example`, `renovate.json`; every step is one `toolfactory gate` / `toolfactory package` runs without GitHub | the workflow itself |
| readme (always) | the Install section of `README.md` (a marked region): one install line per selected surface, plus the skills.sh badge | — |

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
