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
- **MCP server** — `npx -y toolfactory mcp`
- **Claude Code plugin** — `claude plugin marketplace add GoatInAHat/toolfactory`, then `claude plugin install toolfactory@toolfactory`
- **OpenClaw plugin** — `openclaw plugins install --link hosts/openclaw` from a checkout
- **Hermes plugin** — `hermes plugins install https://github.com/GoatInAHat/toolfactory#hosts/hermes/toolfactory_hermes`
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
| `init` | new tool: identity file, `tool.json`, kernel scaffold, first build, `git init` + first commit, `.agents/setup`; `--repo <owner>/<name>` creates the GitHub repository (private; `--public` opts out) and pushes it |
| `introspect` | snapshot the kernel's `tools/list` into `ops.json` |
| `build` | regenerate every selected surface; delete orphans; write the lock |
| `check` | fail if the operation snapshot or any generated file drifted from the code (the CI gate) |
| `validate [--surface]` | run each surface's upstream validator |
| `coverage` | the operation × surface verdict matrix |
| `gate` | run what CI runs, here: build, drift check, validators, your checks and tests, host e2e — stopping at the first failure |
| `package` | build every release asset into `dist/release/` (npm tarball, distributions, plugin tarball and bundle zip, web build, coverage) |
| `adopt` / `unadopt` / `eject` | take a file (or a whole surface) over from toolfactory, or give it back |
| `doctor` | which upstream CLIs this machine can delegate to |
| `bootstrap-repo` | create the `live-tests` GitHub environment (required reviewers) and push its secrets from `.env` via `gh` |

## Surfaces

| Surface | Emits | Validated by |
|---|---|---|
| `skill` | `skills/<name>/SKILL.md` (frontmatter + operations block; body is yours) | `agentskills validate` |
| `agent-plugins` | root `plugin.json` + `mcp.json` (consumed by OpenClaw, Hermes, Copilot, Cursor, Codex) | Ajv against the 1.0.0 schemas |
| `claude` | `.claude-plugin/plugin.json` | `claude plugin validate` |
| `codex`, `cursor` | `.codex-plugin/`, `.cursor-plugin/` manifests | schema-shaped |
| `mcp`, `cli` | the kernel MCP server (stdio, or `--http`) and a CLI over your operations; each lists only the operations it can run | MCP Inspector, `--help` |
| `npm`, `pypi` | package metadata merged into `package.json` / `pyproject.toml` | `npm pack`, `uv build` |
| `mcp-registry` | `server.json` | `mcp-publisher` |
| `openclaw-native` | `hosts/openclaw/`, mirroring `openclaw plugins init --type tool` | `openclaw plugins build --check`, `validate`, plugin-inspector |
| `hermes-native` | `hosts/hermes/`, a manifest v2 plugin | `hermes plugins doctor --ci` |
| `web` | `web/`, a shadcn/ui (Vite, React, Tailwind) app with a form per operation; your own pages sit beside it in `App.tsx` | `vite build`, Playwright |
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
