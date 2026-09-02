/**
 * Web UI: one static `web/index.html`. RJSF (from a CDN, no build step) renders one form
 * per operation from an inline snapshot of `dev.toolfactory/ops.json`, so the page also
 * works opened straight from `file://`. Submitting a form previews the equivalent CLI
 * invocation and MCP `tools/call` request, and — if an endpoint is filled in — POSTs that
 * request to a streamable-HTTP MCP server with the 2026-07-28 per-request `_meta` fields
 * (there is no handshake in that revision: protocol version, capabilities and client
 * identity travel on every request instead).
 */
import type { Operation, Project, Surface } from "../model.js";
import { has, mcpVerdict } from "./shared.js";

export const WEB_PATH = "web/index.html";

/** Pinned so the React copy RJSF's CDN bundle imports internally is the exact same module
 * the page's own script imports — jsDelivr's `+esm` output is a Rollup bundle that re-exposes
 * its dependencies as absolute `/npm/<pkg>@<version>/+esm` imports, and ES modules dedupe by
 * resolved URL, so matching the version here is what keeps this page to a single React copy
 * (two copies would break RJSF's hooks with "Invalid hook call"). Bump together if either
 * library's CDN bundle starts resolving a different internal React version. */
const REACT_VERSION = "19.2.8";
const RJSF_VERSION = "6.8.0";
const MCP_PROTOCOL_VERSION = "2026-07-28";
const DEFAULT_ENDPOINT = "http://localhost:3000/mcp";

interface OpView {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}
interface ExcludedView {
  name: string;
  reason?: string;
}

function partitionOperations(operations: Operation[]): {
  included: OpView[];
  excluded: ExcludedView[];
} {
  const included: OpView[] = [];
  const excluded: ExcludedView[] = [];
  for (const operation of operations) {
    const verdict = mcpVerdict(operation);
    if (verdict.kind === "excluded") {
      excluded.push({ name: operation.name, reason: verdict.reason });
    } else {
      included.push({
        name: operation.name,
        description: operation.description,
        inputSchema: operation.inputSchema,
      });
    }
  }
  return { included, excluded };
}

/** JSON for an inline `<script type="application/json">`: escape `<` so no embedded string
 * (a description, an example) can close the tag early. `JSON.parse` reads `<` back as `<`. */
function embed(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function css(): string {
  return `
    :root {
      color-scheme: light dark;
      --bg: #ffffff; --fg: #1a1a1a; --muted: #6b6b6b; --border: #d8d8d8;
      --accent: #2f6fed; --accent-fg: #ffffff; --panel: #f7f7f8; --error: #b3261e;
    }
    @media (prefers-color-scheme: dark) {
      :root { --bg: #16171a; --fg: #e8e8ea; --muted: #9a9ba1; --border: #34353a; --panel: #202126; }
    }
    * { box-sizing: border-box; }
    body {
      margin: 0; background: var(--bg); color: var(--fg);
      font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    header { padding: 20px 24px; border-bottom: 1px solid var(--border); }
    header h1 { margin: 0 0 4px; font-size: 20px; }
    header p.desc { margin: 0 0 12px; color: var(--muted); }
    label.endpoint { display: flex; gap: 8px; align-items: center; font-size: 13px; color: var(--muted); }
    label.endpoint input {
      flex: 1; max-width: 420px; padding: 6px 8px; border: 1px solid var(--border);
      border-radius: 6px; background: var(--bg); color: var(--fg); font: inherit;
    }
    .layout { display: flex; min-height: calc(100vh - 96px); }
    nav { width: 200px; border-right: 1px solid var(--border); padding: 12px; flex-shrink: 0; }
    nav button {
      display: block; width: 100%; text-align: left; padding: 8px 10px; margin-bottom: 4px;
      border: none; border-radius: 6px; background: none; color: var(--fg); font: inherit;
      cursor: pointer;
    }
    nav button:hover { background: var(--panel); }
    nav button.active { background: var(--accent); color: var(--accent-fg); }
    main { flex: 1; padding: 20px 24px; max-width: 720px; }
    .op-desc { color: var(--muted); margin-top: 0; }
    fieldset { border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; margin: 0 0 12px; }
    .rjsf label { font-weight: 600; display: block; margin-bottom: 4px; }
    .rjsf input, .rjsf select, .rjsf textarea {
      width: 100%; padding: 6px 8px; border: 1px solid var(--border); border-radius: 6px;
      background: var(--bg); color: var(--fg); font: inherit; margin-bottom: 10px;
    }
    .rjsf .field-description { color: var(--muted); font-size: 12px; margin: -6px 0 8px; }
    button[type="submit"] {
      padding: 8px 16px; border: none; border-radius: 6px; background: var(--accent);
      color: var(--accent-fg); font: inherit; font-weight: 600; cursor: pointer;
    }
    .preview { margin-top: 20px; }
    .preview h4 { margin: 16px 0 6px; font-size: 12px; text-transform: uppercase; color: var(--muted); }
    .preview pre {
      background: var(--panel); border: 1px solid var(--border); border-radius: 6px;
      padding: 10px 12px; overflow-x: auto; margin: 0; white-space: pre-wrap; word-break: break-word;
    }
    .preview pre.error { color: var(--error); border-color: var(--error); }
    footer { padding: 16px 24px; border-top: 1px solid var(--border); color: var(--muted); font-size: 12px; }
  `.trim();
}

function clientScript(): string {
  const lines = [
    `import React from "https://cdn.jsdelivr.net/npm/react@${REACT_VERSION}/+esm";`,
    `import { createRoot } from "https://cdn.jsdelivr.net/npm/react-dom@${REACT_VERSION}/client/+esm";`,
    `import Form from "https://cdn.jsdelivr.net/npm/@rjsf/core@${RJSF_VERSION}/+esm";`,
    `import validator from "https://cdn.jsdelivr.net/npm/@rjsf/validator-ajv8@${RJSF_VERSION}/+esm";`,
    "",
    "const h = React.createElement;",
    'const DATA = JSON.parse(document.getElementById("tf-data").textContent);',
    "const PROTOCOL_VERSION = DATA.mcpProtocolVersion;",
    "",
    "function stripSchemaDialect(schema) {",
    "  // The embedded schemas declare $schema: .../2020-12/schema for MCP's own dialect check;",
    "  // RJSF's ajv8 validator only needs the keywords, not that URI, so drop it before handing",
    "  // the schema to <Form>.",
    "  const { $schema, ...rest } = schema || {};",
    "  return rest;",
    "}",
    "",
    "function cliCommand(tool, op, args) {",
    '  return tool.name + " " + op.name + " --json \'" + JSON.stringify(args) + "\'";',
    "}",
    "",
    "function mcpCallRequest(op, args, toolVersion) {",
    "  return {",
    '    jsonrpc: "2.0",',
    "    id: Date.now(),",
    '    method: "tools/call",',
    "    params: {",
    "      name: op.name,",
    "      arguments: args,",
    "      _meta: {",
    '        "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,',
    '        "io.modelcontextprotocol/clientCapabilities": {},',
    '        "io.modelcontextprotocol/clientInfo": { name: "toolfactory-web", version: toolVersion || "0.0.0" },',
    "      },",
    "    },",
    "  };",
    "}",
    "",
    "// A 2026-07-28 streamable-HTTP response is plain JSON for a single request/response call",
    "// like tools/call; tolerate an SSE-framed `data: {...}` body too, in case the endpoint",
    "// still streams.",
    "async function callEndpoint(endpoint, request) {",
    "  const response = await fetch(endpoint, {",
    '    method: "POST",',
    "    headers: {",
    '      "Content-Type": "application/json",',
    '      Accept: "application/json, text/event-stream",',
    '      "MCP-Protocol-Version": PROTOCOL_VERSION,',
    "    },",
    "    body: JSON.stringify(request),",
    "  });",
    "  const text = await response.text();",
    '  const dataLine = text.split("\\n").find((line) => line.startsWith("data:"));',
    "  let body;",
    "  try {",
    "    body = JSON.parse(dataLine ? dataLine.slice(5).trim() : text);",
    "  } catch {",
    '    throw new Error("HTTP " + response.status + ": " + text.slice(0, 500));',
    "  }",
    "  if (!response.ok) {",
    '    throw new Error("HTTP " + response.status + ": " + JSON.stringify(body));',
    "  }",
    "  if (body.error) throw new Error(JSON.stringify(body.error));",
    "  return body.result;",
    "}",
    "",
    "function OperationPanel({ tool, op, endpointRef }) {",
    "  const [outcome, setOutcome] = React.useState(null);",
    "  const [busy, setBusy] = React.useState(false);",
    "  const schema = stripSchemaDialect(op.inputSchema);",
    "  return h(",
    '    "div",',
    '    { className: "panel", key: op.name },',
    '    op.description ? h("p", { className: "op-desc" }, op.description) : null,',
    "    h(Form, {",
    "      schema,",
    "      validator,",
    "      onSubmit: async (submission) => {",
    "        const args = submission.formData ?? {};",
    "        const cli = DATA.cliAvailable ? cliCommand(tool, op, args) : null;",
    "        const request = mcpCallRequest(op, args, tool.version);",
    '        const endpoint = (endpointRef.current || "").trim();',
    "        let call = null;",
    "        if (endpoint) {",
    "          setBusy(true);",
    "          try {",
    "            call = { ok: true, result: await callEndpoint(endpoint, request) };",
    "          } catch (error) {",
    "            call = { ok: false, error: error instanceof Error ? error.message : String(error) };",
    "          }",
    "          setBusy(false);",
    "        }",
    "        setOutcome({ cli, request, call });",
    "      },",
    "    }),",
    "    outcome &&",
    '      h("div", { className: "preview" }, [',
    "        outcome.cli &&",
    '          h("div", { key: "cli" }, h("h4", null, "CLI"), h("pre", null, outcome.cli)),',
    '        h("div", { key: "mcp" }, h("h4", null, "MCP tools/call"), h("pre", null, JSON.stringify(outcome.request, null, 2))),',
    '        busy && h("p", { key: "busy" }, "Calling endpoint\\u2026"),',
    "        outcome.call &&",
    '          h("div", { key: "result" }, [',
    '            h("h4", { key: "h" }, outcome.call.ok ? "Result" : "Error"),',
    "            h(",
    '              "pre",',
    '              { key: "body", className: outcome.call.ok ? "" : "error" },',
    "              outcome.call.ok",
    "                ? JSON.stringify(",
    "                    outcome.call.result && outcome.call.result.structuredContent !== undefined",
    "                      ? outcome.call.result.structuredContent",
    "                      : outcome.call.result,",
    "                    null,",
    "                    2,",
    "                  )",
    "                : outcome.call.error,",
    "            ),",
    "          ]),",
    "      ]),",
    "  );",
    "}",
    "",
    "function App() {",
    "  const ops = DATA.operations;",
    "  const [active, setActive] = React.useState(ops[0] ? ops[0].name : null);",
    '  const [endpoint, setEndpoint] = React.useState(DATA.defaultEndpoint || "");',
    "  const endpointRef = React.useRef(endpoint);",
    "  endpointRef.current = endpoint;",
    "",
    "  const activeOp = ops.find((op) => op.name === active);",
    "  return h(React.Fragment, null, [",
    '    h("header", { key: "header" }, [',
    '      h("h1", { key: "h1" }, DATA.tool.name),',
    "      DATA.tool.description &&",
    '        h("p", { className: "desc", key: "desc" }, DATA.tool.description),',
    '      h("label", { className: "endpoint", key: "endpoint" }, [',
    '        "MCP endpoint (blank to preview only)",',
    '        h("input", {',
    '          key: "input",',
    '          type: "text",',
    "          value: endpoint,",
    "          placeholder: DATA.defaultEndpoint,",
    "          onChange: (event) => setEndpoint(event.target.value),",
    "        }),",
    "      ]),",
    "    ]),",
    "    ops.length === 0",
    '      ? h("main", { key: "empty" }, "No operations reach the web UI yet.")',
    '      : h("div", { className: "layout", key: "layout" }, [',
    '          h("nav", { key: "nav" }, ops.map((op) => h("button", {',
    "            key: op.name,",
    '            type: "button",',
    '            className: op.name === active ? "active" : "",',
    "            onClick: () => setActive(op.name),",
    "          }, op.name))),",
    '          h("main", { key: "main" }, activeOp && h(OperationPanel, {',
    "            key: activeOp.name,",
    "            tool: DATA.tool,",
    "            op: activeOp,",
    "            endpointRef,",
    "          })),",
    "        ]),",
    "    DATA.excluded.length > 0 &&",
    '      h("footer", { key: "footer" },',
    '        DATA.excluded.length + " operation(s) not reachable over MCP, omitted: " +',
    '          DATA.excluded.map((op) => op.name + " (" + (op.reason || "excluded") + ")").join(", ")),',
    "  ]);",
    "}",
    "",
    'createRoot(document.getElementById("root")).render(h(App));',
  ];
  return lines.join("\n");
}

function page(project: Project): string {
  const { included, excluded } = partitionOperations(project.operations);
  const data = {
    tool: {
      name: project.identity.name,
      version: project.identity.version,
      description: project.identity.description,
    },
    cliAvailable: has(project, "cli"),
    defaultEndpoint: DEFAULT_ENDPOINT,
    mcpProtocolVersion: MCP_PROTOCOL_VERSION,
    operations: included,
    excluded,
  };
  return [
    "<!doctype html>",
    "<!-- Generated by toolfactory. Do not edit; run `toolfactory build` to regenerate. -->",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    `<title>${project.identity.name} — operations</title>`,
    `<style>${css()}</style>`,
    "</head>",
    "<body>",
    '<div id="root">Loading…</div>',
    `<script id="tf-data" type="application/json">${embed(data)}</script>`,
    `<script type="module">\n${clientScript()}\n</script>`,
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

export const surface: Surface = {
  id: "web",
  plan(project) {
    return [{ kind: "file", path: WEB_PATH, content: page(project) }];
  },
  verdict: mcpVerdict,
};
