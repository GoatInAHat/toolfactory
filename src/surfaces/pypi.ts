/**
 * PyPI package: identity projected into pyproject.toml (merge; the author owns the rest),
 * the console script for the CLI, and the MCP Registry ownership marker, which for PyPI is
 * an `mcp-name:` line in the README the registry reads back off the published project page.
 */
import { cliEntryPoint, projectTable } from "../bindings/python.js";
import type { Surface } from "../model.js";
import { registryName } from "./mcp-registry.js";
import { compact, has } from "./shared.js";

export const README_PATH = "README.md";
export const MCP_NAME_BEGIN = "<!-- tf:mcp-name -->";
export const MCP_NAME_END = "<!-- /tf:mcp-name -->";

export const surface: Surface = {
  id: "pypi",
  plan(project) {
    if (project.tool.binding !== "python") {
      throw new Error('Surface "pypi" requires the python binding.');
    }
    const authored = project.tool.identity === "pyproject.toml";
    const registry = has(project, "mcp-registry");
    const patch = {
      project: compact({
        ...(authored ? {} : projectTable(project)),
        readme: registry ? README_PATH : undefined,
        scripts: has(project, "cli")
          ? { [project.identity.name]: cliEntryPoint(project) }
          : undefined,
      }),
    };
    const files = [
      {
        kind: "merge" as const,
        path: "pyproject.toml",
        format: "toml" as const,
        patch,
        owned: ["project.scripts"],
      },
    ];
    if (!registry) return files;
    const marker = `\n<!-- mcp-name: ${registryName(project)} -->\n`;
    return [
      ...files,
      {
        kind: "region" as const,
        path: README_PATH,
        regions: [{ begin: MCP_NAME_BEGIN, end: MCP_NAME_END, content: marker }],
        template: [
          `# ${project.identity.name}`,
          "",
          project.identity.description ?? "",
          "",
          MCP_NAME_BEGIN,
          MCP_NAME_END,
          "",
        ].join("\n"),
      },
    ];
  },
  validate(project) {
    return [{ label: "uv build", command: "uv", args: ["build"], cwd: project.root }];
  },
};
