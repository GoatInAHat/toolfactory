import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { MergeFile, PlannedFile, Project, RegionFile } from "../model.js";
import { apply, check, setState } from "./apply.js";
import { buildPlan } from "./plan.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "tf-apply-"));
}

function regionPlan(content: string): RegionFile {
  return {
    kind: "region",
    path: "SKILL.md",
    regions: [{ begin: "<!-- tf:ops -->", end: "<!-- /tf:ops -->", content }],
    template: ["# Title", "", "Author prose.", "", "<!-- tf:ops -->", "<!-- /tf:ops -->", ""].join(
      "\n",
    ),
  };
}

describe("apply / check — full files", () => {
  it("applies a plan and check then reports it clean", () => {
    const root = tmp();
    const plan: PlannedFile[] = [{ kind: "file", path: "README.md", content: "hello\n" }];
    const result = apply(root, plan, "0.1.0");
    expect(result.written).toEqual(["README.md"]);
    expect(readFileSync(join(root, "README.md"), "utf8")).toBe("hello\n");
    expect(check(root, plan, "0.1.0")).toEqual([]);
  });

  it("reports a hand-edited generated file as changed", () => {
    const root = tmp();
    const plan: PlannedFile[] = [{ kind: "file", path: "README.md", content: "hello\n" }];
    apply(root, plan, "0.1.0");
    writeFileSync(join(root, "README.md"), "tampered\n");
    expect(check(root, plan, "0.1.0")).toEqual([{ path: "README.md", kind: "changed" }]);
  });

  it("a manual file is skipped by both drift and rewriting", () => {
    const root = tmp();
    const planA: PlannedFile[] = [{ kind: "file", path: "README.md", content: "hello\n" }];
    apply(root, planA, "0.1.0");
    setState(root, "README.md", "manual", "0.1.0");
    writeFileSync(join(root, "README.md"), "author-owned\n");

    const planB: PlannedFile[] = [{ kind: "file", path: "README.md", content: "regenerated\n" }];
    expect(check(root, planB, "0.1.0")).toEqual([]);
    const result = apply(root, planB, "0.1.0");
    expect(result.manual).toEqual(["README.md"]);
    expect(readFileSync(join(root, "README.md"), "utf8")).toBe("author-owned\n");
  });

  it("reports an orphaned generated file via check and removes it on apply", () => {
    const root = tmp();
    const planA: PlannedFile[] = [
      { kind: "file", path: "a.txt", content: "a\n" },
      { kind: "file", path: "b.txt", content: "b\n" },
    ];
    apply(root, planA, "0.1.0");
    const planB: PlannedFile[] = [{ kind: "file", path: "b.txt", content: "b\n" }];
    expect(check(root, planB, "0.1.0")).toEqual([{ path: "a.txt", kind: "orphan" }]);
    const result = apply(root, planB, "0.1.0");
    expect(result.deleted).toEqual(["a.txt"]);
    expect(existsSync(join(root, "a.txt"))).toBe(false);
  });

  it("writes a symbolic link, restores one a real file replaced, and unlinks it as an orphan", () => {
    const root = tmp();
    mkdirSync(join(root, "skills/hello"), { recursive: true });
    writeFileSync(join(root, "skills/hello/SKILL.md"), "---\n---\n");
    const link: PlannedFile = {
      kind: "file",
      path: ".agents/skills/hello",
      content: "../../skills/hello",
      symlink: true,
    };
    apply(root, [link], "0.1.0");
    expect(readlinkSync(join(root, ".agents/skills/hello"))).toBe("../../skills/hello");
    expect(check(root, [link], "0.1.0")).toEqual([]);

    rmSync(join(root, ".agents/skills/hello"));
    writeFileSync(join(root, ".agents/skills/hello"), "not a link\n");
    expect(check(root, [link], "0.1.0")).toEqual([
      { path: ".agents/skills/hello", kind: "changed" },
    ]);
    apply(root, [link], "0.1.0");
    expect(lstatSync(join(root, ".agents/skills/hello")).isSymbolicLink()).toBe(true);

    expect(apply(root, [], "0.1.0").deleted).toEqual([".agents/skills/hello"]);
    expect(existsSync(join(root, ".agents/skills/hello"))).toBe(false);
    expect(existsSync(join(root, "skills/hello/SKILL.md"))).toBe(true);

    // lstat, not stat: with its target gone the link is dangling — still present, still ours.
    apply(root, [link], "0.1.0");
    rmSync(join(root, "skills"), { recursive: true });
    expect(check(root, [], "0.1.0")).toEqual([{ path: ".agents/skills/hello", kind: "orphan" }]);
    expect(apply(root, [], "0.1.0").deleted).toEqual([".agents/skills/hello"]);
    expect(
      lstatSync(join(root, ".agents/skills/hello"), { throwIfNoEntry: false }),
    ).toBeUndefined();
  });
});

describe("apply / check — region files", () => {
  it("writes the template with the region filled when the file is absent", () => {
    const root = tmp();
    apply(root, [regionPlan("- op-a\n")], "0.1.0");
    const text = readFileSync(join(root, "SKILL.md"), "utf8");
    expect(text).toContain("Author prose.");
    expect(text).toContain("- op-a\n");
  });

  it("preserves the author's body outside the markers when the region is rebuilt", () => {
    const root = tmp();
    apply(root, [regionPlan("- op-a\n")], "0.1.0");
    const path = join(root, "SKILL.md");
    writeFileSync(
      path,
      readFileSync(path, "utf8").replace(
        "Author prose.",
        "Author prose.\n\nMore notes the author wrote by hand.",
      ),
    );
    apply(root, [regionPlan("- op-a\n- op-b\n")], "0.1.0");
    const text = readFileSync(path, "utf8");
    expect(text).toContain("More notes the author wrote by hand.");
    expect(text).toContain("- op-b\n");
  });

  it("a region file toolfactory stops writing loses its regions, not its existence", () => {
    const root = tmp();
    apply(root, [regionPlan("- op-a\n")], "0.1.0");
    const path = join(root, "SKILL.md");
    const authored = readFileSync(path, "utf8").replace(
      "Author prose.",
      "Author prose.\n\nA paragraph only the author can write.",
    );
    writeFileSync(path, authored);
    expect(check(root, [], "0.1.0")).toEqual([{ path: "SKILL.md", kind: "orphan" }]);

    const result = apply(root, [], "0.1.0");
    expect(result).toMatchObject({ stripped: ["SKILL.md"], deleted: [] });
    const emptied = readFileSync(path, "utf8");
    expect(emptied).toContain("A paragraph only the author can write.");
    expect(emptied).toContain("<!-- tf:ops --><!-- /tf:ops -->");
    expect(emptied).not.toContain("- op-a");
    // Silent once emptied: nothing of toolfactory's is stranded in the file any more.
    expect(check(root, [], "0.1.0")).toEqual([]);

    // Re-selection needs no code of its own: the preserved markers are refilled in place.
    apply(root, [regionPlan("- op-a\n")], "0.1.0");
    expect(readFileSync(path, "utf8")).toBe(authored);
  });

  it("empties the region a surface stopped owning while another surface keeps the file", () => {
    const root = tmp();
    const install = { begin: "<!-- tf:install -->", end: "<!-- /tf:install -->" };
    const mcpName = { begin: "<!-- tf:mcp-name -->", end: "<!-- /tf:mcp-name -->" };
    const plan = (registry: boolean): RegionFile[] => [
      {
        kind: "region",
        path: "README.md",
        regions: [
          { ...install, content: "\n`npx -y hello mcp`\n" },
          ...(registry
            ? [{ ...mcpName, content: "\n<!-- mcp-name: io.github.o/hello -->\n" }]
            : []),
        ],
        template: [
          "# hello",
          "",
          install.begin,
          install.end,
          "",
          mcpName.begin,
          mcpName.end,
          "",
        ].join("\n"),
      },
    ];
    apply(root, plan(true), "0.1.0");
    expect(check(root, plan(false), "0.1.0")).toEqual([{ path: "README.md", kind: "changed" }]);
    apply(root, plan(false), "0.1.0");
    const text = readFileSync(join(root, "README.md"), "utf8");
    expect(text).not.toContain("mcp-name: io.github.o/hello");
    expect(text).toContain("<!-- tf:mcp-name --><!-- /tf:mcp-name -->");
    expect(text).toContain("`npx -y hello mcp`");
    expect(check(root, plan(false), "0.1.0")).toEqual([]);
  });

  it("check reports a missing region marker as unmarked", () => {
    const root = tmp();
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "SKILL.md"), "# Title\n\nNo markers in this file at all.\n");
    expect(check(root, [regionPlan("- op-a\n")], "0.1.0")).toEqual([
      { path: "SKILL.md", kind: "unmarked" },
    ]);
  });
});

describe("apply / check — merge files", () => {
  it("merges a JSON patch, keeping keys it does not own", () => {
    const root = tmp();
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ name: "old", scripts: { test: "vitest" } }, null, 2),
    );
    const plan: MergeFile[] = [
      {
        kind: "merge",
        path: "package.json",
        format: "json",
        patch: { name: "hello", version: "0.1.0" },
      },
    ];
    apply(root, plan, "0.1.0");
    const document = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(document).toEqual({ name: "hello", scripts: { test: "vitest" }, version: "0.1.0" });
    expect(check(root, plan, "0.1.0")).toEqual([]);
  });

  it("replaces an owned object whole, so a renamed key does not leave its old name behind", () => {
    const root = tmp();
    mkdirSync(root, { recursive: true });
    const bin = (name: string): MergeFile[] => [
      {
        kind: "merge",
        path: "package.json",
        format: "json",
        patch: { name, bin: { [name]: "./dist/cli.js" } },
        owned: ["bin"],
      },
    ];
    apply(root, bin("hello"), "0.1.0");
    apply(root, bin("renamed"), "0.1.0");
    const document = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(document.bin).toEqual({ renamed: "./dist/cli.js" });
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ ...document, bin: { ...document.bin, stale: "./x" } }),
    );
    expect(check(root, bin("renamed"), "0.1.0")).toEqual([
      { path: "package.json", kind: "changed" },
    ]);
  });

  it("round-trips a TOML patch, merging into and preserving existing content", () => {
    const root = tmp();
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, "pyproject.toml"),
      '[project]\nname = "old"\ndependencies = ["zod"]\n',
    );
    const plan: MergeFile[] = [
      {
        kind: "merge",
        path: "pyproject.toml",
        format: "toml",
        patch: { project: { name: "hello", version: "0.1.0" } },
      },
    ];
    apply(root, plan, "0.1.0");
    const text = readFileSync(join(root, "pyproject.toml"), "utf8");
    expect(text).toContain('name = "hello"');
    expect(text).toContain('version = "0.1.0"');
    expect(text).toContain('dependencies = [ "zod" ]');
    expect(check(root, plan, "0.1.0")).toEqual([]);
  });
});

describe("apply / check — inverses and outputs", () => {
  it("uninstalls the keys a patch stops writing, keeping every other key", () => {
    const root = tmp();
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ scripts: { test: "vitest" } }, null, 2),
    );
    const plan = (registry: boolean): MergeFile[] => [
      {
        kind: "merge",
        path: "package.json",
        format: "json",
        patch: {
          name: "hello",
          ...(registry
            ? { scripts: { smoke: "node smoke.js" }, mcpName: "io.github.o/hello", tf: { mark: 1 } }
            : {}),
        },
      },
    ];
    apply(root, plan(true), "0.1.0");
    expect(check(root, plan(false), "0.1.0")).toEqual([{ path: "package.json", kind: "changed" }]);
    apply(root, plan(false), "0.1.0");
    expect(JSON.parse(readFileSync(join(root, "package.json"), "utf8"))).toEqual({
      name: "hello",
      scripts: { test: "vitest" },
    });
    expect(check(root, plan(false), "0.1.0")).toEqual([]);
  });

  it("a merge file toolfactory stops writing loses its keys, not its existence", () => {
    const root = tmp();
    mkdirSync(root, { recursive: true });
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ scripts: { test: "vitest" } }, null, 2),
    );
    const plan: MergeFile[] = [
      { kind: "merge", path: "package.json", format: "json", patch: { name: "hello" } },
    ];
    apply(root, plan, "0.1.0");
    expect(check(root, [], "0.1.0")).toEqual([{ path: "package.json", kind: "orphan" }]);
    expect(apply(root, [], "0.1.0").deleted).toEqual([]);
    expect(JSON.parse(readFileSync(join(root, "package.json"), "utf8"))).toEqual({
      scripts: { test: "vitest" },
    });
  });

  it("an output file is drift only when it is present and stale", () => {
    const root = tmp();
    const path = "dev.toolfactory/coverage.json";
    const plan: PlannedFile[] = [{ kind: "file", path, content: "{}\n", output: true }];
    apply(root, plan, "0.1.0");
    rmSync(join(root, path));
    expect(check(root, plan, "0.1.0")).toEqual([]);
    writeFileSync(join(root, path), "stale\n");
    expect(check(root, plan, "0.1.0")).toEqual([{ path, kind: "changed" }]);
  });

  it("refuses a selection that omits a surface another one declares it requires", () => {
    const project = { root: tmp(), tool: { surfaces: ["cli", "web"] } } as unknown as Project;
    expect(() => buildPlan(project)).toThrow(/Surface "web" requires surface "mcp"/);
  });
});
