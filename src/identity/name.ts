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
  pythonPackage: (name: string): string => name.replace(/[.-]/g, "_"),
  cursor: (name: string): string => name.replace(/\./g, "-"),
  openclawPackage: (name: string): string => `openclaw-plugin-${name}`,
  mcpRegistry: (name: string, owner: string): string => `io.github.${owner}/${name}`,
  hermesToolset: (name: string): string => name.replace(/[.-]/g, "_"),
};

/** `owner` from a GitHub repository URL, for the MCP Registry namespace. */
export function githubOwner(repository: string | undefined): string | undefined {
  if (!repository) return undefined;
  const match = repository.match(/github\.com[/:]([^/]+)\/[^/#?]+/);
  return match?.[1];
}
