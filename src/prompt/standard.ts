/**
 * The codex-prompt-standard rubric, as data. The prose canon is
 * `.agents/skills/codex-prompt-standard/SKILL.md` — it ships inside the OpenClaw plugin and
 * syncs to every dev harness; this module is the same guidance shaped for `review-prompt` to
 * evaluate against. `review.test.ts` pins every anchor below to the canon text so the two
 * cannot drift apart silently.
 */

export interface PromptSection {
  id: string;
  title: string;
  /** Substring of the canon SKILL.md this section is pinned to (drift guard). */
  canonAnchor: string;
  /** Any hit marks the section present in a draft or a reference prompt. */
  anchors: RegExp[];
  /** The next-iteration instruction when the section is missing. */
  directive: string;
}

/** The anatomy a Codex-class prompt reliably contains, in order (canon §2). */
export const ANATOMY: PromptSection[] = [
  {
    id: "identity",
    title: "one-sentence identity",
    canonAnchor: "One-sentence identity",
    anchors: [/\byou are\b/i, /\bacting (?:for|on behalf of|as)\b/i],
    directive:
      "Open with one sentence of identity: who the model is, where it runs, how it is expected to behave.",
  },
  {
    id: "capabilities",
    title: "capability inventory",
    canonAnchor: "Capability inventory",
    anchors: [/\byou can\b/i, /\bcapabilit/i, /\b(?:available|your) tools?\b/i],
    directive: "State the capability inventory: what the agent can receive and emit.",
  },
  {
    id: "how-you-work",
    title: '"How you work" sections',
    canonAnchor: '"How you work" sections',
    anchors: [/how you work/i, /\bpreceden/i, /\bpersisten/i, /\bautonom/i, /\btone\b/i],
    directive:
      'Add "how you work" sections: personality and tone, instruction precedence, the autonomy and persistence contract.',
  },
  {
    id: "planning",
    title: "planning guidance",
    canonAnchor: "Planning guidance",
    anchors: [/\bplan\b/i, /\bpersist until\b/i, /before (?:acting|starting|diving)/i],
    directive:
      "Add planning guidance with explicit high-quality vs low-quality examples for what a good plan is.",
  },
  {
    id: "execution-criteria",
    title: "execution criteria",
    canonAnchor: "Execution criteria",
    anchors: [/\bMUST\b/, /\bNEVER\b/, /scope creep/i, /no unrelated changes/i],
    directive:
      "Add execution criteria: hard MUST/NEVER lists, root-cause fixes, no scope creep, no unrelated changes.",
  },
  {
    id: "validation",
    title: "validation philosophy",
    canonAnchor: "Validation philosophy",
    anchors: [/\bverify\b/i, /\bvalidat/i, /before claiming done/i, /\bdone when\b/i],
    directive:
      "Add the validation philosophy: start specific, broaden as confidence grows, verify before claiming done.",
  },
  {
    id: "final-message",
    title: "final-message guidance",
    canonAnchor: "Final-message guidance",
    anchors: [/final message/i, /\boutput depth\b/i, /\bfinal reply\b/i],
    directive:
      "Add final-message guidance: output depth matches task size; skip formatting for trivial replies.",
  },
];

export interface PromptConvention {
  id: string;
  /** Substring of the canon SKILL.md this convention is pinned to (drift guard). */
  canonAnchor: string;
}

/** Convention anchors the canon must mention; the checks in review.ts implement them. */
export const CONVENTIONS: PromptConvention[] = [
  { id: "positive-imperatives", canonAnchor: "Positive imperatives" },
  { id: "precedence", canonAnchor: "Explicit precedence" },
  { id: "must-never-discipline", canonAnchor: "MUST/NEVER reserved" },
  { id: "examples", canonAnchor: "Good-vs-bad examples" },
  { id: "harness-adaptation", canonAnchor: "Adapt to the target harness" },
  { id: "checkable-criteria", canonAnchor: "checkable criterion" },
];
