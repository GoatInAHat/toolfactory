# toolfactory

Build an agent tool once; ship it as an Agent Skill, an Agent Plugins bundle, a Claude Code,
Codex or Cursor plugin, an MCP server, a CLI, an npm or PyPI package, an MCP Registry entry, an
OpenClaw or Hermes native plugin, and a web page, from one operation module and one config file.

toolfactory is a scaffolder and a keeper-in-sync, not a runtime. It writes each surface in the
shape that surface's own tooling would have written, proves it with that surface's own validator,
and records every generated file in a lock so drift fails CI. Delete toolfactory from a repo it
generated and every surface still installs, builds and publishes.

## Quickstart

```sh
mkdir hello && cd hello
npx toolfactory init --name hello --binding typescript --surfaces skill,agent-plugins,claude,mcp,cli,npm
npm install
```

`init` writes `plugin.json` (identity), `dev.toolfactory/tool.json` (surfaces, binding, config),
the kernel scaffold, and the first build. Then:

1. Write operations in `src/ops.ts` (TypeScript) or `src/<pkg>/ops.py` (Python). Each one is a
   name, a description, an input schema, an optional output schema, an optional `requires`
   list, and a handler.
2. `npx toolfactory introspect` spawns the kernel MCP server and snapshots `tools/list` into
   `dev.toolfactory/ops.json`.
3. `npx toolfactory build` regenerates every selected surface in-tree.
4. `npx toolfactory validate` runs each surface's upstream validator.
5. Commit everything. CI runs `check` (drift) and `validate`.

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
| `init` | new tool: identity file, `tool.json`, kernel scaffold, first build |
| `introspect` | snapshot the kernel's `tools/list` into `ops.json` |
| `build` | regenerate every selected surface; delete orphans; write the lock |
| `check` | fail if the operation snapshot or any generated file drifted from the code (the CI gate) |
| `validate [--surface]` | run each surface's upstream validator |
| `coverage` | the operation × surface verdict matrix |
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
| workflows (always) | `ci.yml`, `release.yml`, `compose.toolfactory.yaml`, `.env.example`, `renovate.json` | the workflow itself |

## Driving toolfactory from an agent

Every command is an MCP tool, so a host can drive the whole loop without a shell. Register once:

```json
{ "mcpServers": { "toolfactory": { "command": "npx", "args": ["toolfactory", "mcp"] } } }
```

`root` is an argument of every tool, so one registration serves every generated repository on the
machine. Inside OpenClaw, install the tool you are building with
`openclaw plugins install --link <repo>/hosts/openclaw --force`; inside Hermes, commit and run
`hermes plugins install file://<repo>#hosts/hermes/<pkg>` then `hermes gateway restart`.

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
