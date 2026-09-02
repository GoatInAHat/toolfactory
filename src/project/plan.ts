/**
 * Assemble the full plan for a project: every selected surface's files, deduplicated by
 * path (identical content from two surfaces is fine; conflicting content is a bug), plus
 * the derived coverage files and the published schema for tool.json.
 */
import { z } from "zod";
import { getBinding } from "../bindings/index.js";
import type { PlannedFile, Project, RegionFile, Surface } from "../model.js";
import { ToolConfigSchema } from "../model.js";
import { computeCoverage, renderCoverageMarkdown } from "../report/coverage.js";
import { assertSurfaceRequirements, getSurface, selectedSurfaces } from "../surfaces/registry.js";
import { json } from "../surfaces/shared.js";
import { managedContent } from "./apply.js";
import { readLock, TOOLFACTORY_DIR } from "./lock.js";

export const COVERAGE_PATH = `${TOOLFACTORY_DIR}/coverage.json`;
export const TOOL_SCHEMA_PATH = `${TOOLFACTORY_DIR}/tool.schema.json`;

export function toolJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(ToolConfigSchema, { io: "input" }) as Record<string, unknown>;
}

/**
 * Two projectors may own different regions of one author-owned file (`readme`'s install block and
 * `pypi`'s mcp-name marker both live in README.md), so the plan carries their union and the
 * template grows the marker pairs it is missing. Only the same marker holding different content is
 * a conflict.
 */
function mergeRegions(base: RegionFile, extra: RegionFile): RegionFile {
  const regions = [...base.regions];
  for (const region of extra.regions) {
    const owner = regions.find((planned) => planned.begin === region.begin);
    if (!owner) regions.push(region);
    else if (owner.content !== region.content) {
      throw new Error(`Two surfaces plan different content for ${base.path} ${region.begin}.`);
    }
  }
  const missing = regions.filter((region) => !base.template.includes(region.begin));
  if (missing.length === 0) return { ...base, regions };
  const appended = missing.map((region) => `${region.begin}\n${region.end}`).join("\n");
  return { ...base, regions, template: `${base.template}\n${appended}\n` };
}

function dedupe(files: PlannedFile[]): PlannedFile[] {
  const byPath = new Map<string, PlannedFile>();
  for (const file of files) {
    const existing = byPath.get(file.path);
    if (!existing) {
      byPath.set(file.path, file);
    } else if (existing.kind === "region" && file.kind === "region") {
      byPath.set(file.path, mergeRegions(existing, file));
    } else if (managedContent(existing) !== managedContent(file)) {
      throw new Error(`Two surfaces plan different content for ${file.path}.`);
    }
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export function buildPlan(
  project: Project,
  surfaces: Surface[] = selectedSurfaces(project.tool.surfaces),
): PlannedFile[] {
  // Always the declared selection, never the argument: `eject` plans one surface out of a valid one.
  assertSurfaceRequirements(project.tool.surfaces);
  // Workflows are always generated: ci.yml for every project, release.yml when a registry is selected.
  // COVERAGE.md is always generated too: a one-surface table is still the record of what is excluded.
  const withWorkflows = surfaces.some((s) => s.id === "workflows")
    ? surfaces
    : [...surfaces, getSurface("workflows")];
  // AGENTS.md is always generated too, so an agent developing the tool has it from the first build.
  const withAgents = withWorkflows.some((s) => s.id === "agents")
    ? withWorkflows
    : [...withWorkflows, getSurface("agents")];
  // README.md's install region is always generated too: the one place a human or an agent
  // reads to install what this repo ships.
  const withReadme = withAgents.some((s) => s.id === "readme")
    ? withAgents
    : [...withAgents, getSurface("readme")];
  const files = withReadme.flatMap((surface) => surface.plan(project));
  // The kernel exists for every tool: it is what the author's operation module imports and
  // what `introspect` spawns, whether or not the mcp surface ships it.
  files.push(...getBinding(project.tool.binding).kernel(project));
  files.push(...getBinding(project.tool.binding).liveTest(project));
  files.push({ kind: "file", path: TOOL_SCHEMA_PATH, content: json(toolJsonSchema()) });
  const coverage = computeCoverage(project, surfaces);
  // The machine-readable half of the coverage report is a build output; COVERAGE.md is the
  // tracked one, so a repo cannot silently drift to majority-manual (§2.2 S5).
  files.push({ kind: "file", path: COVERAGE_PATH, content: json(coverage), output: true });
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
  return dedupe(files);
}
