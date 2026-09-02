/**
 * Real end-to-end: init a fresh tool, introspect the real kernel over stdio, build,
 * check for drift, and run the generated CLI as a user would. Skips when this repo's
 * own node_modules isn't around to symlink in (no dependencies to run against).
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as commands from "./commands.js";
import type { SurfaceId } from "./model.js";

const repoRoot = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const repoNodeModules = join(repoRoot, "node_modules");

describe.skipIf(!existsSync(repoNodeModules))(
  "end-to-end: init -> introspect -> build -> check -> run",
  () => {
    it("scaffolds a real tool, snapshots its kernel, builds clean, and answers a real CLI call", {
      timeout: 120_000,
    }, async () => {
      const dir = mkdtempSync(join(tmpdir(), "toolfactory-e2e-"));
      symlinkSync(repoNodeModules, join(dir, "node_modules"), "dir");

      const surfaces: SurfaceId[] = ["skill", "agent-plugins", "claude", "mcp", "cli", "npm"];
      const init = commands.init({
        root: dir,
        name: "hello",
        binding: "typescript",
        surfaces,
        setup: false,
      });
      expect(init.written).toContain("dev.toolfactory/tool.json");
      expect(init.written).toContain("src/ops.ts");

      const snapshot = await commands.introspect(dir);
      expect(snapshot.ops.tools.map((t) => t.name)).toEqual(["echo"]);
      const echo = snapshot.ops.tools[0] as {
        inputSchema: { $schema?: string };
        outputSchema?: { $schema?: string };
      };
      expect(echo.inputSchema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
      expect(echo.outputSchema?.$schema).toBe("https://json-schema.org/draft/2020-12/schema");

      commands.build(dir);
      await expect(commands.check(dir)).resolves.toBeDefined();

      const opsOnDisk = JSON.parse(readFileSync(join(dir, "dev.toolfactory/ops.json"), "utf8"));
      expect(opsOnDisk.tools.map((t: { name: string }) => t.name)).toEqual(["echo"]);

      const output = execFileSync(
        process.execPath,
        ["--import", "tsx", "src/toolfactory/cli.ts", "echo", "--text", "hi"],
        { cwd: dir, encoding: "utf8" },
      );
      expect(JSON.parse(output)).toEqual({ text: "hi" });
    });
  },
);

/** Every file in the tree except the test's own scaffolding, as path → content (a link's target). */
function tree(root: string, dir = root): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(files, tree(root, path));
    else if (entry.isSymbolicLink()) files[relative(root, path)] = readlinkSync(path);
    else files[relative(root, path)] = readFileSync(path, "utf8");
  }
  return files;
}

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "toolfactory-confluence-"));
  symlinkSync(repoNodeModules, join(dir, "node_modules"), "dir");
  return dir;
}

/** The one thing a projector may never write: a paragraph, in the body a region file leaves alone. */
const PROSE_ANCHOR = "Explain here when an agent should reach for this tool";
const PROSE = "Reach for it when a demo needs a real tool, not a mock.";

function authorProse(root: string): void {
  const path = join(root, "skills/hello/SKILL.md");
  const text = readFileSync(path, "utf8");
  writeFileSync(path, text.replace(PROSE_ANCHOR, `${PROSE}\n\n${PROSE_ANCHOR}`));
}

function setSurfaces(root: string, surfaces: SurfaceId[]): void {
  const path = join(root, "dev.toolfactory/tool.json");
  writeFileSync(
    path,
    `${JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), surfaces }, null, 2)}\n`,
  );
}

/**
 * Confluence: a tool that got where it is by editing, toggling and adopting is byte-identical to
 * one generated from its `tool.json` in a single step. Every generated file therefore carries its
 * own inverse — an orphan its deletion, a merge file the keys the lock records — and the drift
 * gate is complete: a clean `check` means the tree is exactly what a fresh build would write.
 */
describe.skipIf(!existsSync(repoNodeModules))(
  "confluence: a walked tree equals a fresh one",
  () => {
    it("converges on the same tree as init + build of the final tool.json", {
      timeout: 180_000,
    }, async () => {
      const identity = {
        name: "hello",
        binding: "typescript",
        repository: "https://github.com/toolfactory/hello",
      } as const;
      const start: SurfaceId[] = ["skill", "cli", "npm", "mcp-registry"];
      const end: SurfaceId[] = ["skill", "cli", "npm"];

      const walked = scratch();
      commands.init({ ...identity, root: walked, surfaces: start, setup: false });
      await commands.introspect(walked);
      setSurfaces(walked, end);
      commands.build(walked);

      // The region inverse: deselecting `skill` empties its regions instead of deleting the file
      // the author writes prose in, and re-selecting refills the markers the strip preserved.
      authorProse(walked);
      setSurfaces(
        walked,
        end.filter((id) => id !== "skill"),
      );
      expect(commands.build(walked).result.stripped).toEqual(["skills/hello/SKILL.md"]);
      const husk = readFileSync(join(walked, "skills/hello/SKILL.md"), "utf8");
      expect(husk).toContain(PROSE);
      expect(husk).toContain("<!-- tf:operations --><!-- /tf:operations -->");
      expect(husk).not.toContain("## Operations");
      expect(
        lstatSync(join(walked, ".agents/skills/hello"), { throwIfNoEntry: false }),
      ).toBeUndefined();
      await expect(commands.check(walked)).resolves.toBeDefined();
      setSurfaces(walked, end);
      commands.build(walked);

      commands.adopt(walked, "COVERAGE.md");
      writeFileSync(join(walked, "COVERAGE.md"), "hand-written while adopted\n");
      commands.build(walked);
      commands.unadopt(walked, "COVERAGE.md");
      commands.build(walked);

      const fresh = scratch();
      commands.init({ ...identity, root: fresh, surfaces: end, setup: false });
      await commands.introspect(fresh);
      authorProse(fresh);
      commands.build(fresh);

      expect(tree(walked)).toEqual(tree(fresh));
    });
  },
);
