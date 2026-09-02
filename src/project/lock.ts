import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const TOOLFACTORY_DIR = "dev.toolfactory";
export const LOCK_PATH = `${TOOLFACTORY_DIR}/lock.json`;

/** A region's marker pair, without its content: what the lock records, and the inverse it enables. */
export const MarkersSchema = z.object({ begin: z.string(), end: z.string() });
export type Markers = z.infer<typeof MarkersSchema>;

export const LockSchema = z.object({
  toolfactoryVersion: z.string(),
  files: z.record(
    z.string(),
    z.object({
      sha256: z.string(),
      state: z.enum(["generated", "manual"]),
      /**
       * A merge file's inverse: the dotted key paths its patch wrote. Keys the current patch no
       * longer carries are removed from the document before merging, so dropping a key from a
       * patch — or deselecting the surface that added it — uninstalls it instead of stranding it.
       */
      keys: z.array(z.string()).optional(),
      /**
       * A region file's inverse, exactly as `keys` is a merge file's: the marker pairs its
       * projector wrote. Regions the current plan no longer writes are emptied before the current
       * ones are replaced, so dropping a region from a projector — or deselecting the surface that
       * added it — uninstalls its content instead of stranding it, and a region file that leaves
       * the plan loses its regions, not its existence.
       */
      regions: z.array(MarkersSchema).optional(),
    }),
  ),
});
export type Lock = z.infer<typeof LockSchema>;

export function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function readLock(root: string): Lock | undefined {
  const path = join(root, LOCK_PATH);
  if (!existsSync(path)) return undefined;
  return LockSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

export function serializeLock(lock: Lock): string {
  const files = Object.fromEntries(
    Object.entries(lock.files).sort(([a], [b]) => a.localeCompare(b)),
  );
  return `${JSON.stringify({ toolfactoryVersion: lock.toolfactoryVersion, files }, null, 2)}\n`;
}
