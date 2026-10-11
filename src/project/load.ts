import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { readIdentityFile } from "../identity/read.js";
import {
  CAPABILITIES,
  type Capability,
  isInstructionOnly,
  type Operation,
  PACKAGE_MANAGERS,
  type PackageManager,
  type Project,
  type ProjectSkill,
  ToolConfigSchema,
} from "../model.js";
import { has } from "../surfaces/shared.js";
import { skillFile } from "../surfaces/skill.js";
import { renderFile } from "./apply.js";
import { readLock, TOOLFACTORY_DIR } from "./lock.js";

export const TOOL_PATH = `${TOOLFACTORY_DIR}/tool.json`;
export const OPS_PATH = `${TOOLFACTORY_DIR}/ops.json`;

const require = createRequire(import.meta.url);
export const TOOLFACTORY_VERSION: string = require("../../package.json").version;

/** `ops.json`: the `tools/list` result, verbatim, sorted by name. */
export const OpsSchema = z.object({
  tools: z.array(
    z
      .object({
        name: z.string(),
        title: z.string().optional(),
        description: z.string().optional(),
        inputSchema: z.record(z.string(), z.unknown()),
        outputSchema: z.record(z.string(), z.unknown()).optional(),
        annotations: z.record(z.string(), z.unknown()).optional(),
        _meta: z.record(z.string(), z.unknown()).optional(),
      })
      .passthrough(),
  ),
});
export type Ops = z.infer<typeof OpsSchema>;

export function toOperation(tool: Ops["tools"][number]): Operation {
  const meta = (tool._meta?.["dev.toolfactory"] ?? {}) as Record<string, unknown>;
  const declared = Array.isArray(meta.requires) ? meta.requires : [];
  const requires = declared.filter((c): c is Capability =>
    (CAPABILITIES as readonly string[]).includes(String(c)),
  );
  const unknown = declared.filter((c) => !(CAPABILITIES as readonly string[]).includes(String(c)));
  if (unknown.length) {
    throw new Error(
      `Operation ${tool.name} declares unknown capabilities ${JSON.stringify(unknown)}; allowed: ${CAPABILITIES.join(", ")}`,
    );
  }
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    annotations: tool.annotations,
    requires,
  };
}

export function readOps(root: string): Operation[] {
  const path = join(root, OPS_PATH);
  if (!existsSync(path)) return [];
  return OpsSchema.parse(JSON.parse(readFileSync(path, "utf8"))).tools.map(toOperation);
}

/** The package manager the root package.json declares (`packageManager: "pnpm@10.0.0"`), if any. */
function readPackageManager(root: string): PackageManager | undefined {
  const path = join(root, "package.json");
  if (!existsSync(path)) return undefined;
  const declared = (JSON.parse(readFileSync(path, "utf8")) as { packageManager?: string })
    .packageManager;
  if (!declared) return undefined;
  const name = declared.split("@")[0] ?? "";
  if (!(PACKAGE_MANAGERS as readonly string[]).includes(name)) {
    throw new Error(
      `package.json packageManager "${declared}" is not supported; toolfactory generates workflows for ${PACKAGE_MANAGERS.join(", ")}.`,
    );
  }
  return name as PackageManager;
}

/** The selected skill as a shippable unit: every text file, sorted, content in memory. */
function readProjectSkill(project: Project, name: string): ProjectSkill {
  const canonPath = `.agents/skills/${name}`;
  const canon = join(project.root, canonPath);
  const lock = readLock(project.root) ?? {
    toolfactoryVersion: project.toolfactoryVersion,
    files: {},
  };
  const entry = lstatSync(canon, { throwIfNoEntry: false });
  const generatedAlias =
    entry?.isSymbolicLink() &&
    resolve(dirname(canon), readlinkSync(canon)) === join(project.root, "skills", name);
  const custom =
    project.tool.openclaw?.skills !== undefined &&
    lock.files[canonPath]?.state === "manual" &&
    !generatedAlias;
  const own = has(project, "skill") && name === project.identity.name && !custom;
  const planned = own ? skillFile(project) : undefined;
  const directory = planned ? dirname(join(project.root, planned.path)) : canon;
  if (!existsSync(directory) && !own) {
    throw new Error(
      `openclaw.skills declares "${name}" but ${join(".agents", "skills", name)} does not exist`,
    );
  }
  const files = (
    existsSync(directory) ? readdirSync(directory, { recursive: true, withFileTypes: true }) : []
  )
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort()
    .map((absolute) => ({
      path: relative(directory, absolute).replaceAll(sep, "/"),
      content: readFileSync(absolute, "utf8"),
    }));
  if (planned) {
    const content =
      lock.files[planned.path]?.state === "manual"
        ? readFileSync(join(project.root, planned.path), "utf8")
        : renderFile(project.root, planned, lock);
    return {
      name,
      files: [
        ...files.filter((file) => file.path !== "SKILL.md"),
        { path: "SKILL.md", content },
      ].sort((a, b) => a.path.localeCompare(b.path)),
    };
  }
  return { name, files };
}

export function loadProject(rootInput = "."): Project {
  const root = resolve(rootInput);
  const toolPath = join(root, TOOL_PATH);
  if (!existsSync(toolPath)) {
    throw new Error(`${TOOL_PATH} not found in ${root}; run \`toolfactory init\` first.`);
  }
  const tool = ToolConfigSchema.parse(JSON.parse(readFileSync(toolPath, "utf8")));
  const identityFile = readIdentityFile(join(root, tool.identity));
  const project: Project = {
    root,
    tool,
    identity: identityFile.identity,
    identityExtra: identityFile.extra,
    operations: isInstructionOnly(tool) ? [] : readOps(root),
    toolfactoryVersion: TOOLFACTORY_VERSION,
    packageManager: readPackageManager(root),
  };
  const names =
    tool.openclaw?.skills ??
    (has(project, "openclaw-native") && has(project, "skill") ? [project.identity.name] : []);
  project.skills = names.map((name) => readProjectSkill(project, name));
  return project;
}
