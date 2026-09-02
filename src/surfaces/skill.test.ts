import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import type { Operation, Project } from "../model.js";
import { frontmatter, renderOperations, skillPath, surface } from "./skill.js";

const echo: Operation = {
  name: "echo",
  description: "Return the text you pass in.",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
  },
  requires: [],
};
const screenshot: Operation = {
  name: "screenshot",
  description: "Capture the current page.",
  inputSchema: { type: "object", properties: {} },
  requires: ["browser"],
};
const notify: Operation = {
  name: "notify",
  description: "Post a message into the live conversation.",
  inputSchema: { type: "object", properties: {} },
  requires: ["channel"],
};

function project(overrides: Partial<Project> = {}): Project {
  return {
    root: "/repo",
    tool: {
      schemaVersion: 1,
      identity: "package.json",
      binding: "typescript",
      surfaces: ["skill", "cli", "mcp"],
      bundle: { runtime: "package" },
      tests: { examples: {} },
    },
    identity: { name: "hello", version: "1.0.0", description: "Say hello", license: "MIT" },
    identityExtra: {},
    operations: [echo, screenshot, notify],
    toolfactoryVersion: "0.1.0",
    ...overrides,
  };
}

describe("skill surface", () => {
  it("names the file after the tool and plans exactly one region file", () => {
    const target = project();
    expect(skillPath(target)).toBe("skills/hello/SKILL.md");
    const plan = surface.plan(target);
    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({ kind: "region", path: "skills/hello/SKILL.md" });
  });

  it("frontmatter carries the 6 spec fields, falling back to a description", () => {
    const document = parseYaml(frontmatter(project()));
    expect(document).toEqual({ name: "hello", description: "Say hello", license: "MIT" });

    const noDescription = parseYaml(
      frontmatter(project({ identity: { name: "hello", description: undefined } })),
    );
    expect(noDescription.description).toBe("Use the hello tool.");
  });

  it("the operations block includes a portable op's CLI/MCP invocation and a bridged op's text, and omits an excluded op", () => {
    const body = renderOperations(project());

    expect(body).toContain("### echo");
    expect(body).toContain("`hello echo --json '<arguments>'` prints a JSON result.");
    expect(body).toContain("MCP tool `echo` on server `hello`");
    expect(body).toContain("Arguments: `text`.");

    expect(body).toContain("### screenshot");
    expect(body).toContain(
      "This operation needs browser: use this host's own tools to obtain it, then pass the result as an argument.",
    );

    expect(body).not.toContain("### notify");
  });

  it("validate runs the upstream agentskills validator against skills/<name>", () => {
    const commands = surface.validate?.(project()) ?? [];
    expect(commands).toEqual([
      {
        label: "agentskills validate",
        command: "uvx",
        args: ["--from", "skills-ref", "agentskills", "validate", "skills/hello"],
        cwd: "/repo",
      },
    ]);
  });
});
