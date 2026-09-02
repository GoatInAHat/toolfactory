/**
 * Assemble the full plan for a project: every selected surface's files, deduplicated by
 * path (identical content from two surfaces is fine; conflicting content is a bug), plus
 * the derived coverage files and the published schema for tool.json.
 */
import { z } from "zod";
import { getBinding } from "../bindings/index.js";
import type { PlannedFile, Project, Surface } from "../model.js";
import { ToolConfigSchema } from "../model.js";
import { computeCoverage, renderCoverageMarkdown } from "../report/coverage.js";
import { getSurface, selectedSurfaces } from "../surfaces/registry.js";
import { json } from "../surfaces/shared.js";
import { managedContent } from "./apply.js";
import { readLock, TOOLFACTORY_DIR } from "./lock.js";

export const COVERAGE_PATH = `${TOOLFACTORY_DIR}/coverage.json`;
export const TOOL_SCHEMA_PATH = `${TOOLFACTORY_DIR}/tool.schema.json`;

export function toolJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(ToolConfigSchema, { io: "input" }) as Record<string, unknown>;
}

function dedupe(files: PlannedFile[]): PlannedFile[] {
  const byPath = new Map<string, PlannedFile>();
  for (const file of files) {
    const existing = byPath.get(file.path);
    if (existing && managedContent(existing) !== managedContent(file)) {
      throw new Error(`Two surfaces plan different content for ${file.path}.`);
    }
    if (!existing) byPath.set(file.path, file);
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export function buildPlan(
  project: Project,
  surfaces: Surface[] = selectedSurfaces(project.tool.surfaces),
): PlannedFile[] {
  // Workflows are always generated: ci.yml for every project, release.yml when a registry is selected.
  const withWorkflows = surfaces.some((s) => s.id === "workflows")
    ? surfaces
    : [...surfaces, getSurface("workflows")];
  const files = withWorkflows.flatMap((surface) => surface.plan(project));
  // The kernel exists for every tool: it is what the author's operation module imports and
  // what `introspect` spawns, whether or not the mcp surface ships it.
  files.push(...getBinding(project.tool.binding).kernel(project));
  files.push({ kind: "file", path: TOOL_SCHEMA_PATH, content: json(toolJsonSchema()) });
  const coverage = computeCoverage(project, surfaces);
  files.push({ kind: "file", path: COVERAGE_PATH, content: json(coverage) });
  if (surfaces.length >= 2) {
    const lock = readLock(project.root);
    const manual = Object.entries(lock?.files ?? {})
      .filter(([, entry]) => entry.state === "manual")
      .map(([path]) => path);
    const total = Object.keys(lock?.files ?? {}).length || files.length;
    files.push({
      kind: "file",
      path: "COVERAGE.md",
      content: renderCoverageMarkdown(coverage, manual, total),
    });
  }
  return dedupe(files);
}
