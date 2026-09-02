/**
 * Surface "readme": the `<!-- tf:install -->` region of `README.md`, always generated (like
 * `workflows` and `agents`; never in `tool.json.surfaces`). One install line per selected
 * distribution surface, in the exact shape that surface's own installer accepts, so the
 * humans-and-agents-facing half of distribution cannot drift from the artifacts. The prose
 * around the region — what the tool is, how to use it — is the author's, forever.
 *
 * Every line works from a plain checkout; the ones that need a GitHub repository (`npx skills
 * add`, the skills.sh badge, the marketplace and Hermes clone URLs) appear only once the
 * identity file carries one, so a tool built without GitHub still gets an accurate section.
 */
import { githubSlug } from "../hosts/github.js";
import { projectName } from "../identity/name.js";
import type { Project, Surface } from "../model.js";
import { pluginDir as hermesPluginDir } from "./hermes-native.js";
import { HOST_DIR as OPENCLAW_HOST_DIR } from "./openclaw-native.js";
import { has, npmName, pypiName } from "./shared.js";

export const README_PATH = "README.md";
export const INSTALL_BEGIN = "<!-- tf:install -->";
export const INSTALL_END = "<!-- /tf:install -->";
/** Where the `dsh` surface's Cordis bundle lives; DSH installs a plugin from a path. */
const DSH_HOST_DIR = "hosts/dsh";

/** The kernel MCP server as a one-shot command: the same launch `mcp.json` carries, unpinned. */
function mcpCommand(project: Project): string {
  if (project.tool.binding === "python") {
    const pypi = pypiName(project);
    // `uvx <pkg>` runs the command of the same name; a dotted tool name renames the package.
    return pypi === project.identity.name
      ? `uvx ${pypi} mcp`
      : `uvx --from ${pypi} ${project.identity.name} mcp`;
  }
  return `npx -y ${npmName(project)} mcp`;
}

function installLines(project: Project): string[] {
  const { identity } = project;
  const slug = githubSlug(identity.repository);
  const lines: string[] = [];
  if (has(project, "skill") && slug) {
    lines.push(`- **Agent Skill** — \`npx skills add ${slug}\``);
  }
  if (has(project, "mcp")) {
    lines.push(`- **MCP server** — \`${mcpCommand(project)}\``);
  }
  if (has(project, "claude")) {
    // The repository is its own marketplace (`.claude-plugin/marketplace.json`); Copilot CLI
    // reads the same file with the same command.
    lines.push(
      `- **Claude Code plugin** — \`claude plugin marketplace add ${slug ?? "."}\`, then \`claude plugin install ${identity.name}@${identity.name}\``,
    );
  }
  if (has(project, "openclaw-native")) {
    const clawhub = has(project, "clawhub")
      ? `; published: \`openclaw plugins install clawhub:${projectName.openclawPackage(identity.name)}\``
      : "";
    lines.push(
      `- **OpenClaw plugin** — \`openclaw plugins install --link ${OPENCLAW_HOST_DIR}\` from a checkout${clawhub}`,
    );
  }
  if (has(project, "hermes-native")) {
    const source = slug ? `https://github.com/${slug}` : "file://$PWD";
    lines.push(
      `- **Hermes plugin** — \`hermes plugins install ${source}#${hermesPluginDir(project)}\``,
    );
  }
  if (has(project, "dsh")) {
    lines.push(
      `- **DSH plugin** (experimental) — \`dsh plugin --profile <profile> add ./${DSH_HOST_DIR}\``,
    );
  }
  if (has(project, "npm")) lines.push(`- **npm package** — \`npm install ${npmName(project)}\``);
  if (has(project, "pypi")) lines.push(`- **PyPI package** — \`uv add ${pypiName(project)}\``);
  return lines;
}

/** The content of the generated region — everything between the markers, not the markers. */
export function installContent(project: Project): string {
  const slug = githubSlug(project.identity.repository);
  const badge =
    has(project, "skill") && slug
      ? [`[![skills.sh](https://skills.sh/b/${slug})](https://skills.sh/${slug})`, ""]
      : [];
  const lines = installLines(project);
  return `${[
    "",
    "## Install",
    "",
    ...badge,
    ...(lines.length
      ? lines
      : ["_No installable surface is selected: this repository ships source only._"]),
    "",
  ].join("\n")}\n`;
}

function template(project: Project): string {
  return [
    `# ${project.identity.name}`,
    "",
    project.identity.description ?? "One paragraph: what this tool does, and for whom.",
    "",
    INSTALL_BEGIN,
    INSTALL_END,
    "",
  ].join("\n");
}

export const surface: Surface = {
  id: "readme",
  plan(project) {
    return [
      {
        kind: "region",
        path: README_PATH,
        regions: [{ begin: INSTALL_BEGIN, end: INSTALL_END, content: installContent(project) }],
        template: template(project),
      },
    ];
  },
};
