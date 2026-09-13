import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { coreCopyDrift } from "./openclaw.js";

const roots: string[] = [];
function staged(): string {
  const root = mkdtempSync(join(tmpdir(), "tf-core-copy-"));
  roots.push(root);
  return root;
}
function put(root: string, path: string, content: string): void {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("coreCopyDrift", () => {
  it("skips copies without the MATERIALIZED marker (npm-installed cores)", () => {
    const root = staged();
    put(root, "dist/ops.js", "new");
    put(root, "hosts/openclaw/node_modules/toolfactory/dist/ops.js", "old");
    expect(coreCopyDrift(root)).toEqual([]);
  });

  it("skips when the workspace has no dist yet", () => {
    const root = staged();
    put(root, "hosts/openclaw/node_modules/toolfactory/MATERIALIZED", "");
    expect(coreCopyDrift(root)).toEqual([]);
  });

  it("passes when the materialized copy matches the dist", () => {
    const root = staged();
    put(root, "dist/ops.js", "same");
    put(root, "dist/deep/command.js", "same");
    put(root, "hosts/openclaw/node_modules/toolfactory/MATERIALIZED", "");
    put(root, "hosts/openclaw/node_modules/toolfactory/dist/ops.js", "same");
    put(root, "hosts/openclaw/node_modules/toolfactory/dist/deep/command.js", "same");
    expect(coreCopyDrift(root)).toEqual([]);
  });

  it("flags stale, missing, and extra files in the copy", () => {
    const root = staged();
    put(root, "dist/ops.js", "new");
    put(root, "dist/gone.js", "still here");
    put(root, "hosts/openclaw/node_modules/toolfactory/MATERIALIZED", "");
    put(root, "hosts/openclaw/node_modules/toolfactory/dist/ops.js", "old");
    put(root, "hosts/openclaw/node_modules/toolfactory/dist/extra.js", "leftover");
    const paths = coreCopyDrift(root)
      .map((d) => d.path)
      .sort();
    expect(paths).toEqual([
      "hosts/openclaw/node_modules/toolfactory/dist/extra.js",
      "hosts/openclaw/node_modules/toolfactory/dist/gone.js",
      "hosts/openclaw/node_modules/toolfactory/dist/ops.js",
    ]);
  });
});
