/**
 * The one writer and the one differ. A plan is a list of files; applying it writes
 * generated files, keeps `manual` (adopted) files untouched, refreshes managed regions
 * inside author-owned files, merges owned keys into shared structured files, deletes
 * orphans, and records SHAs in the lock file. Every kind carries its own inverse: a region file
 * its markers, a full file its path, a merge file the key paths recorded in the lock.
 */
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import type { MergeFile, PlannedFile, Region } from "../model.js";
import { LOCK_PATH, type Lock, type Markers, readLock, serializeLock, sha256 } from "./lock.js";

export interface Drift {
  path: string;
  kind: "missing" | "changed" | "orphan" | "unmarked";
}

export interface ApplyResult {
  written: string[];
  deleted: string[];
  unchanged: string[];
  manual: string[];
  /** Region files a deselected surface stopped writing: emptied of their regions and kept, because everything outside the markers is the author's. */
  stripped: string[];
}

function locate(text: string, region: Markers): { start: number; end: number } | undefined {
  const start = text.indexOf(region.begin);
  if (start < 0) return undefined;
  const end = text.indexOf(region.end, start + region.begin.length);
  if (end < 0) return undefined;
  return { start: start + region.begin.length, end };
}

export function extractRegions(
  text: string,
  file: { regions: readonly Markers[] },
): string[] | undefined {
  const parts: string[] = [];
  for (const region of file.regions) {
    const at = locate(text, region);
    if (!at) return undefined;
    parts.push(text.slice(at.start, at.end));
  }
  return parts;
}

export function replaceRegions(
  text: string,
  file: { regions: readonly Region[] },
): string | undefined {
  let next = text;
  for (const region of file.regions) {
    const at = locate(next, region);
    if (!at) return undefined;
    next = next.slice(0, at.start) + region.content + next.slice(at.end);
  }
  return next;
}

/** A region file's inverse: the named regions blanked, their markers and the author's bytes kept. */
function emptyRegions(text: string, markers: readonly Markers[]): string | undefined {
  return replaceRegions(text, { regions: markers.map((region) => ({ ...region, content: "" })) });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Objects merge key by key, except the paths a merge file owns whole, which are replaced. */
export function deepMerge(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
  owned: string[] = [],
  prefix = "",
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const path = prefix ? `${prefix}.${key}` : key;
    out[key] =
      isRecord(value) && isRecord(out[key]) && !owned.includes(path)
        ? deepMerge(out[key] as Record<string, unknown>, value, owned, path)
        : value;
  }
  return out;
}

/** The values a merge file owns, read back out of a document; an owned object comes back whole. */
export function pickPatch(
  document: Record<string, unknown>,
  patch: Record<string, unknown>,
  owned: string[] = [],
  prefix = "",
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    const current = document[key];
    const path = prefix ? `${prefix}.${key}` : key;
    out[key] =
      isRecord(value) && isRecord(current) && !owned.includes(path)
        ? pickPatch(current, value, owned, path)
        : current;
  }
  return out;
}

/** The dotted paths a patch writes: one per leaf value, and one per object it owns whole. */
export function patchKeys(
  patch: Record<string, unknown>,
  owned: string[] = [],
  prefix = "",
): string[] {
  const keys: string[] = [];
  for (const [key, value] of Object.entries(patch)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (isRecord(value) && !owned.includes(path) && Object.keys(value).length > 0) {
      keys.push(...patchKeys(value, owned, path));
    } else {
      keys.push(path);
    }
  }
  return keys;
}

function walk(document: Record<string, unknown>, key: string): Record<string, unknown>[] {
  const chain: Record<string, unknown>[] = [document];
  let node: unknown = document;
  for (const part of key.split(".").slice(0, -1)) {
    node = (node as Record<string, unknown>)[part];
    if (!isRecord(node)) return chain;
    chain.push(node);
  }
  return chain;
}

function hasKey(document: Record<string, unknown>, key: string): boolean {
  const parts = key.split(".");
  const chain = walk(document, key);
  return chain.length === parts.length && (parts.at(-1) as string) in (chain.at(-1) as object);
}

/** Uninstall dotted paths from a document, pruning the objects the removal empties. */
export function removeKeys(document: Record<string, unknown>, keys: readonly string[]): boolean {
  let removed = false;
  for (const key of keys) {
    if (!hasKey(document, key)) continue;
    const parts = key.split(".");
    const chain = walk(document, key);
    delete (chain.at(-1) as Record<string, unknown>)[parts.at(-1) as string];
    removed = true;
    for (let depth = chain.length - 1; depth > 0; depth--) {
      if (Object.keys(chain[depth] as object).length > 0) break;
      delete (chain[depth - 1] as Record<string, unknown>)[parts[depth - 1] as string];
    }
  }
  return removed;
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

/** A symbolic link's managed content is its target; every other kind's is what it holds. */
function isLink(file: PlannedFile): boolean {
  return file.kind === "file" && file.symlink === true;
}

function currentManagedContent(root: string, file: PlannedFile): string | undefined {
  const path = join(root, file.path);
  if (isLink(file)) {
    const entry = lstatSync(path, { throwIfNoEntry: false });
    // A regular file or directory standing where the link belongs matches no target: it is drift.
    return entry && (entry.isSymbolicLink() ? readlinkSync(path) : "");
  }
  if (!existsSync(path)) return undefined;
  const text = readFileSync(path, "utf8");
  if (file.kind === "file") return text;
  if (file.kind === "region") return extractRegions(text, file)?.join(" ");
  return JSON.stringify(pickPatch(parseDocument(text, file.format), file.patch, file.owned));
}

/** The two structured formats merge files use; the extension is the only discriminator needed. */
function documentFormat(path: string): MergeFile["format"] {
  return path.endsWith(".toml") ? "toml" : "json";
}

/** The keys the lock recorded for a path that the current patch no longer writes. */
function staleKeys(lock: Lock, path: string, current: string[] = []): string[] {
  return (lock.files[path]?.keys ?? []).filter((key) => !current.includes(key));
}

/** Whether any uninstalled key is still in the document — the only reason to touch a merge file. */
function stranded(root: string, path: string, keys: string[]): boolean {
  if (keys.length === 0 || !existsSync(join(root, path))) return false;
  const document = parseDocument(readFileSync(join(root, path), "utf8"), documentFormat(path));
  return keys.some((key) => hasKey(document, key));
}

/** The marker pairs the lock recorded for a path that the current plan no longer writes. */
function staleRegions(lock: Lock, path: string, current: readonly Markers[] = []): Markers[] {
  return (lock.files[path]?.regions ?? []).filter(
    (region) => !current.some((planned) => planned.begin === region.begin),
  );
}

/** Whether any uninstalled region still carries content — the only reason to touch a region file. */
function filled(root: string, path: string, markers: readonly Markers[]): boolean {
  if (markers.length === 0 || !existsSync(join(root, path))) return false;
  const parts = extractRegions(readFileSync(join(root, path), "utf8"), { regions: markers });
  return parts?.some((part) => part.trim() !== "") === true;
}

/** lstat, not stat: a dangling symlink (its target just deleted) is still present and still ours. */
function present(root: string, path: string): boolean {
  return lstatSync(join(root, path), { throwIfNoEntry: false }) !== undefined;
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
      // An output file is rebuilt, not tracked: absent is not drift, only stale is.
      if (file.kind === "file" && file.output) continue;
      drift.push({
        path: file.path,
        kind: existsSync(join(root, file.path)) ? "unmarked" : "missing",
      });
    } else if (current !== managedContent(file)) {
      drift.push({ path: file.path, kind: "changed" });
    } else if (
      file.kind === "merge" &&
      stranded(root, file.path, staleKeys(lock, file.path, patchKeys(file.patch, file.owned)))
    ) {
      drift.push({ path: file.path, kind: "changed" });
    } else if (
      file.kind === "region" &&
      filled(root, file.path, staleRegions(lock, file.path, file.regions))
    ) {
      drift.push({ path: file.path, kind: "changed" });
    }
  }
  for (const path of Object.keys(lock.files)) {
    const entry = lock.files[path];
    if (planned.has(path) || entry?.state !== "generated" || !present(root, path)) continue;
    // A merge file toolfactory stops writing loses its keys, not its existence.
    if (entry.keys && !stranded(root, path, entry.keys)) continue;
    // A region file likewise loses its regions: once they are empty, nothing of ours is stranded.
    if (entry.regions && !filled(root, path, entry.regions)) continue;
    drift.push({ path, kind: "orphan" });
  }
  return drift;
}

function render(root: string, file: PlannedFile, previous: Lock): string {
  const path = join(root, file.path);
  if (file.kind === "file") return file.content;
  if (file.kind === "region") {
    if (existsSync(path)) {
      const text = readFileSync(path, "utf8");
      // The region inverse first: a marker pair a previous plan wrote and this one dropped — a
      // shared file that lost one of its owners — is emptied before the current regions are filled.
      const stale = staleRegions(previous, file.path, file.regions);
      const replaced = replaceRegions(emptyRegions(text, stale) ?? text, file);
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
  // The patch's inverse first: keys a previous patch wrote and this one dropped are uninstalled.
  const uninstalled = removeKeys(
    document,
    staleKeys(previous, file.path, patchKeys(file.patch, file.owned)),
  );
  // A document that already carries the patch is left byte-for-byte alone, so a rebuild never
  // reserializes the author's file (and, for TOML, never drops their comments).
  if (
    !uninstalled &&
    JSON.stringify(pickPatch(document, file.patch, file.owned)) === JSON.stringify(file.patch)
  ) {
    return text;
  }
  return serializeDocument(deepMerge(document, file.patch, file.owned), file.format);
}

/** Write a plan to the tree and refresh the lock. */
export function apply(root: string, plan: PlannedFile[], toolfactoryVersion: string): ApplyResult {
  const previous = readLock(root) ?? { toolfactoryVersion, files: {} };
  const lock: Lock = { toolfactoryVersion, files: {} };
  const result: ApplyResult = {
    written: [],
    deleted: [],
    unchanged: [],
    manual: [],
    stripped: [],
  };
  for (const file of plan) {
    const state = previous.files[file.path]?.state ?? "generated";
    const path = join(root, file.path);
    if (state === "manual") {
      lock.files[file.path] = { sha256: previous.files[file.path]?.sha256 ?? "", state };
      result.manual.push(file.path);
      continue;
    }
    const keys = file.kind === "merge" ? patchKeys(file.patch, file.owned) : undefined;
    const regions =
      file.kind === "region" ? file.regions.map(({ begin, end }) => ({ begin, end })) : undefined;
    if (isLink(file)) {
      if (currentManagedContent(root, file) === managedContent(file)) {
        result.unchanged.push(file.path);
      } else {
        mkdirSync(dirname(path), { recursive: true });
        // Whatever stands there — a stale link, or a real file or directory — makes way for the link.
        rmSync(path, { recursive: true, force: true });
        symlinkSync(managedContent(file), path);
        result.written.push(file.path);
      }
    } else {
      const next = render(root, file, previous);
      if (existsSync(path) && readFileSync(path, "utf8") === next) {
        result.unchanged.push(file.path);
      } else {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, next, { mode: file.kind === "file" ? file.mode : undefined });
        result.written.push(file.path);
      }
    }
    lock.files[file.path] = {
      sha256: sha256(managedContent(file)),
      state: "generated",
      keys,
      regions,
    };
  }
  for (const [path, entry] of Object.entries(previous.files)) {
    if (lock.files[path]) continue;
    if (entry.state === "manual") {
      lock.files[path] = entry;
      continue;
    }
    if (!present(root, path)) continue;
    if (entry.keys) {
      // The inverse of a merge file is its keys: the author keeps the file and everything else in it.
      const format = documentFormat(path);
      const document = parseDocument(readFileSync(join(root, path), "utf8"), format);
      if (removeKeys(document, entry.keys)) {
        writeFileSync(join(root, path), serializeDocument(document, format));
        result.written.push(path);
      }
      continue;
    }
    if (entry.regions) {
      // The inverse of a region file is its markers: the author keeps the file, the markers, and
      // every byte outside them, so re-selecting the surface refills them with no further code.
      const text = readFileSync(join(root, path), "utf8");
      const emptied = emptyRegions(text, entry.regions);
      // Markers already gone: nothing of ours is left to uninstall.
      if (emptied === undefined || emptied === text) continue;
      writeFileSync(join(root, path), emptied);
      result.stripped.push(path);
      continue;
    }
    rmSync(join(root, path));
    result.deleted.push(path);
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
