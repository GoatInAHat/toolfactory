import type { Surface, SurfaceId } from "../model.js";
import { surface as agentPlugins } from "./agent-plugins.js";
import { surface as agents } from "./agents.js";
import { surface as claude } from "./claude.js";
import { surface as codex } from "./codex.js";
import { surface as cursor } from "./cursor.js";
import { clawhub, dsh } from "./external.js";
import { surface as hermesNative } from "./hermes-native.js";
import { cli, mcp } from "./kernel.js";
import { surface as mcpRegistry } from "./mcp-registry.js";
import { surface as npm } from "./npm.js";
import { surface as openclawNative } from "./openclaw-native.js";
import { surface as pypi } from "./pypi.js";
import { surface as skill } from "./skill.js";
import { surface as web } from "./web.js";
import { surface as workflows } from "./workflows.js";

const registry: Partial<Record<SurfaceId, Surface>> = {
  "agent-plugins": agentPlugins,
  agents,
  claude,
  codex,
  cursor,
  clawhub,
  dsh,
  cli,
  mcp,
  "mcp-registry": mcpRegistry,
  npm,
  skill,
  "hermes-native": hermesNative,
  "openclaw-native": openclawNative,
  pypi,
  web,
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
