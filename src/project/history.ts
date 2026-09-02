/**
 * Git is the release ledger (§7). Nothing records "what this project published at v0.1.0" except
 * the commit that tag points at, so the previous selection is read straight out of it: no state
 * file, no per-registry ledger, and nothing to keep in sync.
 *
 * Every function here is best-effort and never throws: a checkout with no tags, no git at all, or
 * a tag predating `dev.toolfactory/tool.json` simply has nothing to compare against, and
 * `unpublish` then has nothing to do.
 */
import { spawnSync } from "node:child_process";
import { type SurfaceId, ToolConfigSchema } from "../model.js";
import { TOOL_PATH } from "./load.js";

function git(root: string, args: string[]): string | undefined {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", timeout: 30_000 });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

/**
 * The tag released before `ref`: `git describe --tags --abbrev=0 <ref>^`. The `^` is what makes it
 * *previous* — on the release runner `ref` is the tag being cut, and on a working tree it is the
 * last release behind HEAD. Undefined at the first tag, which is exactly "nothing was dropped".
 */
export function previousTag(root: string, ref = "HEAD"): string | undefined {
  return git(root, ["describe", "--tags", "--abbrev=0", `${ref}^`]) || undefined;
}

/** `dev.toolfactory/tool.json` as of a ref, or undefined when the ref has none / it does not parse. */
export function toolAtRef(root: string, ref: string) {
  const text = git(root, ["show", `${ref}:${TOOL_PATH}`]);
  if (!text) return undefined;
  try {
    const parsed = ToolConfigSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/** The surfaces a ref selected that the current selection no longer does, in the ref's own order. */
export function droppedSurfaces(
  previous: readonly SurfaceId[],
  current: readonly SurfaceId[],
): SurfaceId[] {
  return previous.filter((surface) => !current.includes(surface));
}
