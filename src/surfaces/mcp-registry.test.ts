import { describe, expect, it } from "vitest";
import type { Operation, Project } from "../model.js";
import { registryName, surface } from "./mcp-registry.js";

const echo: Operation = { name: "echo", inputSchema: { type: "object" }, requires: [] };

function project(overrides: Partial<Project> = {}): Project {
  return {
    root: "/repo",
    tool: {
      schemaVersion: 1,
      identity: "plugin.json",
      binding: "typescript",
      surfaces: ["mcp-registry", "mcp"],
      bundle: { runtime: "package" },
      tests: { examples: {} },
      ...overrides.tool,
    },
    identity: {
      name: "hello",
      version: "1.2.0",
      description: "Say hello",
      repository: "https://github.com/GoatInAHat/hello-tool",
      ...overrides.identity,
    },
    identityExtra: {},
    operations: [echo],
    toolfactoryVersion: "0.1.0",
    packageManager: "npm",
    ...overrides,
  };
}

function files(target: Project): Record<string, string> {
  return Object.fromEntries(
    surface.plan(target).map((file) => [file.path, file.kind === "file" ? file.content : ""]),
  );
}

describe("mcp-registry Dockerfile", () => {
  it("labels the image with server.json's own name, in the final stage, per binding", () => {
    const ts = files(project());
    const server = JSON.parse(ts["server.json"] ?? "{}");
    expect(server.name).toBe("io.github.GoatInAHat/hello");
    const stages = ts.Dockerfile?.split(/\nFROM /) ?? [];
    expect(stages.at(-1)).toContain(`LABEL io.modelcontextprotocol.server.name="${server.name}"`);

    const py = files(project({ tool: { ...project().tool, binding: "python" } }));
    const pyServer = JSON.parse(py["server.json"] ?? "{}");
    const pyStages = py.Dockerfile?.split(/\nFROM /) ?? [];
    expect(pyStages.at(-1)).toContain(
      `LABEL io.modelcontextprotocol.server.name="${pyServer.name}"`,
    );
  });

  it("runs the kernel's mcp entrypoint directly, independent of the packaging step", () => {
    const ts = files(project({ packageManager: "pnpm" }));
    expect(ts.Dockerfile).toContain('ENTRYPOINT ["node","dist/toolfactory/mcp.js"]');
    expect(ts.Dockerfile).toContain("RUN corepack enable");
    expect(ts.Dockerfile).toContain("pnpm install --frozen-lockfile");

    const npmBuilt = files(project({ packageManager: "npm" }));
    expect(npmBuilt.Dockerfile).toContain("npm ci");
    expect(npmBuilt.Dockerfile).not.toContain("corepack enable");

    const py = files(project({ tool: { ...project().tool, binding: "python" } }));
    expect(py.Dockerfile).toContain('ENTRYPOINT ["python","-m","hello.toolfactory.mcp"]');
  });
});

describe("mcp-registry server.json oci package", () => {
  it("adds an oci entry with a lowercased ghcr.io identifier, unconditionally", () => {
    const server = JSON.parse(files(project())["server.json"] ?? "{}");
    const oci = server.packages.find((pkg: { registryType: string }) => pkg.registryType === "oci");
    expect(oci).toMatchObject({
      registryType: "oci",
      identifier: "ghcr.io/goatinahat/hello:1.2.0",
      transport: { type: "stdio" },
    });
    // No `npm`/`pypi` surface selected, yet the oci entry is still present.
    expect(server.packages).toHaveLength(1);
  });

  it("adds the npm entry alongside oci once `npm` is also selected", () => {
    const server = JSON.parse(
      files(project({ tool: { ...project().tool, surfaces: ["mcp-registry", "mcp", "npm"] } }))[
        "server.json"
      ] ?? "{}",
    );
    expect(server.packages.map((pkg: { registryType: string }) => pkg.registryType)).toEqual([
      "npm",
      "oci",
    ]);
  });

  it("still throws registryName's error when the identity carries no GitHub repository", () => {
    expect(() => registryName({ identity: { name: "hello" } })).toThrow(/GitHub repository/);
  });
});
