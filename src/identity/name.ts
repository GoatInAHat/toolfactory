import { NAME_PATTERN } from "../model.js";

export function assertValidName(name: string): void {
  if (!NAME_PATTERN.test(name) || name.length > 64) {
    throw new Error(
      `Invalid tool name ${JSON.stringify(name)}: must match Agent Plugins ${NAME_PATTERN} and be at most 64 characters.`,
    );
  }
}

/** The total projection of the canonical name N onto every wire-visible identifier. */
export const projectName = {
  npm: (name: string, scope?: string): string =>
    scope ? `@${scope.replace(/^@/, "")}/${name}` : name,
  pypi: (name: string): string => name.replace(/\./g, "-"),
  pythonPackage: (name: string): string => name.replace(/[.-]/g, "_").replace(/^(?=\d)/, "_"),
  /** Human-facing name for manifests: words from the hyphens and dots, capitalised. */
  display: (name: string): string =>
    name
      .split(/[-.]/)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(" "),
  cursor: (name: string): string => name.replace(/\./g, "-"),
  /** Gemini CLI extension name: the directory name rule, the same shape as Cursor's. */
  gemini: (name: string): string => name.replace(/\./g, "-"),
  openclawPackage: (name: string): string => `openclaw-plugin-${name}`,
  mcpRegistry: (name: string, owner: string): string => `io.github.${owner}/${name}`,
  hermesToolset: (name: string): string => name.replace(/[.-]/g, "_"),
  dshPackage: (name: string): string => `${name}-dsh`,
  /** DSH `serverName`: `[A-Za-z0-9_-]{1,32}`, validated at boot, and wire-visible as `mcp__<it>__<tool>`. */
  dshServer: (name: string): string => name.replace(/\./g, "-").slice(0, 32),
};

/** `owner` from a GitHub repository URL, for the MCP Registry namespace. */
export function githubOwner(repository: string | undefined): string | undefined {
  if (!repository) return undefined;
  const match = repository.match(/github\.com[/:]([^/]+)\/[^/#?]+/);
  return match?.[1];
}
