import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readIdentityFile } from "./read.js";

let dir: string;

function file(name: string, content: string): string {
  const path = join(dir, name);
  writeFileSync(path, content);
  return path;
}

describe("readIdentityFile", () => {
  afterEach(() => {
    dir = "";
  });

  it("reads plugin.json, preserving unknown top-level keys as extra", () => {
    dir = mkdtempSync(join(tmpdir(), "tf-identity-"));
    const path = file(
      "plugin.json",
      JSON.stringify({
        name: "hello",
        version: "0.1.0",
        description: "Say hello.",
        author: { name: "Ada", email: "ada@example.com" },
        license: "MIT",
        extensions: { toolfactory: {} },
      }),
    );
    const result = readIdentityFile(path);
    expect(result.format).toBe("json");
    expect(result.identity).toMatchObject({
      name: "hello",
      version: "0.1.0",
      description: "Say hello.",
      author: { name: "Ada", email: "ada@example.com" },
      license: "MIT",
    });
    expect(result.extra).toEqual({ extensions: { toolfactory: {} } });
  });

  it("reads package.json, stripping the npm scope off a scoped name", () => {
    dir = mkdtempSync(join(tmpdir(), "tf-identity-"));
    const path = file("package.json", JSON.stringify({ name: "@acme/hello", version: "0.2.0" }));
    const result = readIdentityFile(path);
    expect(result.identity.name).toBe("hello");
    expect(result.identity.version).toBe("0.2.0");
  });

  it("reads pyproject.toml", () => {
    dir = mkdtempSync(join(tmpdir(), "tf-identity-"));
    const path = file(
      "pyproject.toml",
      [
        "[project]",
        'name = "hello-py"',
        'version = "0.3.0"',
        'description = "Say hello."',
        'authors = [{ name = "Ada", email = "ada@example.com" }]',
        "",
        "[project.urls]",
        'Repository = "https://github.com/acme/hello-py"',
        "",
      ].join("\n"),
    );
    const result = readIdentityFile(path);
    expect(result.format).toBe("toml");
    expect(result.identity).toMatchObject({
      name: "hello-py",
      version: "0.3.0",
      description: "Say hello.",
      author: { name: "Ada", email: "ada@example.com" },
      repository: "https://github.com/acme/hello-py",
    });
  });

  it("reads openclaw.plugin.json off the `id` field", () => {
    dir = mkdtempSync(join(tmpdir(), "tf-identity-"));
    const path = file(
      "openclaw.plugin.json",
      JSON.stringify({ id: "hello", version: "0.1.0", commands: ["run"] }),
    );
    const result = readIdentityFile(path);
    expect(result.identity.name).toBe("hello");
    expect(result.identity.version).toBe("0.1.0");
    // Unknown keys other than the generic identity set round-trip as extra.
    expect(result.extra).toEqual({ commands: ["run"] });
  });
});
