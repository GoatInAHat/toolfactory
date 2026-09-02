/**
 * Agent Skills: one `skills/<N>/SKILL.md` per tool. toolfactory owns the frontmatter and
 * the `<!-- tf:operations -->` block; the body is the author's prose and is never generated.
 */
import { stringify as yaml } from "yaml";
import type { Operation, Project, Surface, Verdict } from "../model.js";
import { compact, has, skillVerdict } from "./shared.js";

export const OPERATIONS_BEGIN = "<!-- tf:operations -->";
export const OPERATIONS_END = "<!-- /tf:operations -->";

export function skillPath(project: Project): string {
  return `skills/${project.identity.name}/SKILL.md`;
}

function invocation(project: Project, operation: Operation): string {
  const name = project.identity.name;
  const lines: string[] = [];
  if (has(project, "cli"))
    lines.push(`\`${name} ${operation.name} --json '<arguments>'\` prints a JSON result.`);
  if (has(project, "mcp") || has(project, "agent-plugins")) {
    lines.push(
      `MCP tool \`${operation.name}\` on server \`${name}\` returns the same result as \`structuredContent\`.`,
    );
  }
  return lines.join(" ");
}

export function renderOperations(project: Project): string {
  const lines = ["", "## Operations", ""];
  if (project.operations.length === 0) {
    lines.push("_No operations yet: run `toolfactory introspect` after adding one to the kernel._");
  }
  for (const operation of project.operations) {
    const verdict: Verdict = skillVerdict(operation);
    if (verdict.kind === "excluded") continue;
    const required = Object.keys(
      (operation.inputSchema.properties as Record<string, unknown> | undefined) ?? {},
    );
    lines.push(`### ${operation.name}`, "");
    if (operation.description) lines.push(operation.description, "");
    if (required.length)
      lines.push(`Arguments: ${required.map((k) => `\`${k}\``).join(", ")}.`, "");
    const how = invocation(project, operation);
    if (how) lines.push(how, "");
    if (verdict.kind === "bridged") {
      lines.push(
        `This operation needs ${operation.requires.join(", ")}: use this host's own tools to obtain it, then pass the result as an argument.`,
        "",
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

export function frontmatter(project: Project): string {
  const document = compact({
    name: project.identity.name,
    description: project.identity.description ?? `Use the ${project.identity.name} tool.`,
    license: project.identity.license,
  });
  return `\n${yaml(document).trimEnd()}\n`;
}

export const surface: Surface = {
  id: "skill",
  plan(project) {
    const path = skillPath(project);
    const regions = [
      { begin: "---", end: "---", content: frontmatter(project) },
      { begin: OPERATIONS_BEGIN, end: OPERATIONS_END, content: renderOperations(project) },
    ];
    const template = [
      "---",
      "---",
      "",
      `# ${project.identity.name}`,
      "",
      "Explain here when an agent should reach for this tool and how to combine its operations.",
      "",
      OPERATIONS_BEGIN,
      OPERATIONS_END,
      "",
    ].join("\n");
    return [{ kind: "region", path, regions, template }];
  },
  validate(project) {
    return [
      {
        label: "agentskills validate",
        command: "uvx",
        args: [
          "--from",
          "skills-ref",
          "agentskills",
          "validate",
          `skills/${project.identity.name}`,
        ],
        cwd: project.root,
      },
    ];
  },
  verdict: skillVerdict,
};
