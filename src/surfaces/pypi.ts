/**
 * PyPI package: identity projected into pyproject.toml (merge; the author owns the rest),
 * the console script for the CLI, and the MCP Registry ownership marker, which for PyPI is
 * an `mcp-name:` line in the README the registry reads back off the published project page.
 */
import { cliEntryPoint, projectTable, pythonPackage } from "../bindings/python.js";
import type { Surface } from "../model.js";
import { registryName } from "./mcp-registry.js";
import { compact, has } from "./shared.js";
import { WEB_DIR } from "./web.js";

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
      // Hatch ignores a missing `only-include` path, unlike `force-include`, which makes
      // `uv sync` work in a fresh checkout before the optional page is built. At package time,
      // the gate builds `web/dist` first and Hatch maps it into the installed package.
      ...(has(project, "web")
        ? {
            tool: {
              hatch: {
                build: {
                  targets: {
                    wheel: {
                      "only-include": [`src/${pythonPackage(project)}`, `${WEB_DIR}/dist`],
                      sources: {
                        src: "",
                        [`${WEB_DIR}/dist`]: `${pythonPackage(project)}/${WEB_DIR}`,
                      },
                    },
                    // This is the source MCPB stages, so include every declared project metadata
                    // file alongside the package and built page. `only-include` ignores absent
                    // legal files without making fresh checkouts fail.
                    sdist: {
                      "only-include": [
                        "pyproject.toml",
                        "README.md",
                        "LICENSE",
                        "LICENSE.md",
                        "LICENSE.txt",
                        "NOTICE",
                        "NOTICE.md",
                        "NOTICE.txt",
                        `src/${pythonPackage(project)}`,
                        `${WEB_DIR}/dist`,
                      ],
                    },
                  },
                },
              },
            },
          }
        : {}),
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
