import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { MergeFile, PlannedFile, RegionFile } from "../model.js";
import { apply, check, setState } from "./apply.js";

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
