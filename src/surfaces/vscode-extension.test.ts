import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { type Project, ToolConfigSchema } from "../model.js";
import { apply, check } from "../project/apply.js";
import { packageSteps, registries } from "../project/gate.js";
import { surface } from "./vscode-extension.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): Project {
  const root = mkdtempSync(join(tmpdir(), "tf-vscode-"));
  roots.push(root);
  return {
    root,
    tool: ToolConfigSchema.parse({
      schemaVersion: 1,
      identity: "plugin.json",
      binding: "typescript",
      surfaces: ["mcp", "cli", "npm", "vscode-extension"],
      vscode: { publisher: "octo" },
    }),
    identity: { name: "hello.tool", version: "1.0.0", repository: "https://github.com/octo/hello" },
    identityExtra: {},
    operations: [
      { name: "echo", inputSchema: { type: "object" }, requires: [] },
      { name: "native", inputSchema: { type: "object" }, requires: ["model"] },
    ],
    toolfactoryVersion: "0.1.2",
  };
}

it("keeps native contributions, activation, build settings and command details across operation changes", () => {
  const project = fixture();
  apply(project.root, surface.plan(project), "0.1.2");
  const path = join(project.root, "hosts/vscode/package.json");
  const pkg = JSON.parse(readFileSync(path, "utf8"));
  pkg.contributes.commands[0].icon = "$(beaker)";
  pkg.contributes.commands.push({ command: "hello.tool.custom", title: "Custom native command" });
  pkg.contributes.views = { explorer: [{ id: "native-view", name: "Native view" }] };
  pkg.scripts.custom = "node custom.js";
  writeFileSync(path, JSON.stringify(pkg));
  const entry = join(project.root, "hosts/vscode/src/extension.ts");
  writeFileSync(entry, `${readFileSync(entry, "utf8")}\nexport const authored = true;\n`);
  expect(check(project.root, surface.plan(project), "0.1.2")).toEqual([]);
  const echo = project.operations[0];
  if (!echo) throw new Error("fixture must contain echo");
  echo.title = "New title";
  apply(project.root, surface.plan(project), "0.1.2");
  const rebuilt = JSON.parse(readFileSync(path, "utf8"));
  expect(rebuilt.contributes.commands).toContainEqual({
    command: "hello-tool.echo",
    title: "New title",
    category: "Hello Tool",
    icon: "$(beaker)",
  });
  expect(rebuilt.contributes.commands).toContainEqual({
    command: "hello.tool.custom",
    title: "Custom native command",
  });
  expect(rebuilt.contributes.commands).not.toContainEqual(
    expect.objectContaining({ command: "hello-tool.native" }),
  );
  expect(rebuilt.contributes.views).toEqual(pkg.contributes.views);
  expect(rebuilt.scripts.custom).toBe("node custom.js");
  expect(readFileSync(entry, "utf8")).toContain("export const authored = true;");
  expect(check(project.root, surface.plan(project), "0.1.2")).toEqual([]);
});

it("packages a VSIX independently of registry credentials and permits each registry to be deselected", () => {
  const project = fixture();
  expect(packageSteps(project).some((step) => step.run.includes("hello-tool-1.0.0.vsix"))).toBe(
    true,
  );
  expect(registries(project).map((row) => row.id)).toEqual(
    expect.arrayContaining(["vscode-marketplace", "open-vsx"]),
  );
  project.tool.vscode = { publisher: "octo", marketplace: false, openvsx: true };
  expect(registries(project).map((row) => row.id)).not.toContain("vscode-marketplace");
  project.tool.binding = "python";
  expect(() => surface.plan(project)).toThrow("requires pypi");
  project.tool.surfaces = ["mcp", "cli", "pypi", "vscode-extension"];
  const runtime = surface.plan(project).find((file) => file.path.endsWith("/generated.ts"));
  expect(runtime?.kind === "file" && runtime.content).toContain('"command":"uvx"');
});
