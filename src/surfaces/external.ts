/**
 * Surfaces that write nothing of their own and exist for their coverage row and their
 * effect on other surfaces:
 *
 * - `clawhub` publishes the OpenClaw-native package; its only artifact is the release leg
 *   `workflows` emits when it is selected together with `openclaw-native`.
 * - `dsh` (DeepSeek Harness) reaches the kernel through DSH's own MCP client, which carries
 *   tools only; nothing native is generated until DSH ships a non-alpha release.
 */
import type { Surface } from "../model.js";
import { isPortable } from "../model.js";
import { mcpVerdict } from "./shared.js";

export const clawhub: Surface = {
  id: "clawhub",
  plan: () => [],
};

export const dsh: Surface = {
  id: "dsh",
  plan: () => [],
  verdict: (operation) =>
    isPortable(operation)
      ? { kind: "degraded", reason: "degraded:mcp-tools-only" }
      : mcpVerdict(operation),
};
