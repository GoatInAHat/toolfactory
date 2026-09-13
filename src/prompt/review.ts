/**
 * The draft -> evaluate -> iterate loop's evaluator, as `review-prompt`. Pure and deterministic:
 * it scans the draft (and, when given, the fetched reference prompt) against the
 * codex-prompt-standard rubric and returns findings plus concrete next-iteration directives.
 * The taste stays with the calling model; this makes the checklist the skill teaches impossible
 * to skip.
 */
import { ANATOMY, type PromptSection } from "./standard.js";

export interface PromptReviewInput {
  prompt: string;
  /** The closest reference prompt's full text (canon §1: fetch it before evaluating). */
  reference?: string;
}

export interface CheckResult {
  id: string;
  status: "pass" | "warn" | "fail";
  detail: string;
}

export interface PromptReviewReport {
  verdict: "pass" | "polish" | "revise";
  sections: { present: string[]; missing: string[] };
  checks: CheckResult[];
  directives: string[];
  reference?: { sectionsMissingHere: string[] };
}

const HARD_WORDS = /\b(?:MUST|NEVER|ALWAYS)\b/g;
const HEDGES =
  /\b(?:try to|tries to|consider|maybe|perhaps|probably|if possible|ideally|when appropriate|as needed)\b/gi;
const PRECEDENCE =
  /\bpreceden|overrid|takes? precedence|in case of (?:a )?conflict|conflicts? with|direct instructions/i;
const EXAMPLES = /\b(?:example|for instance|good:|bad:)\b/i;
const DONE_WHEN = /done when|definition of done|success criteria|checkable|acceptance criteria/i;
const INJECTION = /ignore (?:all |any |the )?(?:previous|prior|above|earlier)\s+instructions/i;
const CODEX_SPECIFIC = /\bapply_patch\b|\bcodex-rs\b|\bopenai codex cli\b/i;

const has = (text: string, section: PromptSection): boolean =>
  section.anchors.some((anchor) => anchor.test(text));

export function reviewPrompt(input: PromptReviewInput): PromptReviewReport {
  const { prompt, reference } = input;
  const present = ANATOMY.filter((section) => has(prompt, section));
  const missing = ANATOMY.filter((section) => !has(prompt, section));

  const checks: CheckResult[] = [];
  const hard = prompt.match(HARD_WORDS)?.length ?? 0;
  checks.push(
    hard > 15
      ? {
          id: "must-never-discipline",
          status: "fail",
          detail: `${hard} hard imperatives: MUST/NEVER are reserved for the few things that must never happen — demote the rest to positive imperatives.`,
        }
      : hard > 8
        ? {
            id: "must-never-discipline",
            status: "warn",
            detail: `${hard} hard imperatives is close to noise; keep MUST/NEVER for the few things that must never happen.`,
          }
        : { id: "must-never-discipline", status: "pass", detail: `${hard} hard imperatives.` },
  );

  const hedges = prompt.match(HEDGES)?.length ?? 0;
  checks.push(
    hedges >= 5
      ? {
          id: "positive-imperatives",
          status: "warn",
          detail: `${hedges} hedge phrases — every sentence should change behavior; prefer positive imperatives ("run X, then verify Y").`,
        }
      : { id: "positive-imperatives", status: "pass", detail: `${hedges} hedge phrases.` },
  );

  if (prompt.length > 2000 && !PRECEDENCE.test(prompt))
    checks.push({
      id: "precedence",
      status: "warn",
      detail:
        "No instruction-precedence rule in a prompt of this size — say what wins when sources conflict (direct instructions > project files > defaults).",
    });
  if (prompt.length > 1500 && !EXAMPLES.test(prompt))
    checks.push({
      id: "examples",
      status: "warn",
      detail:
        "No examples in a prompt this long — good-vs-bad examples are how subjective qualities (tone, plan quality) get taught.",
    });
  if (!DONE_WHEN.test(prompt))
    checks.push({
      id: "checkable-criteria",
      status: "warn",
      detail: 'No "done when" — every branch of the task should have a checkable criterion.',
    });
  if (INJECTION.test(prompt))
    checks.push({
      id: "injection-hygiene",
      status: "fail",
      detail:
        "The draft instructs its reader to discard instructions — a prompt must never undermine itself; state precedence instead.",
    });
  if (CODEX_SPECIFIC.test(prompt))
    checks.push({
      id: "harness-adaptation",
      status: "warn",
      detail:
        "Codex-specific names appear — adapt to the target harness's tools and delivery rules; never copy Codex-specific tool names.",
    });
  if (prompt.length < 200)
    checks.push({
      id: "length",
      status: "warn",
      detail:
        "Thinner than any Codex prompt section — say who the agent is, what it may do, and how it validates.",
    });
  else if (prompt.length > 40_000)
    checks.push({
      id: "length",
      status: "warn",
      detail:
        "Very long — output depth and context are budget; cut anything the reference would not need.",
    });

  const referenceMissing = reference
    ? ANATOMY.filter((section) => has(reference, section) && !has(prompt, section))
    : [];

  const directives = [
    ...missing.map((section) => section.directive),
    ...referenceMissing.map(
      (section) => `The reference prompt treats ${section.title}; the draft has no such section.`,
    ),
    ...checks.filter((check) => check.status !== "pass").map((check) => check.detail),
  ];
  const revise =
    missing.length > 0 || referenceMissing.length > 0 || checks.some((c) => c.status === "fail");
  const verdict = revise ? "revise" : checks.some((c) => c.status === "warn") ? "polish" : "pass";

  return {
    verdict,
    sections: { present: present.map((s) => s.id), missing: missing.map((s) => s.id) },
    checks,
    directives,
    ...(reference ? { reference: { sectionsMissingHere: referenceMissing.map((s) => s.id) } } : {}),
  };
}
