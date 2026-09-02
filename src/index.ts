export * as commands from "./commands.js";
export * from "./model.js";
export { loadProject, TOOLFACTORY_VERSION } from "./project/load.js";
export { buildPlan } from "./project/plan.js";
export { computeCoverage } from "./report/coverage.js";
export {
  assertSurfaceRequirements,
  getSurface,
  registerSurface,
  selectedSurfaces,
} from "./surfaces/registry.js";
