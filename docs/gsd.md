# GSD compatibility

ToolFactory's standard skill, CLI and MCP outputs are the GSD integration. GSD can develop a
ToolFactory project and consume its operations without a GSD runtime dependency or wrapper.
Native GSD extensions (UI, hooks, providers and lifecycle services) remain authored GSD code;
ToolFactory does not generate those contracts.

## Develop a tool in GSD

From the generated project's root, install its dependencies and render the agent configuration:

```sh
bash .agents/setup --all
gsd
```

The explicit `--all` matters on a GSD-only machine: the vendored template does not detect GSD,
but its existing shared MCP renderer already writes the `.mcp.json` GSD reads. To refresh just
the configuration, use `python3 .agents/sync.py --all`. Keep server definitions in
`.agents/mcp/servers.json`; do not hand-edit the rendered file.

GSD discovers the generated `.agents/skills/<name>` link and `AGENTS.md`. Ask it to call
`mcp_servers`, then `mcp_discover(server="<name>")`. GSD requests trust before launching a
project stdio server; approve the expected command interactively before running headless or
subagent work. Its native call is `mcp_call(server="<name>", tool="<operation>", args={...})`.
The generated CLI provides the same operation and JSON arguments for shell-capable agents.

After editing operations, use the normal `introspect`, `build`, `check` and `validate` loop.
`/reload` refreshes GSD's resources; `mcp_servers(refresh=true)` rereads MCP configuration.
Start a new GSD session when changing an already connected server. Trust is scoped to the
project and command, so a different checkout or worktree can require a new approval.

## Runtime boundaries

| GSD entry point | Where the generated tool is available |
| --- | --- |
| Native terminal, print/headless, RPC or web session | The project's skills and MCP configuration, subject to resource flags, enabled extensions and stdio trust. The CLI also works wherever the process can run it. |
| GSD through its MCP server | The GSD child runs in the requested `projectDir`; prepare that checkout and trust its server under the GSD account that will run it. Pass absolute `root` to ToolFactory's own operations. |
| OpenClaw integration | Install a generated Agent Plugins bundle or native OpenClaw plugin for the outer OpenClaw agent. Prepare the GSD child project separately; the integration declares GSD's MCP server, not an inheritance mechanism for outer tools. |
| Hermes integration | The same separation: Hermes owns its tools, while the GSD child uses its project configuration and execution account. |
| Claude Code or another provider adapter inside GSD | Tool visibility also depends on that adapter's MCP/tool policy. A native GSD tool registration does not establish provider parity. Use the adapter's supported MCP configuration or the generated CLI. |
| `--bare` / disabled skills or extensions | GSD intentionally omits those resources. Do not treat their absence as a ToolFactory discovery failure. |

Instruction-only projects (`runtime: "none"`, `surfaces: ["skill"]`, optionally `codex`) supply
prose to GSD's skill loader and have no kernel to discover. Browser, model and channel features
still require the executing host's capabilities; starting GSD from a host does not turn those
capabilities into portable MCP operations. GSD's headless question handling and the outer
host's elicitation support also determine whether user-input flows can complete unattended.

## Verify against GSD source

Install dependencies in ToolFactory and in a GSD source checkout, then run:

```sh
node --import tsx scripts/check-gsd.mjs /path/to/gsd-pi
```

This creates a disposable default TypeScript tool, snapshots and builds it, renders its agent
config, and calls the generated echo operation through GSD's actual MCP extension. It checks
skill symlink deduplication, `AGENTS.md` discovery, bare-mode exclusions, untrusted headless
rejection, interactive discovery, persisted trust for an unattended call, and CLI result parity.
GSD state and trust live in a temporary directory that is removed afterward. No model is called.

The test prints the GSD checkout commit. It proves these contracts, not every provider's model
behavior or a live OpenClaw/Hermes conversation. The OpenClaw integration in
[PR #2135](https://github.com/open-gsd/gsd-pi/pull/2135) remains an upstream proposal; use its source
install instructions until a release includes it.

Primary sources: GSD's [skills guide](https://github.com/open-gsd/gsd-pi/blob/main/docs/user-docs/skills.md),
[MCP client](https://github.com/open-gsd/gsd-pi/tree/main/src/resources/extensions/mcp-client),
[resource loader](https://github.com/open-gsd/gsd-pi/blob/main/packages/pi-coding-agent/src/core/resource-loader.ts),
[provider parity design](https://github.com/open-gsd/gsd-pi/blob/main/docs/dev/ADR-008-gsd-tools-over-mcp-for-provider-parity.md),
and [OpenClaw integration](https://github.com/GoatInAHat/gsd-pi/tree/feat/openclaw-integration/integrations/openclaw).
