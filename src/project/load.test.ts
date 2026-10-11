import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { build } from "../commands.js";
import type { ToolConfig } from "../model.js";
import { HOST_DIR } from "../surfaces/openclaw-native.js";
import { check, setState } from "./apply.js";
import { loadProject } from "./load.js";
import { buildPlan } from "./plan.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function fixture(overrides: Partial<ToolConfig> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "toolfactory-skills-"));
  roots.push(root);
  write(
    root,
    "plugin.json",
    JSON.stringify({ name: "probe", version: "0.1.0", description: "Probe" }),
  );
  write(
    root,
    "dev.toolfactory/tool.json",
    JSON.stringify({
      schemaVersion: 1,
      identity: "plugin.json",
      binding: "typescript",
      surfaces: ["skill", "cli", "openclaw-native"],
      ...overrides,
    }),
  );
  write(
    root,
    "dev.toolfactory/ops.json",
    JSON.stringify({
      tools: [
        {
          name: "echo",
          description: "Current operation",
          inputSchema: { type: "object" },
        },
      ],
    }),
  );
  return root;
}

function hostJson(root: string, name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, HOST_DIR, name), "utf8"));
}

function clean(root: string): void {
  const project = loadProject(root);
  expect(check(root, buildPlan(project), project.toolfactoryVersion)).toEqual([]);
  expect(build(root).result.written).toEqual([]);
}

describe("OpenClaw skill loading and regeneration", () => {
  it.each(["typescript", "python"] as const)(
    "ships a fresh %s tool's own skill by default",
    (binding) => {
      const root = fixture({ binding });
      expect(existsSync(join(root, "skills"))).toBe(false);
      expect(loadProject(root).skills?.map((skill) => skill.name)).toEqual(["probe"]);
      build(root);
      const own = readFileSync(join(root, "skills/probe/SKILL.md"), "utf8");
      expect(readFileSync(join(root, HOST_DIR, "skills/probe/SKILL.md"), "utf8")).toBe(own);
      expect(own).toContain("Current operation");
      expect(hostJson(root, "openclaw.plugin.json").skills).toEqual(["./skills"]);
      expect(hostJson(root, "package.json").files).toContain("skills");
      clean(root);
    },
  );

  it.each([[], ["custom"], ["probe"], ["probe", "custom"]])(
    "honors the exact explicit selection %j",
    (...names) => {
      const skills = names as string[];
      const root = fixture({ openclaw: { skills } });
      write(root, ".agents/skills/custom/SKILL.md", "Custom authored skill\n");
      write(root, ".agents/skills/custom/references/guide.md", "Custom reference\n");
      expect(loadProject(root).skills?.map((skill) => skill.name)).toEqual(skills);
      build(root);
      expect(existsSync(join(root, HOST_DIR, "skills/probe/SKILL.md"))).toBe(
        skills.includes("probe"),
      );
      expect(existsSync(join(root, HOST_DIR, "skills/custom/SKILL.md"))).toBe(
        skills.includes("custom"),
      );
      if (skills.includes("custom")) {
        expect(
          readFileSync(join(root, HOST_DIR, "skills/custom/references/guide.md"), "utf8"),
        ).toBe("Custom reference\n");
      }
      expect(hostJson(root, "openclaw.plugin.json").skills).toEqual(
        skills.length ? ["./skills"] : undefined,
      );
      expect((hostJson(root, "package.json").files as string[]).includes("skills")).toBe(
        skills.length > 0,
      );
      clean(root);
    },
  );

  it("refreshes generated regions in one build while retaining authored prose and text resources", () => {
    const root = fixture({ openclaw: { skills: ["probe"] } });
    build(root);
    const path = "skills/probe/SKILL.md";
    write(
      root,
      path,
      readFileSync(join(root, path), "utf8").replace("# probe", "# probe\n\nAuthored procedure."),
    );
    write(root, "skills/probe/scripts/check.py", "print('retained')\n");
    write(
      root,
      "plugin.json",
      JSON.stringify({ name: "probe", version: "0.2.0", description: "Updated identity" }),
    );
    write(
      root,
      "dev.toolfactory/ops.json",
      JSON.stringify({
        tools: [
          {
            name: "new_operation",
            description: "Updated operation",
            inputSchema: { type: "object" },
          },
        ],
      }),
    );
    build(root);
    const bundled = readFileSync(join(root, HOST_DIR, path), "utf8");
    expect(bundled).toBe(readFileSync(join(root, path), "utf8"));
    expect(bundled).toContain("Authored procedure.");
    expect(bundled).toContain("Updated identity");
    expect(bundled).toContain("Updated operation");
    expect(bundled).not.toContain("Current operation");
    expect(readFileSync(join(root, HOST_DIR, "skills/probe/scripts/check.py"), "utf8")).toBe(
      "print('retained')\n",
    );
    clean(root);
  });

  it("removes the default payload and manifest root when the author opts out", () => {
    const root = fixture();
    build(root);
    const path = join(root, "dev.toolfactory/tool.json");
    writeFileSync(
      path,
      JSON.stringify({ ...JSON.parse(readFileSync(path, "utf8")), openclaw: { skills: [] } }),
    );
    build(root);
    expect(existsSync(join(root, HOST_DIR, "skills/probe/SKILL.md"))).toBe(false);
    expect(existsSync(join(root, "skills/probe/SKILL.md"))).toBe(true);
    expect(hostJson(root, "openclaw.plugin.json")).not.toHaveProperty("skills");
    expect(hostJson(root, "package.json").files).not.toContain("skills");
    clean(root);
  });

  it("packages an adopted own skill verbatim", () => {
    const root = fixture();
    build(root);
    setState(root, "skills/probe/SKILL.md", "manual", loadProject(root).toolfactoryVersion);
    write(root, "skills/probe/SKILL.md", "Fully authored skill without generator markers\n");
    build(root);
    expect(readFileSync(join(root, HOST_DIR, "skills/probe/SKILL.md"), "utf8")).toBe(
      "Fully authored skill without generator markers\n",
    );
    clean(root);
  });

  it("retains an explicitly selected same-name custom canon when its alias was adopted", () => {
    const root = fixture({ openclaw: { skills: ["probe"] } });
    build(root);
    setState(root, ".agents/skills/probe", "manual", loadProject(root).toolfactoryVersion);
    rmSync(join(root, ".agents/skills/probe"));
    write(root, ".agents/skills/probe/SKILL.md", "Custom same-name procedure\n");
    write(root, ".agents/skills/probe/references/guide.md", "Custom same-name reference\n");
    build(root);
    expect(readFileSync(join(root, HOST_DIR, "skills/probe/SKILL.md"), "utf8")).toBe(
      "Custom same-name procedure\n",
    );
    expect(readFileSync(join(root, HOST_DIR, "skills/probe/references/guide.md"), "utf8")).toBe(
      "Custom same-name reference\n",
    );
    expect(readFileSync(join(root, "skills/probe/SKILL.md"), "utf8")).toContain(
      "Current operation",
    );
    expect(readFileSync(join(root, ".agents/skills/probe/SKILL.md"), "utf8")).toBe(
      "Custom same-name procedure\n",
    );
    clean(root);
  });

  it("does not infer a skill for projects without the selected pair and still validates declared custom skills", () => {
    const hostOnly = fixture({ surfaces: ["openclaw-native"] });
    build(hostOnly);
    expect(loadProject(hostOnly).skills).toEqual([]);
    expect(hostJson(hostOnly, "openclaw.plugin.json")).not.toHaveProperty("skills");
    const instructions = fixture({ runtime: "none", surfaces: ["skill", "codex"] });
    build(instructions);
    expect(loadProject(instructions).skills).toEqual([]);
    expect(existsSync(join(instructions, HOST_DIR))).toBe(false);
    expect(readFileSync(join(instructions, "skills/probe/SKILL.md"), "utf8")).not.toContain(
      "## Operations",
    );
    const custom = fixture({ surfaces: ["openclaw-native"], openclaw: { skills: ["custom"] } });
    expect(() => loadProject(custom)).toThrow(/openclaw.skills declares "custom"/);
    write(custom, ".agents/skills/custom/SKILL.md", "Custom only\n");
    build(custom);
    expect(readFileSync(join(custom, HOST_DIR, "skills/custom/SKILL.md"), "utf8")).toBe(
      "Custom only\n",
    );
    clean(hostOnly);
    clean(instructions);
    clean(custom);
  });
});
