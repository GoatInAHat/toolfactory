/**
 * npm package: identity projected into package.json (merge; the author owns the rest),
 * the CLI bin, and the MCP Registry ownership marker.
 */

import { githubSlug } from "../hosts/github.js";
import type { Project, Surface } from "../model.js";
import { registryName } from "./mcp-registry.js";
import { compact, has, npmName, pypiName } from "./shared.js";
import { WEB_DIR } from "./web.js";

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

/**
 * A deliberately thin cross-registry bridge: npm supplies discovery and a familiar `npx` entry,
 * while uvx resolves the canonical Python distribution. `uvx` owns Python acquisition, caching,
 * and the package install; the npm package never downloads an interpreter itself.
 */
function pythonLauncher(project: Project): string {
  const { identity } = project;
  return `#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const child = spawnSync("uvx", ["--from", ${JSON.stringify(`${pypiName(project)}==${identity.version}`)}, ${JSON.stringify(identity.name)}, ...process.argv.slice(2)], {
  stdio: "inherit",
});
if (child.error) throw child.error;
process.exit(child.status ?? 1);
`;
}

export const surface: Surface = {
  id: "npm",
  plan(project) {
    const { identity } = project;
    const authored = project.tool.identity === "package.json";
    const python = project.tool.binding === "python";
    const launcher = `bin/${identity.name}.mjs`;
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
          ? {
              [identity.name]: python ? `./${launcher}` : "./dist/toolfactory/cli.js",
            }
          : undefined,
      // `web/dist` only with the `web` surface: the kernel serves the built page from inside
      // the installed package, so `npx <tool> mcp --http --open` works without a checkout.
      files: python
        ? ["bin", "README.md", "LICENSE"]
        : [
            "dist",
            "src",
            "schemas",
            ...(has(project, "web") ? [`${WEB_DIR}/dist`] : []),
            "README.md",
            "LICENSE",
          ],
      mcpName: has(project, "mcp-registry") ? registryName(project) : undefined,
    });
    return [
      ...(python && (has(project, "cli") || has(project, "mcp"))
        ? [{ kind: "file" as const, path: launcher, content: pythonLauncher(project) }]
        : []),
      {
        kind: "merge" as const,
        path: "package.json",
        format: "json" as const,
        patch,
        owned: ["bin", "files"],
      },
    ];
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
