# Generator A/B validation receipt

Base: `629c92c`. Scope: local generator preparation only; no deployment or publication.

## Result

- **A — OpenClaw devDependencies:** the earlier missing-SDK diagnosis was incorrect.
  `OPENCLAW_SCAFFOLD.devDependencies` already supplies `openclaw: latest` to the host
  package, including the original vutoolkit scaffold. The host owns this dependency,
  not the core. Existing generator tests now assert the default dependency set and
  preservation of author overrides/additions through `openclaw.devDependencies`.
- **B — core-scoped Vitest:** new TypeScript scaffolds use
  `vitest run --dir src --passWithNoTests`. No extra configuration file is needed.
  `test:live` stays unchanged and can still discover `tests/live.test.ts`.
  Existing author-owned scripts are not rewritten by regeneration.

## Executed checks

| Command | Receipt |
| --- | --- |
| `pnpm check` | Exit 0: Biome checked 91 files; TypeScript passed. |
| `pnpm toolfactory build` | Exit 0; no tracked generated-output changes. |
| `pnpm toolfactory check` | Exit 0; `{"ok":true}`. |
| `pnpm exec vitest run src/bindings/typescript.test.ts src/surfaces/openclaw-native.test.ts -t 'typescript\|openclaw-native'` | Exit 0: 14 passed, 1 skipped (the upstream scaffold-drift test is outside this filter). |
| `pnpm test` | Exit 1: 168 passed, 3 skipped, 2 failed; 24 files passed, 2 failed. |
| `git diff --check` | Exit 0. |

The new regression really invokes the generated package's `npm run test`: one core test
passes while deliberately failing OpenClaw, browser, and live tests are not collected;
changing the core test to fail produces exit 1. Then `npm run test:live` passes its own
single test while the core and host sentinels still fail if collected. Dependencies are
linked from this checkout into a temporary fixture; this is execution proof, not a fresh
dependency-install or host-activation claim.

Both full-suite failures reproduce on an unmodified `git archive HEAD` of `629c92c`
in `/tmp/tf-ab-baseline-3h3loatt` (16 passed, the same 2 failed):

1. Python release source test: the wheel build succeeds, but `unzip` cannot be spawned
   (`ENOENT`, status null). No system package installation attempted in this lane.
2. OpenClaw scaffold drift: installed CLI projects `openclawVersion: 2026.9.4`, while
   the vendored scaffold expects `2026.9.2`. No upstream scaffold update attempted.

Raw local logs: `/tmp/tf-generator-ab-{build,drift,check,focused,tests,baseline}.log`.

## Separate dependencies

- Review-prompt guest execution was pending at the A/B checkpoint; the follow-up
  below closes that verification independently of generator validation.
- ClawHub authentication/publication remains separate. No login or publish attempted.
- No shared Gateway restart, plugin deployment, loaded host-core refresh, additional
  worker, Vanderbilt scaffold/auth change, or Runtime bridge change was performed.
- The pre-existing untracked `IDENTITY.md`, `SOUL.md`, and `USER.md` remain untouched.

## Guest tool execution follow-up — 2026-09-14 03:02 UTC

PASS through the current supported guest code-mode path:
`functions.exec` → `tools.openclaw__review_prompt(...)`. These were actual plugin
tool calls, not a module import, CLI substitute, new runtime, or unit-test run.

The two existing inputs from `src/prompt/review.test.ts` produced:

| Input | Actual tool result |
| --- | --- |
| `Ship the build. Be quick.` | `verdict: revise`; all seven anatomy sections missing; nine actionable directives. |
| Existing `GOOD_PROMPT` release-assistant fixture (verbatim) | `verdict: pass`; all seven sections present; none missing; empty directives; both checks pass (three hard imperatives, zero hedges). |

Both calls returned complete structured reports in the calling guest. The historical
`operation review-prompt is missing from the core package` error did not occur.
Before invoking, read the Codex Prompt Standard skill, re-listed upstream core Markdown
files, and read the full `gpt_5_2_prompt.md` reference. The optional `reference` argument
was omitted for this existing-fixture transport verification.

Reconciliation found no later proof in the existing TF card or saved receipt; memory
search returned only unrelated interruption notices. No generator checks were replayed.
No Gateway restart, config/auth changes, plugin deployment, Mac call, child/runtime,
login reissue, or publication was performed. ClawHub remains separately gated.
