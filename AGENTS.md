# <Project>

<!-- setup keep=GoatInAHat/template -->
One-time bootstrap: if no environment hook ran it yet, run
`bash .agents/setup`. Its first successful run makes everything in Agent
config automatic and deletes this notice.
<!-- /setup -->

Created from a blank, stack-agnostic template. The first real task defines
the project: pick the stack that fits, set up its tooling, and replace this
paragraph with what the project is.

Record here what can't be inferred from the code: commands, layout,
conventions, decisions; drop anything that stops being true.

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
