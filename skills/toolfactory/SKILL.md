---
name: toolfactory
description: Build an agent tool once; ship it as Agent Skills, MCP servers,
  Agent Plugins / Claude / Codex / Cursor bundles, OpenClaw and Hermes plugins,
  CLIs, and packages, with the tests and releases to match.
license: MIT
---

# toolfactory

Use toolfactory when a user wants to build an AI agent tool once and ship it to several
surfaces, or wants one surface done the way that ecosystem's own tooling would do it:
Agent Skills, Agent Plugins bundles (Claude Code, Codex, Cursor, VS Code / Copilot, OpenClaw
and Hermes bundle installs), MCP servers, OpenClaw native plugins, Hermes plugins, CLIs,
npm / PyPI packages, and the CI and release workflows for all of them.

## How a toolfactory project is shaped

- Identity (name, version, description, author, license, repository) is authored once in the
  identity file named by `dev.toolfactory/tool.json` (usually `plugin.json`, the Agent Plugins
  manifest). Edit that file to rename or bump a version; never edit a projected copy.
- Operations live in the author's code (`src/ops.ts` or `src/<pkg>/ops.py`) as plain objects
  with a name, description, input schema, optional output schema, `requires` capabilities, and
  a handler. `toolfactory introspect` spawns the kernel MCP server and snapshots `tools/list`
  to `dev.toolfactory/ops.json`; every generator reads that snapshot.
- Everything else is generated in-tree by `toolfactory build` and tracked in
  `dev.toolfactory/lock.json`. Generated files say so in their header. To take one over, run
  `toolfactory adopt <path>`; to hand a whole surface back to the author, `toolfactory eject <surface>`.
- `SKILL.md` bodies are the author's prose; only the frontmatter and the operations block
  below are generated.

## Workflow

1. New tool: `toolfactory init --name <n> --binding typescript|python [--surfaces <a,b,c>] --repository <url>`
   (no `--surfaces` = skills first: skill, agent-plugins, mcp, cli and the package registry; add a
   host plugin only when that host needs what a skill and an MCP server cannot give it),
   then install dependencies (`pnpm install` or `uv sync`).
2. Add or change operations in the ops module, then `toolfactory introspect` and `toolfactory build`.
3. `toolfactory check` is the CI drift gate; `toolfactory validate` runs each surface's own upstream
   validator (agentskills, `claude plugin validate`, MCP Inspector, `openclaw plugins validate`,
   `hermes plugins doctor`, `npm pack`, `uv build`).
4. `toolfactory coverage` shows, per operation and surface, whether it runs natively, is bridged,
   degraded, or excluded, and why. Operations that need a browser, a model, user input, or a chat
   channel are only emitted on hosts that provide them; split such work into a pure operation that
   takes the data as an argument plus a host-specific one.
5. Never hand-write a host manifest that toolfactory generates; change the identity file or
   `tool.json` and rebuild. Never add a toolfactory runtime dependency to a generated tool: its
   dependencies are only the upstream SDKs.

<!-- tf:operations -->
## Operations

### adopt

Stop regenerating one file; it becomes the author's (recorded as manual in the lock).

Arguments: `root`, `path`.

`toolfactory adopt --json '<arguments>'` prints a JSON result. MCP tool `adopt` on server `toolfactory` returns the same result as `structuredContent`.

### bootstrap-repo

Prepare the GitHub repository from the local .env: the `live-tests` environment with its required reviewers and the sensitive config keys inside it, the release registries' tokens at repository scope, GitHub Pages with source = Actions, and npm's trusted publisher. Values go to `gh` on stdin and are never returned.

Arguments: `root`, `reviewers`, `dryRun`.

`toolfactory bootstrap-repo --json '<arguments>'` prints a JSON result. MCP tool `bootstrap-repo` on server `toolfactory` returns the same result as `structuredContent`.

### build

Generate every selected surface in-tree from the identity file and the operation snapshot, and refresh the lock.

Arguments: `root`.

`toolfactory build --json '<arguments>'` prints a JSON result. MCP tool `build` on server `toolfactory` returns the same result as `structuredContent`.

### check

Fail if the operation snapshot or any generated file drifted from the code (the CI drift gate).

Arguments: `root`.

`toolfactory check --json '<arguments>'` prints a JSON result. MCP tool `check` on server `toolfactory` returns the same result as `structuredContent`.

### coverage

The operation × surface verdict matrix: native, bridged, degraded, or excluded, with reasons.

Arguments: `root`.

`toolfactory coverage --json '<arguments>'` prints a JSON result. MCP tool `coverage` on server `toolfactory` returns the same result as `structuredContent`.

### doctor

Report which upstream CLIs this machine can delegate to (git, gh, npm, uv, claude, openclaw, clawhub, hermes, uvx, agentskills, MCP Inspector, docker).

`toolfactory doctor --json '<arguments>'` prints a JSON result. MCP tool `doctor` on server `toolfactory` returns the same result as `structuredContent`.

### eject

Adopt every file a surface owns, so the author takes it over entirely.

Arguments: `root`, `surface`.

`toolfactory eject --json '<arguments>'` prints a JSON result. MCP tool `eject` on server `toolfactory` returns the same result as `structuredContent`.

### gate

Run the gate here, in order: build, the drift check, every selected surface's upstream validator, the author's checks and tests, and the credential-free host end-to-end. The same step list the generated ci.yml renders, so a project with no CI has the identical gate.

Arguments: `root`.

`toolfactory gate --json '<arguments>'` prints a JSON result. MCP tool `gate` on server `toolfactory` returns the same result as `structuredContent`.

### init

Create a new tool: dev.toolfactory/tool.json, the authored identity file, the kernel scaffold for the chosen language, and the first build of every selected surface.

Arguments: `root`, `name`, `binding`, `surfaces`, `description`, `license`, `repository`, `author`, `keywords`, `git`, `setup`, `repo`, `public`, `dryRun`, `reviewers`.

`toolfactory init --json '<arguments>'` prints a JSON result. MCP tool `init` on server `toolfactory` returns the same result as `structuredContent`.

### introspect

Spawn the kernel MCP server, list its tools, and snapshot them to dev.toolfactory/ops.json.

Arguments: `root`.

`toolfactory introspect --json '<arguments>'` prints a JSON result. MCP tool `introspect` on server `toolfactory` returns the same result as `structuredContent`.

### package

Build every release asset into dist/release/ — npm tarball, Python distributions, OpenClaw plugin tarball, plugin bundle zip, web build, coverage — by the same steps the release workflow's package job runs. Publishing stays a CI concern.

Arguments: `root`.

`toolfactory package --json '<arguments>'` prints a JSON result. MCP tool `package` on server `toolfactory` returns the same result as `structuredContent`.

### secrets

Every credential this project's surfaces need — the tool's own sensitive config keys and the release registries' tokens — with where each one is set, whether it is present locally and on GitHub, and (check) whether the registry accepts it. Never a value.

Arguments: `root`, `action`, `key`.

`toolfactory secrets --json '<arguments>'` prints a JSON result. MCP tool `secrets` on server `toolfactory` returns the same result as `structuredContent`.

### unadopt

Return an adopted file to toolfactory and regenerate it.

Arguments: `root`, `path`.

`toolfactory unadopt --json '<arguments>'` prints a JSON result. MCP tool `unadopt` on server `toolfactory` returns the same result as `structuredContent`.

### unpublish

Retract what a deselected surface used to publish. Git is the ledger: the previous tag's dev.toolfactory/tool.json says what was selected then, and every registry row that lost its surface is checked for the version that tag published and then retracted with the registry's own CLI — or reported with the exact page, where there is no API.

Arguments: `root`, `ref`, `dryRun`, `hard`.

`toolfactory unpublish --json '<arguments>'` prints a JSON result. MCP tool `unpublish` on server `toolfactory` returns the same result as `structuredContent`.

### validate

Run each selected surface's own upstream validator (agentskills, claude plugin validate, MCP Inspector, openclaw, hermes, npm pack, uv build).

Arguments: `root`, `surface`.

`toolfactory validate --json '<arguments>'` prints a JSON result. MCP tool `validate` on server `toolfactory` returns the same result as `structuredContent`.

### web

Open this tool's web app: serves the operations page and the MCP endpoint on a free local port, opens a browser there, and returns the URL.

`toolfactory web --json '<arguments>'` prints a JSON result. MCP tool `web` on server `toolfactory` returns the same result as `structuredContent`.

<!-- /tf:operations -->
