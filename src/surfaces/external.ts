/**
 * Surfaces that write nothing of their own and exist for their coverage row and their
 * effect on other surfaces:
 *
 * - `clawhub` publishes the OpenClaw-native package; its only artifact is the release leg
 *   `workflows` emits when it is selected together with `openclaw-native`.
 */
import type { Surface } from "../model.js";

export const clawhub: Surface = {
  id: "clawhub",
  plan: () => [],
};
