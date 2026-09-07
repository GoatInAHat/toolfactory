/** Exercise generated artifacts with a dependency-installed GSD source checkout, without a model. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build, check, init, introspect } from "../src/commands.ts";

assert.ok(process.argv[2], "Usage: node --import tsx scripts/check-gsd.mjs <gsd-pi-checkout>");
const gsd = resolve(process.argv[2]);
const repo = fileURLToPath(new URL("..", import.meta.url));
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "toolfactory-gsd-")));
const originalCwd = process.cwd();
const originalGsdHome = process.env.GSD_HOME;
const originalSubagent = process.env.GSD_SUBAGENT_CHILD;
const project = join(scratch, "project");
const name = "toolfactory-gsd-probe";
process.env.GSD_HOME = join(scratch, "gsd");
delete process.env.GSD_SUBAGENT_CHILD;

const upstream = (path) => import(pathToFileURL(join(gsd, path)).href);
let mcp;
try {
  const { DefaultResourceLoader } = await upstream(
    "packages/pi-coding-agent/src/core/resource-loader.ts",
  );
  mcp = await upstream("src/resources/extensions/mcp-client/index.ts");

  init({ root: project, name, binding: "typescript", setup: false, git: false });
  // Reuse the generator's SDKs; the fixture never downloads or publishes a package.
  symlinkSync(join(repo, "node_modules"), join(project, "node_modules"), "dir");
  await introspect(project);
  build(project);
  execFileSync("git", ["init", "-q", project]);
  execFileSync("python3", [".agents/sync.py", "--all"], { cwd: project, stdio: "pipe" });
  await check(project);

  const loaderOptions = {
    cwd: project,
    agentDir: join(scratch, "agent"),
    noExtensions: true,
    noPromptTemplates: true,
    noThemes: true,
  };
  const loader = new DefaultResourceLoader(loaderOptions);
  await loader.reload();
  const skills = loader.getSkills().skills.filter((skill) => skill.name === name);
  assert.equal(skills.length, 1, "GSD must discover and deduplicate the generated skill symlinks");
  assert.equal(realpathSync(skills[0].filePath), join(project, "skills", name, "SKILL.md"));
  assert.ok(
    loader.getAgentsFiles().agentsFiles.some((file) => file.path === join(project, "AGENTS.md")),
  );

  const bare = new DefaultResourceLoader({
    ...loaderOptions,
    noSkills: true,
    noContextFiles: true,
  });
  await bare.reload();
  assert.equal(bare.getSkills().skills.length, 0);
  assert.equal(bare.getAgentsFiles().agentsFiles.length, 0);

  process.chdir(project);
  const tools = new Map();
  mcp.default({
    on() {},
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
  });
  const invoke = (tool, args, ctx = { hasUI: false }) =>
    tools.get(tool).execute("toolfactory-gsd-smoke", args, undefined, undefined, ctx);
  const servers = await invoke("mcp_servers", { refresh: true });
  assert.ok(servers.content.some((item) => item.text?.includes(name)));
  // Respect GSD's trust contract. Only the disposable generated echo server is approved.
  await assert.rejects(invoke("mcp_discover", { server: name }), /Trust required/);
  let approvals = 0;
  const discovered = await invoke(
    "mcp_discover",
    { server: name },
    {
      hasUI: true,
      ui: {
        confirm: async (title) => {
          assert.ok(title.includes(name));
          approvals++;
          return true;
        },
      },
    },
  );
  assert.equal(approvals, 1);
  assert.equal(discovered.details.toolCount, 1);
  assert.ok(discovered.content.some((item) => item.text?.includes("echo")));
  await mcp._resetMcpClientStateForTest();

  // A subsequent unattended process may use the persisted trust in this temporary GSD_HOME.
  process.env.GSD_SUBAGENT_CHILD = "1";
  const args = { text: "ToolFactory through GSD" };
  const called = await invoke("mcp_call", { server: name, tool: "echo", args });
  assert.deepEqual(JSON.parse(called.content[0].text), args);
  const cli = execFileSync(
    process.execPath,
    ["--import", "tsx", "src/toolfactory/cli.ts", "echo", "--json", JSON.stringify(args)],
    { cwd: project, encoding: "utf8" },
  );
  assert.deepEqual(JSON.parse(cli), args);
  console.log(
    JSON.stringify(
      {
        gsdCommit: execFileSync("git", ["-C", gsd, "rev-parse", "HEAD"], {
          encoding: "utf8",
        }).trim(),
        passed: [
          "generated-file drift",
          "skill discovery and deduplication",
          "AGENTS.md discovery",
          "bare-mode exclusion",
          "shared MCP config discovery",
          "untrusted headless rejection",
          "interactive discovery",
          "trusted unattended MCP call",
          "CLI result parity",
        ],
        modelCalls: 0,
      },
      null,
      2,
    ),
  );
} finally {
  await mcp?._resetMcpClientStateForTest();
  process.chdir(originalCwd);
  if (originalGsdHome === undefined) delete process.env.GSD_HOME;
  else process.env.GSD_HOME = originalGsdHome;
  if (originalSubagent === undefined) delete process.env.GSD_SUBAGENT_CHILD;
  else process.env.GSD_SUBAGENT_CHILD = originalSubagent;
  rmSync(scratch, { recursive: true, force: true });
}
