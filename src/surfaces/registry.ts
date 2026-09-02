import type { Surface, SurfaceId } from "../model.js";
import { surface as agentPlugins } from "./agent-plugins.js";
import { surface as agents } from "./agents.js";
import { surface as claude } from "./claude.js";
import { surface as codex } from "./codex.js";
import { surface as cursor } from "./cursor.js";
import { surface as dsh } from "./dsh.js";
import { clawhub } from "./external.js";
import { surface as gemini } from "./gemini.js";
import { surface as hermesNative } from "./hermes-native.js";
import { cli, mcp } from "./kernel.js";
import { surface as mcpRegistry } from "./mcp-registry.js";
import { surface as mcpb } from "./mcpb.js";
import { surface as npm } from "./npm.js";
import { surface as openclawNative } from "./openclaw-native.js";
import { surface as pypi } from "./pypi.js";
import { surface as readme } from "./readme.js";
import { surface as skill } from "./skill.js";
import { surface as web } from "./web.js";
import { surface as workflows } from "./workflows.js";

const registry: Partial<Record<SurfaceId, Surface>> = {
  "agent-plugins": agentPlugins,
  agents,
  claude,
  codex,
  // Declared dependencies (§3): these projectors point at a file another surface writes, so a
  // selection without it would ship an artifact referencing nothing. Refused at plan time.
  cursor: { ...cursor, requires: ["agent-plugins"] },
  clawhub,
  // Reaches the kernel only through DSH's own MCP client, so the bundle is inert without it.
  dsh: { ...dsh, requires: ["mcp"] },
  // The manifest's only payload is the kernel's launch row: an extension without it is a
  // context file and nothing else.
  gemini: { ...gemini, requires: ["mcp"] },
  cli,
  mcp,
  "mcp-registry": mcpRegistry,
  // The bundle root is the npm tarball with its production dependencies installed into it, and
  // its one row launches the kernel MCP server: without either surface there is nothing to pack.
  mcpb: { ...mcpb, requires: ["mcp", "npm"] },
  npm,
  skill,
  "hermes-native": hermesNative,
  "openclaw-native": openclawNative,
  pypi,
  readme,
  web: { ...web, requires: ["mcp"] },
  workflows,
};

export function registerSurface(surface: Surface): void {
  registry[surface.id] = surface;
}

export function getSurface(id: SurfaceId): Surface {
  const surface = registry[id];
  if (!surface) throw new Error(`Surface "${id}" is not implemented in this toolfactory version.`);
  return surface;
}

export function selectedSurfaces(ids: readonly SurfaceId[]): Surface[] {
  return ids.map(getSurface);
}

/** A selection is valid only when every surface's declared dependencies are selected too. */
export function assertSurfaceRequirements(ids: readonly SurfaceId[]): void {
  const selected = new Set(ids);
  for (const id of ids) {
    for (const required of getSurface(id).requires ?? []) {
      if (selected.has(required)) continue;
      throw new Error(
        `Surface "${id}" requires surface "${required}", which is not selected (surfaces: ${ids.join(", ")}). Select "${required}" or drop "${id}".`,
      );
    }
  }
}
