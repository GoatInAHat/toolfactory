# OpenClaw feature adoption

What Tool Factory adopts from the host it runs in, and what is still planned.
One row per feature; committed here so the plan survives across sessions.

## Adopted

| Feature | Where |
| --- | --- |
| Plugin skill packaging (`openclaw.skills`) | `src/surfaces/openclaw-native.ts` — `.agents/skills/<name>/` mirrored into the plugin, `skills: ["./skills"]` in the manifest, npm `files` |
| Prompt loop (`review-prompt`) | `src/prompt/` — the codex-prompt-standard draft → evaluate → iterate loop as an operation |
| Skill canon (Anthropic + workshop) | `.agents/skills/` — skill-creator, mcp-builder, webapp-testing, codex-prompt-standard, shadcn |

## Planned

### Project + session lifecycle on `init` — PLANNED, not started

Every new build ask should leave behind a registered OpenClaw project and a
visible session bound to it, instead of that being a one-off the agent does by
hand (the gsd-pi registration on 2026-09-13 was exactly such a one-off).

- `init` ensures a project row via the Gateway's public authenticated client
  (`projects.register`, added by gsd-pi#2135) when the tool will live under
  `~/.openclaw/projects/<id>`, and emits the session-binding guidance (one
  visible dashboard session per project) for the calling agent.
- Session creation itself stays host/agent territory — toolfactory registers
  the row and states the next step; it never owns a session.
- Open decision (owner): default-on when an OpenClaw context is detected, or an
  explicit `--openclaw-project` flag with skill guidance. Current lean: flag.
- Coordination: gsd-pi#2135's sync-service also registers projects; design gets
  a gsd-pi glance before this lands.
