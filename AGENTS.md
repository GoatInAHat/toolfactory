# toolfactory

Build an agent tool once and ship it as every surface: Agent Skill, Agent Plugins
bundle, Claude/Codex/Cursor plugin, MCP server, CLI, npm/PyPI package, MCP
Registry entry, OpenClaw and Hermes native plugins, web page. toolfactory is a
scaffolder and keeper-in-sync, never a runtime: every artifact is a projection of
one identity file plus `dev.toolfactory/tool.json` and the operation snapshot
`ops.json`, committed in-tree and SHA-locked. Design: `docs/spec.md`.

## Commands

- `pnpm check` (Biome + tsc), `pnpm test` (Vitest, `src/**/*.test.ts`).
- `pnpm toolfactory <cmd>` runs the CLI from source (`node --import tsx`).
  `introspect` after editing `src/ops.ts`; `build` after any generator change;
  `check` is the drift gate; `validate` runs upstream validators (needs the
  CLIs `doctor` lists). `pnpm build` emits `dist/` for publishing.
- Node 24 (needed by the `openclaw` CLI) is at
  `/opt/nvm/versions/node/v24.20.0/bin`; Node 22 is the default.

## Layout

- `src/model.ts` the shared plane (types, capability vocabulary, `tool.json`
  schema). `src/identity/` identity file read + name projection.
  `src/project/` plan, apply/check, lock. `src/introspect/` kernel spawn +
  snapshot. `src/report/` coverage. `src/surfaces/<id>.ts` one pure
  `plan(project)` projector per surface, registered in `registry.ts`.
  `src/bindings/<lang>.ts` kernel + scaffold templates per language.
  `src/commands.ts` the operations' bodies; `src/ops.ts` toolfactory's own
  operations, from which `src/toolfactory/{cli,mcp}.ts` are generated.
- `schemas/agent-plugins/` the only vendored schemas (spec forbids fetching).
- Generated (never hand-edit; `adopt` first if you must): everything listed in
  `dev.toolfactory/lock.json`.

## Conventions

- Projectors are pure; side effects live in `validate()` command specs or
  `commands.ts`. Delegate every validation to the upstream tool; vendor nothing
  that has a CLI. Mirror upstream scaffolds by execution, not transcription.
- No toolfactory runtime library in any language; generated tools depend only
  on the upstream SDKs. Schema direction is native → JSON Schema only.
- Adding a surface: projector + optional `validate`/`verdict`, a row in
  `SURFACE_IDS`, `registry.ts`, `docs/spec.md` §3 and the README table.

## Defaults

- Work smart, not hard. Never reinvent the wheel. Design systems on a tech
  stack that fits together so the desired behavior is emergent and the
  necessary mechanisms are implicit. Write as little of your own code as
  possible; when you do write custom handling, there must be a good reason
  why, and your implementations and abstractions must be standardized across
  the codebase. This applies to how dependencies are used too: a tech stack
  often offers several ways to do one thing, so standardize on the one that
  covers all the bases at once. Done properly, all of this massively reduces
  codebase complexity.
- As an extension of the previous dogma, no filler content. On the frontend
  that means no UI bloat — random static text, elements that don't need to
  exist. On the backend it means no handling for edge cases that will never
  happen because the dogmas above already handle them implicitly, no API
  routes or logic for features that will never exist, and no specialization
  where generalization wins.
- Drive-by refactors are fine when you understand the full context and they
  bring previously written code in line with these dogmas. Codebases evolve,
  and abstractions and implementations must stay fluid enough to keep
  aligning with best practices. One critical pathology is hanging on to poor
  past design decisions and letting them degrade the trajectory of
  development by continuously working around them.
- Maintain the fewest tests that cover the requisite variety of the
  codebase. Coding agents tend to treat tests as append-only; tests that are
  never updated or consolidated lock in earlier bad architecture decisions.
- Beyond tests, agentically prove changes work the way a user would run
  them — a real browser for UIs, a real invocation for CLIs and services.
- Secrets stay in the environment or a gitignored `.env`, never in git.
- Update docs in the same change that outdates them.
- Keep this document lean and token-efficient.
- When dispatching subagents, dynamic workflows, and other delegated work,
  use a balanced set of models — not everything needs the most expensive one.
  Dispatch subagents for the bulk of the work to keep tool output from
  bloating your context, but read important information yourself to reason
  over it in full detail rather than through a lossy summary.

## Agent config

Skills and MCP servers live once in `.agents/` — `skills/` and
`mcp/servers.json` — and sync to every harness automatically, in both
directions; `CLAUDE.md`, `GEMINI.md`, and the per-harness configs are
generated from here. Personal-only config: gitignored `.agents/local/`, same
shape. Details and commands: `.agents/README.md`.

`rtk` compresses command output; when output will be large and no hook
rewrote the command, prefix it yourself: `rtk git diff`, `rtk pytest`.
