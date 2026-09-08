/** Real editor smoke: native activation/contributions survive rebuild and call the checkout's MCP. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { getBinding } from "../src/bindings/index.ts";
import { ToolConfigSchema } from "../src/model.ts";
import { apply, check } from "../src/project/apply.ts";
import { surface } from "../src/surfaces/vscode-extension.ts";

// macOS's default temp path can exceed the editor's Unix-domain socket length limit.
const root = mkdtempSync(join(process.platform === "darwin" ? "/tmp" : tmpdir(), "tf-vsc-"));
const project = {
  root,
  tool: ToolConfigSchema.parse({
    schemaVersion: 1,
    identity: "package.json",
    binding: "typescript",
    surfaces: ["mcp", "cli", "npm", "vscode-extension"],
    vscode: { publisher: "toolfactory" },
    tests: { examples: { echo: { text: "editor-smoke" } } },
  }),
  identity: {
    name: "tf-vscode-probe",
    version: "0.1.0",
    license: "MIT",
    description: "Extension integration fixture",
    repository: "https://github.com/GoatInAHat/toolfactory",
  },
  identityExtra: {},
  operations: [
    {
      name: "echo",
      description: "Return text",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      requires: [],
    },
  ],
  toolfactoryVersion: "0.1.2",
};
const run = (command, args, cwd = root) =>
  execFileSync(command, args, { cwd, stdio: "inherit", env: process.env });
try {
  for (const file of getBinding("typescript").scaffold(project)) {
    assert.equal(file.kind, "file");
    mkdirSync(dirname(join(root, file.path)), { recursive: true });
    writeFileSync(join(root, file.path), file.content);
  }
  const plan = () => [
    ...getBinding("typescript").kernel(project),
    ...getBinding("typescript").cli(project),
    ...surface.plan(project),
  ];
  apply(root, plan(), "0.1.2");
  const host = join(root, "hosts/vscode");
  const packagePath = join(host, "package.json");
  const pkg = JSON.parse(readFileSync(packagePath, "utf8"));
  pkg.contributes.commands.push({ command: "tf-vscode-probe.native", title: "Native command" });
  writeFileSync(packagePath, JSON.stringify(pkg));
  const entryPath = join(host, "src/extension.ts");
  writeFileSync(
    entryPath,
    readFileSync(entryPath, "utf8").replace(
      "registerGenerated(context);",
      "registerGenerated(context);\n  context.subscriptions.push(vscode.commands.registerCommand('tf-vscode-probe.native', () => 'native-ok'));",
    ),
  );
  writeFileSync(
    join(host, "src/test/native.test.ts"),
    `import * as assert from 'node:assert/strict';
import * as vscode from 'vscode';
suite('Native extension freedom', () => { test('native command and generated MCP operation execute', async () => {
  await vscode.extensions.getExtension('toolfactory.tf-vscode-probe')!.activate();
  assert.equal(await vscode.commands.executeCommand('tf-vscode-probe.native'), 'native-ok');
  assert.deepEqual(await vscode.commands.executeCommand('tf-vscode-probe.echo', {text:'editor-smoke'}), {text:'editor-smoke'});
}); });\n`,
  );
  apply(root, plan(), "0.1.2");
  assert.deepEqual(check(root, plan(), "0.1.2"), []);
  // Node 22 bundles npm 10, whose peer resolver crashes on Vitest's optional peers.
  // Use the same npm CLI on both CI Node versions without changing the fixture's dependencies.
  run("npx", ["--yes", "npm@11.12.0", "install"]);
  run("npx", ["--yes", "npm@11.12.0", "install"], host);
  run("npm", ["run", "vsix"], host);
  if (process.platform === "linux") run("xvfb-run", ["-a", "npm", "test"], host);
  else run("npm", ["test"], host);
  console.log("VS Code native activation, MCP invocation, and VSIX packaging passed.");
} finally {
  rmSync(root, { recursive: true, force: true });
}
