#!/usr/bin/env node
import { Command } from "commander";
import * as commands from "./commands.js";
import { BINDINGS, SURFACE_IDS, type SurfaceId } from "./model.js";
import { TOOLFACTORY_VERSION } from "./project/load.js";

const program = new Command()
  .name("toolfactory")
  .description(
    "Build an agent tool once; ship it as skills, MCP servers, plugins, CLIs, and packages.",
  )
  .version(TOOLFACTORY_VERSION)
  .option("-C, --root <dir>", "project root", ".");

const root = (): string => program.opts<{ root: string }>().root;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

program
  .command("init <name>")
  .description("Create dev.toolfactory/tool.json, the identity file, and the kernel scaffold")
  .requiredOption("-b, --binding <language>", `core language: ${BINDINGS.join(" | ")}`)
  .requiredOption("-s, --surfaces <ids>", `comma-separated surfaces: ${SURFACE_IDS.join(", ")}`)
  .option("-d, --description <text>", "one-line description")
  .option("--license <spdx>", "license identifier", "MIT")
  .option("--repository <url>", "source repository URL")
  .option("--author <name>", "author name")
  .action((name: string, options) => {
    const surfaces = String(options.surfaces)
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean) as SurfaceId[];
    for (const surface of surfaces) {
      if (!(SURFACE_IDS as readonly string[]).includes(surface))
        fail(`Unknown surface "${surface}".`);
    }
    const { written } = commands.init({
      root: root(),
      name,
      binding: options.binding,
      surfaces,
      description: options.description,
      license: options.license,
      repository: options.repository,
      author: options.author,
    });
    for (const path of written) console.log(`created ${path}`);
    console.log(
      "Next: install dependencies, then run `toolfactory introspect` and `toolfactory build`.",
    );
  });

program
  .command("introspect")
  .description(
    "Spawn the kernel MCP server and snapshot its tools/list to dev.toolfactory/ops.json",
  )
  .action(async () => {
    const { path, changed, ops } = await commands.introspect(root());
    console.log(`${changed ? "updated" : "unchanged"} ${path} (${ops.tools.length} operations)`);
  });

program
  .command("build")
  .description("Generate every selected surface in-tree and refresh the lock")
  .action(() => {
    const { result } = commands.build(root());
    for (const path of result.written) console.log(`wrote ${path}`);
    for (const path of result.deleted) console.log(`deleted ${path}`);
    for (const path of result.manual) console.log(`kept ${path} (manual)`);
    console.log(
      `${result.written.length} written, ${result.unchanged.length} unchanged, ${result.deleted.length} deleted.`,
    );
  });

program
  .command("check")
  .description("Fail if any generated file drifted from what build would write")
  .action(() => {
    const { drift } = commands.check(root());
    if (drift.length === 0) {
      console.log("OK: generated files are current.");
      return;
    }
    for (const item of drift) console.error(`${item.kind}: ${item.path}`);
    fail(`${drift.length} file(s) out of date; run \`toolfactory build\`.`);
  });

program
  .command("validate")
  .description("Run each selected surface's own upstream validator")
  .option("--surface <id>", "only this surface")
  .action((options) => {
    const outcomes = commands.validate(root(), options.surface as SurfaceId | undefined);
    let failed = 0;
    for (const outcome of outcomes) {
      console.log(`${outcome.ok ? "ok  " : "FAIL"} ${outcome.label}: ${outcome.command}`);
      if (!outcome.ok) {
        failed += 1;
        if (outcome.output)
          console.log(
            outcome.output
              .split("\n")
              .map((l) => `     ${l}`)
              .join("\n"),
          );
      }
    }
    if (failed) fail(`${failed} validator(s) failed.`);
  });

program
  .command("coverage")
  .description("Print the operation × surface verdict matrix")
  .option("--json", "machine-readable output")
  .action((options) => {
    const coverage = commands.coverage(root());
    if (options.json) {
      console.log(JSON.stringify(coverage, null, 2));
      return;
    }
    console.log(`operation\t${coverage.surfaces.join("\t")}`);
    for (const row of coverage.rows) {
      console.log(
        `${row.operation}\t${coverage.surfaces.map((s) => row.verdicts[s]?.reason ?? row.verdicts[s]?.kind).join("\t")}`,
      );
    }
  });

program
  .command("adopt <path>")
  .description("Stop regenerating a file; it becomes yours (recorded as manual)")
  .action((path: string) => {
    commands.adopt(root(), path);
    console.log(`adopted ${path}`);
  });

program
  .command("unadopt <path>")
  .description("Return an adopted file to toolfactory and regenerate it")
  .action((path: string) => {
    commands.unadopt(root(), path);
    console.log(`regenerated ${path}`);
  });

program
  .command("eject <surface>")
  .description("Adopt every file a surface owns")
  .action((surface: SurfaceId) => {
    for (const path of commands.eject(root(), surface)) console.log(`adopted ${path}`);
  });

program
  .command("doctor")
  .description("Report which upstream CLIs are available to delegate to")
  .action(() => {
    const report = commands.doctor();
    console.log(`toolfactory ${report.toolfactory} on node ${report.node}`);
    for (const [name, version] of Object.entries(report.tools))
      console.log(`${name.padEnd(14)} ${version}`);
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  fail(error instanceof Error ? error.message : String(error));
});
