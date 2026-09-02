/**
 * The one writer and the one differ. A plan is a list of files; applying it writes
 * generated files, keeps `manual` (adopted) files untouched, refreshes managed regions
 * inside author-owned files, merges owned keys into shared structured files, deletes
 * orphans, and records SHAs in the lock file.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import type { MergeFile, PlannedFile, Region, RegionFile } from "../model.js";
import { LOCK_PATH, type Lock, readLock, serializeLock, sha256 } from "./lock.js";

export interface Drift {
  path: string;
  kind: "missing" | "changed" | "orphan" | "unmarked";
}

export interface ApplyResult {
  written: string[];
  deleted: string[];
  unchanged: string[];
  manual: string[];
}

function locate(text: string, region: Region): { start: number; end: number } | undefined {
  const start = text.indexOf(region.begin);
  if (start < 0) return undefined;
  const end = text.indexOf(region.end, start + region.begin.length);
  if (end < 0) return undefined;
  return { start: start + region.begin.length, end };
}

export function extractRegions(text: string, file: RegionFile): string[] | undefined {
  const parts: string[] = [];
  for (const region of file.regions) {
    const at = locate(text, region);
    if (!at) return undefined;
    parts.push(text.slice(at.start, at.end));
  }
  return parts;
}

export function replaceRegions(text: string, file: RegionFile): string | undefined {
  let next = text;
  for (const region of file.regions) {
    const at = locate(next, region);
    if (!at) return undefined;
    next = next.slice(0, at.start) + region.content + next.slice(at.end);
  }
  return next;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function deepMerge(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    out[key] =
      isRecord(value) && isRecord(out[key])
        ? deepMerge(out[key] as Record<string, unknown>, value)
        : value;
  }
  return out;
}

/** The values a merge file owns, read back out of a document. */
export function pickPatch(
  document: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    const current = document[key];
    out[key] = isRecord(value) && isRecord(current) ? pickPatch(current, value) : current;
  }
  return out;
}

function parseDocument(text: string, format: MergeFile["format"]): Record<string, unknown> {
  return (format === "toml" ? parseToml(text) : JSON.parse(text)) as Record<string, unknown>;
}

function serializeDocument(document: Record<string, unknown>, format: MergeFile["format"]): string {
  return format === "toml"
    ? `${stringifyToml(document)}\n`
    : `${JSON.stringify(document, null, 2)}\n`;
}

/** The content toolfactory manages, as one string for hashing and comparison. */
export function managedContent(file: PlannedFile): string {
  if (file.kind === "file") return file.content;
  if (file.kind === "region") return file.regions.map((r) => r.content).join(" ");
  return JSON.stringify(file.patch);
}

function currentManagedContent(root: string, file: PlannedFile): string | undefined {
  const path = join(root, file.path);
  if (!existsSync(path)) return undefined;
  const text = readFileSync(path, "utf8");
  if (file.kind === "file") return text;
  if (file.kind === "region") return extractRegions(text, file)?.join(" ");
  return JSON.stringify(pickPatch(parseDocument(text, file.format), file.patch));
}

/** Compare a plan to the tree without writing. */
export function check(root: string, plan: PlannedFile[], toolfactoryVersion: string): Drift[] {
  const lock = readLock(root) ?? { toolfactoryVersion, files: {} };
  const drift: Drift[] = [];
  const planned = new Set(plan.map((file) => file.path));
  for (const file of plan) {
    if (lock.files[file.path]?.state === "manual") continue;
    const current = currentManagedContent(root, file);
    if (current === undefined) {
      drift.push({
        path: file.path,
        kind: existsSync(join(root, file.path)) ? "unmarked" : "missing",
      });
    } else if (current !== managedContent(file)) {
      drift.push({ path: file.path, kind: "changed" });
    }
  }
  for (const path of Object.keys(lock.files)) {
    if (
      !planned.has(path) &&
      lock.files[path]?.state === "generated" &&
      existsSync(join(root, path))
    ) {
      drift.push({ path, kind: "orphan" });
    }
  }
  return drift;
}

function render(root: string, file: PlannedFile): string {
  const path = join(root, file.path);
  if (file.kind === "file") return file.content;
  if (file.kind === "region") {
    if (existsSync(path)) {
      const replaced = replaceRegions(readFileSync(path, "utf8"), file);
      if (replaced === undefined) {
        throw new Error(
          `${file.path} exists but is missing a toolfactory region marker; restore the markers or run \`toolfactory adopt ${file.path}\`.`,
        );
      }
      return replaced;
    }
    return replaceRegions(file.template, file) ?? file.template;
  }
  if (!existsSync(path)) return serializeDocument(deepMerge({}, file.patch), file.format);
  const text = readFileSync(path, "utf8");
  const document = parseDocument(text, file.format);
  // A document that already carries the patch is left byte-for-byte alone, so a rebuild never
  // reserializes the author's file (and, for TOML, never drops their comments).
  if (JSON.stringify(pickPatch(document, file.patch)) === JSON.stringify(file.patch)) return text;
  return serializeDocument(deepMerge(document, file.patch), file.format);
}

/** Write a plan to the tree and refresh the lock. */
export function apply(root: string, plan: PlannedFile[], toolfactoryVersion: string): ApplyResult {
  const previous = readLock(root) ?? { toolfactoryVersion, files: {} };
  const lock: Lock = { toolfactoryVersion, files: {} };
  const result: ApplyResult = { written: [], deleted: [], unchanged: [], manual: [] };
  for (const file of plan) {
    const state = previous.files[file.path]?.state ?? "generated";
    const path = join(root, file.path);
    if (state === "manual") {
      lock.files[file.path] = { sha256: previous.files[file.path]?.sha256 ?? "", state };
      result.manual.push(file.path);
      continue;
    }
    const next = render(root, file);
    if (existsSync(path) && readFileSync(path, "utf8") === next) {
      result.unchanged.push(file.path);
    } else {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, next, { mode: file.kind === "file" ? file.mode : undefined });
      result.written.push(file.path);
    }
    lock.files[file.path] = { sha256: sha256(managedContent(file)), state: "generated" };
  }
  for (const [path, entry] of Object.entries(previous.files)) {
    if (lock.files[path]) continue;
    if (entry.state === "generated" && existsSync(join(root, path))) {
      rmSync(join(root, path));
      result.deleted.push(path);
    } else if (entry.state === "manual") {
      lock.files[path] = entry;
    }
  }
  const lockPath = join(root, LOCK_PATH);
  mkdirSync(dirname(lockPath), { recursive: true });
  writeFileSync(lockPath, serializeLock(lock));
  return result;
}

export function setState(
  root: string,
  path: string,
  state: "generated" | "manual",
  toolfactoryVersion: string,
): void {
  const lock = readLock(root) ?? { toolfactoryVersion, files: {} };
  const entry = lock.files[path];
  if (!entry) throw new Error(`${path} is not a toolfactory-managed file.`);
  lock.files[path] = { ...entry, state };
  writeFileSync(join(root, LOCK_PATH), serializeLock(lock));
}
