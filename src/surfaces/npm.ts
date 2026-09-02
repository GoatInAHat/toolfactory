/**
 * npm package: identity projected into package.json (merge; the author owns the rest),
 * the CLI bin, and the MCP Registry ownership marker.
 */

import type { Surface } from "../model.js";
import { registryName } from "./mcp-registry.js";
import { compact, has, npmName } from "./shared.js";

export const surface: Surface = {
  id: "npm",
  plan(project) {
    if (project.tool.binding !== "typescript") {
      throw new Error('Surface "npm" requires the typescript binding.');
    }
    const { identity } = project;
    const authored = project.tool.identity === "package.json";
    const patch = compact({
      name: authored ? undefined : npmName(project),
      version: authored ? undefined : identity.version,
      description: authored ? undefined : identity.description,
      license: authored ? undefined : identity.license,
      homepage: authored ? undefined : identity.homepage,
      repository: authored ? undefined : identity.repository,
      keywords: authored ? undefined : identity.keywords,
      type: "module",
      bin:
        has(project, "cli") || has(project, "mcp")
          ? { [identity.name]: "./dist/toolfactory/cli.js" }
          : undefined,
      files: ["dist", "src", "schemas", "README.md", "LICENSE"],
      mcpName: has(project, "mcp-registry") ? registryName(project) : undefined,
    });
    return [{ kind: "merge", path: "package.json", format: "json", patch }];
  },
  validate(project) {
    return [
      {
        label: "npm pack",
        command: "npm",
        args: ["pack", "--dry-run", "--ignore-scripts"],
        cwd: project.root,
      },
    ];
  },
};
