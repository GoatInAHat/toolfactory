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
 *
 * When `mcp` is selected alongside a package registry, the MCP line also carries the two
 * first-party one-click badges (VS Code's `vscode.dev/redirect/mcp/install`, Cursor's
 * `cursor.com/en/install-mcp`), both computed from the exact same `{command, args, env}` launch
 * the plain-text line renders — a badge can never point somewhere the text line does not.
 */
import { githubSlug } from "../hosts/github.js";
import { projectName } from "../identity/name.js";
import type { Project, Surface } from "../model.js";
import { HOST_DIR as BROWSER_HOST_DIR, zipName } from "./browser-extension.js";
import { HOST_DIR as DSH_HOST_DIR, dshTarball } from "./dsh.js";
import { pluginDir as hermesPluginDir } from "./hermes-native.js";
import { HOST_DIR as OPENCLAW_HOST_DIR } from "./openclaw-native.js";
import { envName, has, npmName, pypiName, requiredConfig } from "./shared.js";

export const README_PATH = "README.md";
export const INSTALL_BEGIN = "<!-- tf:install -->";
export const INSTALL_END = "<!-- /tf:install -->";

/**
 * The kernel MCP server's published launch, unpinned — `{command, args}`, plus an `env` map of
 * blank placeholders for whatever config the tool requires. The one source both `mcpCommand`
 * (the plain-text line) and the VS Code / Cursor install badges below encode: a badge can never
 * name a launch the text line does not.
 */
function launchConfig(project: Project): {
  command: string;
  args: string[];
  env?: Record<string, string>;
} {
  const { command, args } =
    project.tool.binding === "python"
      ? (() => {
          const pypi = pypiName(project);
          // `uvx <pkg>` runs the command of the same name; a dotted tool name renames the package.
          return pypi === project.identity.name
            ? { command: "uvx", args: [pypi, "mcp"] }
            : { command: "uvx", args: ["--from", pypi, project.identity.name, "mcp"] };
        })()
      : { command: "npx", args: ["-y", npmName(project), "mcp"] };
  const required = requiredConfig(project);
  return required.length
    ? { command, args, env: Object.fromEntries(required.map((key) => [envName(key), ""])) }
    : { command, args };
}

function mcpCommand(project: Project): string {
  const { command, args } = launchConfig(project);
  return [command, ...args].join(" ");
}

/** github.com/github/github-mcp-server's README badge, verbatim shields.io style. */
function vscodeBadge(project: Project): string {
  const config = encodeURIComponent(JSON.stringify(launchConfig(project)));
  const url = `https://vscode.dev/redirect/mcp/install?name=${encodeURIComponent(project.identity.name)}&config=${config}`;
  return `[![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_Server-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](${url})`;
}

/** cursor.com/docs/mcp/install-links's own badge SVG and `en/install-mcp` redirect. */
function cursorBadge(project: Project): string {
  const config = Buffer.from(JSON.stringify(launchConfig(project))).toString("base64");
  const url = `https://cursor.com/en/install-mcp?name=${encodeURIComponent(project.identity.name)}&config=${config}`;
  return `[![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](${url})`;
}

function installLines(project: Project): string[] {
  const { identity } = project;
  const slug = githubSlug(identity.repository);
  const lines: string[] = [];
  if (has(project, "skill") && slug) {
    lines.push(`- **Agent Skill** — \`npx skills add ${slug}\``);
  }
  if (has(project, "mcp")) {
    // The one-click badges need a published package to point at: they read the same launch
    // config the text line does, so they only appear once there is somewhere to `npx`/`uvx` from.
    const badges =
      has(project, "npm") || has(project, "pypi")
        ? ` ${vscodeBadge(project)} ${cursorBadge(project)}`
        : "";
    lines.push(`- **MCP server** — \`${mcpCommand(project)}\`${badges}`);
  }
  if (has(project, "mcpb")) {
    lines.push(
      `- **Claude Desktop extension** — download \`${identity.name}.mcpb\` from the GitHub Release and double-click to install`,
    );
  }
  if (has(project, "claude")) {
    // The repository is its own marketplace (`.claude-plugin/marketplace.json`); Copilot CLI
    // reads the same file with the same command.
    lines.push(
      `- **Claude Code plugin** — \`claude plugin marketplace add ${slug ?? "."}\`, then \`claude plugin install ${identity.name}@${identity.name}\``,
    );
  }
  if (has(project, "codex")) {
    // `.agents/plugins/marketplace.json` lists the repository's own plugin (`codex.ts`).
    lines.push(
      `- **Codex plugin** — \`codex plugin marketplace add ${slug ?? "."}\`, then \`codex plugin add ${identity.name}@${identity.name}\``,
    );
  }
  if (has(project, "gemini")) {
    lines.push(
      slug
        ? `- **Gemini CLI extension** — \`gemini extensions install https://github.com/${slug}\``
        : "- **Gemini CLI extension** — `gemini extensions link .` from a checkout",
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
    // `dsh plugin` is a pnpm forwarder: it installs a path, a tarball or a registry spec.
    lines.push(
      `- **DSH plugin** (experimental) — \`dsh plugin --profile <profile> add ./${DSH_HOST_DIR}\` from a checkout, or the release tarball \`${dshTarball(project)}\``,
    );
  }
  if (has(project, "browser-extension")) {
    // Three channels, in the order a reader needs them: build-and-load from a checkout, the
    // release assets (only Mozilla's signed xpi is a real self-hosted install — Chrome drops
    // side-loaded unpacked extensions), the store listings. Pairing is the last step of each.
    const zips = (["chrome", "firefox", "edge"] as const).map(
      (browser) => `\`${zipName(project, browser)}\``,
    );
    lines.push(
      [
        `- **Browser extension** — from a checkout: \`npm --prefix ${BROWSER_HOST_DIR} install && npm --prefix ${BROWSER_HOST_DIR} exec --no -- wxt build\`,`,
        `  then \`chrome://extensions\` → developer mode → Load unpacked → \`${BROWSER_HOST_DIR}/.output/chrome-mv3\``,
        `  (Firefox: \`npm --prefix ${BROWSER_HOST_DIR} exec --no -- web-ext run\`). Each GitHub Release attaches the`,
        `  store uploads ${zips.join(", ")}, and the Mozilla-signed \`.xpi\`,`,
        "  which is the only download-and-install channel now that Chrome no longer keeps side-loaded unpacked",
        "  extensions; the Chrome Web Store, Firefox Add-ons and Edge Add-ons listings appear once the release's",
        `  submit step has each store's credentials. Then pair it: \`${mcpCommand(project)} --http --pair\``,
        "  prints the `<url>#<token>` the extension's options page accepts.",
      ].join("\n"),
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
