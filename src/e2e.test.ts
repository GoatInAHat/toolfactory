/**
 * Real end-to-end: init a fresh tool, introspect the real kernel over stdio, build,
 * check for drift, and run the generated CLI as a user would. Skips when this repo's
 * own node_modules isn't around to symlink in (no dependencies to run against).
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
      const init = commands.init({ root: dir, name: "hello", binding: "typescript", surfaces });
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
