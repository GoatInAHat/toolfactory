import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const TOOLFACTORY_DIR = "dev.toolfactory";
export const LOCK_PATH = `${TOOLFACTORY_DIR}/lock.json`;

export const LockSchema = z.object({
  toolfactoryVersion: z.string(),
  files: z.record(
    z.string(),
    z.object({
      sha256: z.string(),
      state: z.enum(["generated", "manual"]),
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
