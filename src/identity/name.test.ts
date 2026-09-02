import { describe, expect, it } from "vitest";
import { assertValidName, githubOwner, projectName } from "./name.js";

describe("projectName", () => {
  it("projects the canonical name N onto every wire-visible identifier", () => {
    expect(projectName.npm("hello")).toBe("hello");
    expect(projectName.npm("hello", "acme")).toBe("@acme/hello");
    expect(projectName.npm("hello", "@acme")).toBe("@acme/hello");
    expect(projectName.pypi("hello.tool")).toBe("hello-tool");
    expect(projectName.pythonPackage("hello.tool-kit")).toBe("hello_tool_kit");
    expect(projectName.cursor("hello.tool")).toBe("hello-tool");
    expect(projectName.openclawPackage("hello")).toBe("openclaw-plugin-hello");
    expect(projectName.mcpRegistry("hello", "acme")).toBe("io.github.acme/hello");
    expect(projectName.hermesToolset("hello.tool-kit")).toBe("hello_tool_kit");
  });
});

describe("githubOwner", () => {
  it("reads the owner out of a github repository URL", () => {
    expect(githubOwner("https://github.com/acme/hello")).toBe("acme");
    expect(githubOwner("git@github.com:acme/hello.git")).toBe("acme");
    expect(githubOwner(undefined)).toBeUndefined();
    expect(githubOwner("https://example.com/acme/hello")).toBeUndefined();
  });
});

describe("assertValidName", () => {
  it("accepts a lowercase, hyphen/dot-separated name", () => {
    expect(() => assertValidName("hello-tool.kit")).not.toThrow();
  });

  it("rejects a double hyphen", () => {
    expect(() => assertValidName("Bad--Name")).toThrow(/Invalid tool name/);
  });

  it("rejects a leading hyphen", () => {
    expect(() => assertValidName("-abc")).toThrow(/Invalid tool name/);
  });

  it("rejects uppercase", () => {
    expect(() => assertValidName("ABC")).toThrow(/Invalid tool name/);
  });
});
