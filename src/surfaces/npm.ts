/**
 * npm package: identity projected into package.json (merge; the author owns the rest),
 * the CLI bin, and the MCP Registry ownership marker.
 */

import { githubSlug } from "../hosts/github.js";
import type { Surface } from "../model.js";
import { registryName } from "./mcp-registry.js";
import { compact, has, npmName } from "./shared.js";

/**
 * npm's object form. A bare URL string is only valid as one of npm's shorthands, so `publint`
 * rejects the one an identity file carries; the slug keeps its authored case, because GitHub
 * owner and repository names are case-preserving.
 */
function repositoryField(
  repository: string | undefined,
): { type: string; url: string } | undefined {
  if (!repository) return undefined;
  const slug = githubSlug(repository);
  return { type: "git", url: slug ? `git+https://github.com/${slug}.git` : repository };
}

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
      repository: authored ? undefined : repositoryField(identity.repository),
      keywords: authored ? undefined : identity.keywords,
      type: "module",
      bin:
        has(project, "cli") || has(project, "mcp")
          ? { [identity.name]: "./dist/toolfactory/cli.js" }
          : undefined,
      files: ["dist", "src", "schemas", "README.md", "LICENSE"],
      mcpName: has(project, "mcp-registry") ? registryName(project) : undefined,
    });
    return [{ kind: "merge", path: "package.json", format: "json", patch, owned: ["bin"] }];
  },
  validate(project) {
    return [
      {
        label: "npm pack",
        command: "npm",
        args: ["pack", "--dry-run", "--ignore-scripts"],
        cwd: project.root,
      },
      {
        // The publishing linter: it packs the tarball and reads it the way npm, the CDNs and the
        // bundlers do. `--strict` because its default exit code is 0 even with warnings.
        label: "publint",
        command: "npx",
        args: ["--yes", "publint", "--strict"],
        cwd: project.root,
      },
    ];
  },
};
