import { describe, expect, it } from "vitest";
import type { Operation, Project, SurfaceId } from "../model.js";
import { surface as codex } from "./codex.js";

const echo: Operation = { name: "echo", inputSchema: { type: "object" }, requires: [] };

function project(surfaces: SurfaceId[]): Project {
  return {
    root: "/repo",
    tool: {
      schemaVersion: 1,
      identity: "plugin.json",
      binding: "typescript",
      surfaces,
      bundle: { runtime: "package" },
      tests: { examples: {} },
    },
    identity: {
      name: "hello",
      version: "0.1.0",
      description: "Say hello",
      author: { name: "GoatInAHat" },
      repository: "https://github.com/GoatInAHat/Hello-Tool",
    },
    identityExtra: {},
    operations: [echo],
    toolfactoryVersion: "0.1.0",
    packageManager: "npm",
  };
}

describe("codex", () => {
  it("makes the repository its own single-plugin marketplace, and validates with the real codex CLI", () => {
    const files = codex.plan(project(["codex", "mcp"]));
    const marketplace = files.find((entry) => entry.path === ".agents/plugins/marketplace.json");
    if (marketplace?.kind !== "file") throw new Error("expected a whole file");
    expect(JSON.parse(marketplace.content)).toMatchObject({
      name: "hello",
      interface: { displayName: "Hello" },
      plugins: [
        {
          name: "hello",
          source: { source: "local", path: "." },
          policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
          category: "Productivity",
        },
      ],
    });

    const [command] = codex.validate?.(project(["codex", "mcp"])) ?? [];
    const script = command?.args.join(" ") ?? "";
    expect(command?.command).toBe("sh");
    expect(script).toContain("plugin marketplace add . --json");
    expect(script).toContain("plugin add hello@hello --json");
    expect(script).toContain("plugin list --available --json");
    expect(script).toContain("CODEX_HOME");
  });
});
