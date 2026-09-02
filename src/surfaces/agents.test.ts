import { describe, expect, it } from "vitest";
import type { Operation, Project, SurfaceId } from "../model.js";
import { AGENTS_BEGIN, AGENTS_END, surface } from "./agents.js";

const echo: Operation = { name: "echo", inputSchema: { type: "object" }, requires: [] };

function project(surfaces: SurfaceId[], overrides: Partial<Project["tool"]> = {}): Project {
  return {
    root: "/repo",
    tool: {
      schemaVersion: 1,
      identity: "package.json",
      binding: "typescript",
      surfaces,
      bundle: { runtime: "package" },
      tests: { examples: {} },
      config: {
        properties: {
          api_key: { type: "string", description: "key", "x-toolfactory": { sensitive: true } },
        },
        required: ["api_key"],
      },
      ...overrides,
    },
    identity: { name: "hello", version: "0.1.0", description: "Say hello" },
    identityExtra: {},
    operations: [echo],
    toolfactoryVersion: "0.1.0",
    packageManager: "npm",
  };
}

function content(target: Project): string {
  const [file] = surface.plan(target);
  if (file?.kind !== "region") throw new Error("expected a region file");
  return file.regions[0]?.content ?? "";
}

describe("agents", () => {
  it("plans AGENTS.md as one region inside an author-owned template", () => {
    const [file] = surface.plan(project(["cli", "mcp"]));
    if (file?.kind !== "region") throw new Error("expected a region file");
    expect(file.path).toBe("AGENTS.md");
    expect(file.template).toContain(`# hello\n`);
    expect(file.template).toContain(`${AGENTS_BEGIN}\n${AGENTS_END}`);
    const body = file.regions[0]?.content ?? "";
    expect(body).not.toContain(AGENTS_BEGIN);
    for (const verb of ["introspect", "build", "check", "validate", "coverage"]) {
      expect(body).toContain(`npx toolfactory ${verb}`);
    }
    expect(body).toContain("npm run test:live");
    expect(body).toContain("mcp-builder");
    expect(body).toContain('{"command":"npx","args":["toolfactory","mcp"]}');
  });

  it("carries only the lines the selected surfaces and binding need", () => {
    const bare = content(project(["cli"], { config: { properties: {}, required: [] } }));
    expect(bare).not.toContain("test:live");
    expect(bare).not.toContain("plugins install");
    expect(bare).not.toContain("shadcn");
    expect(bare).not.toContain("mcp-builder");
    expect(bare).toContain("No host-native surface");

    const hosts = content(
      project(["openclaw-native", "hermes-native", "web"], { binding: "python" }),
    );
    expect(hosts).toContain("openclaw plugins install --link hosts/openclaw --force");
    expect(hosts).toContain("hermes plugins install file://");
    expect(hosts).toContain("hermes gateway restart");
    expect(hosts).toContain("uv run --with pytest pytest -q tests/test_live.py");
    expect(hosts).toContain("src/hello/ops.py");
    expect(hosts).toContain("npx skills add shadcn/ui@shadcn -y");
    expect(hosts).toContain('{"command":"npx","args":["shadcn@latest","mcp"]}');
  });
});
