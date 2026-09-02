/**
 * MCP Registry: `server.json` plus the package ownership marker, and the root `Dockerfile`
 * that makes the OCI leg of `server.json` real. Publishing is the `mcp-publisher` Go binary
 * and, for the image, `docker/build-push-action`, both in CI; nothing runs here.
 */
import { pythonPackage } from "../bindings/python.js";
import { KERNEL_DIR } from "../bindings/typescript.js";
import { githubOwner, projectName } from "../identity/name.js";
import type { Project, Surface } from "../model.js";
import {
  compact,
  configProperties,
  envName,
  has,
  isSensitive,
  json,
  npmName,
  pypiName,
  requiredConfig,
} from "./shared.js";

export const SERVER_SCHEMA_ID =
  "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json";

/** `owner` from the identity file's GitHub repository, or the error every registry name needs it for. */
function requireGithubOwner(identity: { repository?: string }): string {
  const owner = githubOwner(identity.repository);
  if (!owner) {
    throw new Error(
      'Surface "mcp-registry" needs a GitHub repository URL in the identity file to derive io.github.<owner>/<name>.',
    );
  }
  return owner;
}

export function registryName(project: { identity: { name: string; repository?: string } }): string {
  return projectName.mcpRegistry(project.identity.name, requireGithubOwner(project.identity));
}

/** The registry schema caps description at 100 characters; cut at a word boundary. */
export function registryDescription(text: string): string {
  if (text.length <= 100) return text;
  const cut = text.slice(0, 100);
  return cut.slice(0, Math.max(cut.lastIndexOf(" "), 1)).replace(/[\s,;:/-]+$/, "");
}

/** `ghcr.io` requires a lowercase path; the canonical name N is already lowercase (`NAME_PATTERN`). */
export function ociImage(project: Project, owner: string): string {
  const version = project.identity.version ?? "0.0.0";
  return `ghcr.io/${owner.toLowerCase()}/${project.identity.name}:${version}`;
}

/**
 * The kernel's own `mcp` entrypoint (stdio, the only transport the image can serve —
 * `mcp.ts`/`mcp.py` binds no host flag), invoked directly so the image never depends on
 * whether `cli` or `mcp` happen to be selected: `kernel()` writes this file for every project
 * regardless of surface selection (`src/project/plan.ts`).
 */
function dockerEntrypoint(project: Project): string[] {
  return project.tool.binding === "python"
    ? ["python", "-m", `${pythonPackage(project)}.toolfactory.mcp`]
    : ["node", `${KERNEL_DIR.replace(/^src\//, "dist/")}/mcp.js`];
}

const NODE_IMAGE = "node:24-alpine";
const PYTHON_IMAGE = "python:3.12-slim-bookworm";
const UV_IMAGE = "ghcr.io/astral-sh/uv:python3.12-bookworm-slim";

/** What each package manager spells inside the build stage; mirrors `workflows.ts`'s own table. */
const DOCKER_PACKAGE_MANAGERS: Record<
  "npm" | "pnpm",
  { lockfile: string; corepack: boolean; install: string; build: string; prune: string }
> = {
  npm: {
    lockfile: "package-lock.json",
    corepack: false,
    install: "npm ci",
    build: "npm run build",
    prune: "npm prune --omit=dev",
  },
  pnpm: {
    lockfile: "pnpm-lock.yaml",
    corepack: true,
    install: "pnpm install --frozen-lockfile",
    build: "pnpm run build",
    prune: "pnpm prune --prod",
  },
};

/**
 * The root `Dockerfile`, stdio only (§4.1: no `--host` flag exists to bind past loopback), one
 * multi-stage build per binding. `label` is `server.json`'s own `name`, byte for byte — the MCP
 * registry's OCI ownership check reads it back out of the image config (`LABEL`, final stage).
 */
export function dockerfileTemplate(project: Project, label: string): string {
  if (project.tool.binding === "python") {
    return `# syntax=docker/dockerfile:1
FROM ${UV_IMAGE} AS build
WORKDIR /app
COPY pyproject.toml ./
COPY src ./src
RUN uv sync --no-dev

FROM ${PYTHON_IMAGE}
LABEL io.modelcontextprotocol.server.name="${label}"
WORKDIR /app
COPY --from=build /app/.venv ./.venv
COPY --from=build /app/src ./src
COPY --from=build /app/pyproject.toml ./
ENV PATH="/app/.venv/bin:$PATH"
ENTRYPOINT ${JSON.stringify(dockerEntrypoint(project))}
`;
  }
  const pm = DOCKER_PACKAGE_MANAGERS[project.packageManager ?? "npm"];
  return `# syntax=docker/dockerfile:1
FROM ${NODE_IMAGE} AS build
WORKDIR /app
${pm.corepack ? "RUN corepack enable\n" : ""}COPY package.json ${pm.lockfile} ./
RUN ${pm.install}
COPY . .
RUN ${pm.build} && ${pm.prune}

FROM ${NODE_IMAGE}
LABEL io.modelcontextprotocol.server.name="${label}"
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./
ENTRYPOINT ${JSON.stringify(dockerEntrypoint(project))}
`;
}

export const surface: Surface = {
  id: "mcp-registry",
  plan(project) {
    const { identity } = project;
    const version = identity.version ?? "0.0.0";
    const owner = requireGithubOwner(identity);
    const name = projectName.mcpRegistry(identity.name, owner);
    const environmentVariables = Object.entries(configProperties(project)).map(([key, property]) =>
      compact({
        name: envName(key),
        description: property.description,
        isRequired: requiredConfig(project).includes(key) || undefined,
        isSecret: isSensitive(property) || undefined,
      }),
    );
    const withEnv = <T extends Record<string, unknown>>(entry: T) =>
      compact({
        ...entry,
        environmentVariables: environmentVariables.length ? environmentVariables : undefined,
      });
    const pkg =
      project.tool.binding === "python"
        ? {
            registryType: "pypi",
            identifier: pypiName(project),
            version,
            transport: { type: "stdio" },
          }
        : {
            registryType: "npm",
            identifier: npmName(project),
            version,
            transport: { type: "stdio" },
          };
    // The OCI leg is unconditional: the root Dockerfile it names ships from every mcp-registry
    // selection (the kernel's mcp.ts/mcp.py already exists for every project, D10), unlike the
    // npm/pypi entry, which only exists when that distribution surface is also selected.
    const oci = withEnv({
      registryType: "oci",
      identifier: ociImage(project, owner),
      transport: { type: "stdio" },
    });
    const packages = [...(has(project, "npm") || has(project, "pypi") ? [withEnv(pkg)] : []), oci];
    const server = compact({
      $schema: SERVER_SCHEMA_ID,
      name,
      description: registryDescription(identity.description ?? identity.name),
      version,
      repository: identity.repository ? { url: identity.repository, source: "github" } : undefined,
      websiteUrl: identity.homepage,
      packages,
    });
    return [
      { kind: "file", path: "server.json", content: json(server) },
      { kind: "file", path: "Dockerfile", content: dockerfileTemplate(project, name) },
    ];
  },
};
