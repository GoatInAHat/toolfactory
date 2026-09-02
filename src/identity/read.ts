/**
 * Identity readers. These are shallow structural reads that pull the eight identity
 * fields out of a file the ecosystem defines and keep every other top-level key as an
 * opaque bag, so a rewrite never deletes what toolfactory does not understand.
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import type { Author, Identity } from "../model.js";
import { assertValidName } from "./name.js";

export interface IdentityFile {
  identity: Identity;
  extra: Record<string, unknown>;
  /** Object → text serializer matching the source format, used when projecting back. */
  format: "json" | "toml" | "yaml";
}

const IDENTITY_KEYS = [
  "name",
  "version",
  "description",
  "author",
  "homepage",
  "repository",
  "license",
  "keywords",
];

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asAuthor(value: unknown): Author | undefined {
  if (typeof value === "string") {
    const match = value.match(/^([^<(]+?)\s*(?:<([^>]+)>)?\s*(?:\(([^)]+)\))?\s*$/);
    return match ? { name: match[1]?.trim(), email: match[2], url: match[3] } : { name: value };
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return {
      name: asString(record.name),
      email: asString(record.email),
      url: asString(record.url),
    };
  }
  return undefined;
}

function asRepository(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") return asString((value as Record<string, unknown>).url);
  return undefined;
}

function split(record: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !keys.includes(key)));
}

function fromGeneric(record: Record<string, unknown>, nameKey = "name"): IdentityFile {
  const rawName = asString(record[nameKey]) ?? "";
  const name = rawName.replace(/^@[^/]+\//, "");
  assertValidName(name);
  const identity: Identity = {
    name,
    version: asString(record.version),
    description: asString(record.description),
    author: asAuthor(record.author),
    homepage: asString(record.homepage),
    repository: asRepository(record.repository),
    license: asString(record.license),
    keywords: Array.isArray(record.keywords)
      ? record.keywords.filter((k): k is string => typeof k === "string")
      : undefined,
  };
  return { identity, extra: split(record, [...IDENTITY_KEYS, nameKey]), format: "json" };
}

function fromPyproject(text: string): IdentityFile {
  const document = parseToml(text) as Record<string, unknown>;
  const project = (document.project ?? {}) as Record<string, unknown>;
  const urls = (project.urls ?? {}) as Record<string, unknown>;
  const authors = Array.isArray(project.authors)
    ? (project.authors as Record<string, unknown>[])
    : [];
  const name = asString(project.name) ?? "";
  assertValidName(name);
  const license = project.license;
  const identity: Identity = {
    name,
    version: asString(project.version),
    description: asString(project.description),
    author: authors[0] ? asAuthor(authors[0]) : undefined,
    homepage: asString(urls.Homepage ?? urls.homepage),
    repository: asString(urls.Repository ?? urls.repository ?? urls.Source),
    license:
      typeof license === "string"
        ? license
        : asString((license as Record<string, unknown> | undefined)?.text),
    keywords: Array.isArray(project.keywords) ? (project.keywords as string[]) : undefined,
  };
  return { identity, extra: document, format: "toml" };
}

/** Read the identity file named by `tool.json.identity`. */
export function readIdentityFile(path: string): IdentityFile {
  const text = readFileSync(path, "utf8");
  const file = basename(path);
  if (file === "pyproject.toml") return fromPyproject(text);
  if (file === "plugin.yaml" || file === "plugin.yml") {
    const document = (parseYaml(text) ?? {}) as Record<string, unknown>;
    return { ...fromGeneric(document), format: "yaml" };
  }
  const document = JSON.parse(text) as Record<string, unknown>;
  if (file === "openclaw.plugin.json") return fromGeneric(document, "id");
  return fromGeneric(document);
}
