/** Helpers shared by surface projectors. Pure. */
import { projectName } from "../identity/name.js";
import type { Operation, Project, Verdict } from "../model.js";
import { defaultVerdict } from "../report/coverage.js";

export const TOOLFACTORY_DIR = "dev.toolfactory";

export function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Drop undefined values so projections never emit `"key": undefined`. */
export function compact<T extends Record<string, unknown>>(record: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined),
  ) as Partial<T>;
}

export function has(project: Project, surface: string): boolean {
  return (project.tool.surfaces as string[]).includes(surface);
}

export function npmName(project: Project): string {
  return projectName.npm(project.identity.name, project.tool.npm?.scope);
}

export function pypiName(project: Project): string {
  return projectName.pypi(project.identity.name);
}

/** The launch command for the kernel MCP server as an installed package or a committed build. */
export function kernelLaunch(
  project: Project,
  placeholderRoot: string,
): { command: string; args: string[] } {
  const { binding, bundle } = project.tool;
  const version = project.identity.version ?? "latest";
  if (bundle.runtime === "bundled") {
    return binding === "python"
      ? { command: "python3", args: [`${placeholderRoot}/bin/mcp.py`] }
      : { command: "node", args: [`${placeholderRoot}/bin/mcp.js`] };
  }
  return binding === "python"
    ? {
        command: "uvx",
        args: ["--from", `${pypiName(project)}==${version}`, project.identity.name, "mcp"],
      }
    : { command: "npx", args: ["-y", `${npmName(project)}@${version}`, "mcp"] };
}

/** Verdict for surfaces that only carry MCP tool calls: no host capabilities at all. */
export function mcpVerdict(operation: Operation): Verdict {
  const verdict = defaultVerdict(operation);
  return verdict.kind === "excluded"
    ? { kind: "excluded", reason: "excluded:mcp-no-host-capabilities" }
    : verdict;
}

/** Verdict for skills hosts: non-portable operations are bridged by the agent driving the host's own tools. */
export function skillVerdict(operation: Operation): Verdict {
  const verdict = defaultVerdict(operation);
  if (verdict.kind !== "excluded") return verdict;
  if (operation.requires.includes("channel"))
    return { kind: "excluded", reason: "excluded:no-channel-bridge" };
  return { kind: "bridged", reason: "bridged:agent-mediated" };
}

export function configProperties(project: Project): Record<string, Record<string, unknown>> {
  const properties = project.tool.config?.properties;
  return properties && typeof properties === "object"
    ? (properties as Record<string, Record<string, unknown>>)
    : {};
}

export function isSensitive(property: Record<string, unknown>): boolean {
  const meta = property["x-toolfactory"] as Record<string, unknown> | undefined;
  return meta?.sensitive === true;
}

export function requiredConfig(project: Project): string[] {
  const required = project.tool.config?.required;
  return Array.isArray(required) ? (required as string[]) : [];
}

/**
 * Environment variable a host-native shim reads to find the tool's checkout when the host
 * copied the plugin elsewhere (Hermes' doctor, OpenClaw's extensions directory).
 */
export function rootEnvName(project: Project): string {
  return `${project.identity.name.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_ROOT`;
}
