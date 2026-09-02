/**
 * Browser extension: one WXT project under `hosts/browser/`, built for Chromium, Firefox and
 * Safari by the upstream toolchain. The surface is both halves of the boundary at once. For
 * portable operations it is a *client of the kernel*, exactly like `web`: the background worker
 * POSTs stateless MCP to the `mcp --http` endpoint on loopback (hence `requires: ["mcp"]`) and
 * the popup renders the `web` surface's own component tree, imported. For an operation that
 * needs a `browser`, it is §4.4's bridge 3, the host-native escape hatch: the content script and
 * the background tail are the author's, and they turn page state into JSON arguments before the
 * call.
 *
 * Every per-browser manifest transform — MV2 vs MV3, `background.service_worker` vs
 * `background.scripts`, `action` vs `browser_action`, `host_permissions` folded into
 * `permissions` — is WXT's, never this file's: the manifest is not written here but projected
 * into `wxt.config.ts`, and `wxt build -b <target>` emits three of them.
 *
 * §8 C2, "mirror scaffolds by execution, not transcription": `plan()` is pure and therefore has
 * to carry the generator's output, so every pinned value lives in BROWSER_SCAFFOLD below and
 * nowhere else, and `validate()` runs `src/hosts/browser.ts`, which re-runs `wxt init` in a temp
 * directory and fails naming whatever drifted. The placeholder icon set is deliberately not
 * planned, for the same reason the shadcn components are not: they are WXT's binary files, and
 * the drift host copies the ones the project is missing out of that same fresh init.
 */
import { join } from "node:path";
import { execArgv } from "node:process";
import { DRIFT_ENTRY } from "../hosts/browser.js";
import { githubOwner } from "../identity/name.js";
import type { Operation, PlannedFile, Project, Surface, Verdict } from "../model.js";
import { includedOperations } from "../report/coverage.js";
import { has, mcpVerdict } from "./shared.js";
import { WEB_SCAFFOLD } from "./web.js";

export const HOST_DIR = "hosts/browser";
/** The path from `hosts/browser/` to the `web` surface's source tree. */
const WEB_SRC_FROM_HOST = "../../web/src";

/**
 * The WXT release the scaffold, the build and the drift probe all run. Exact, not a range: the
 * constants below are what *this* version's `init` writes, and the drift host runs
 * `npx wxt@<pin> init` to prove it. Renovate bumps it (`renovate.json` `customManagers`).
 */
export const WXT_PIN = "0.21.4";

/** The engines one codebase is built for; `wxt build -b <target>` names each. */
export const TARGETS = ["chrome", "edge", "firefox", "safari"] as const;
export type Target = (typeof TARGETS)[number];
/** The three engines a verdict can differ on; Chrome and Edge are one Chromium package. */
export const ENGINES = ["chromium", "firefox", "safari"] as const;
export type Engine = (typeof ENGINES)[number];

/** Where `<tool> mcp --http` listens by default, and therefore what the extension pairs with. */
export const DEFAULT_ENDPOINT = "http://127.0.0.1:3000/mcp";
/** MCP revision whose per-request `_meta` keys the kernel reads; the `web` surface sends the same. */
const MCP_PROTOCOL_VERSION = "2026-07-28";

/** The generated regions: everything outside them is the author's and survives every build. */
export const CONFIG_BEGIN = "// tf:config";
export const CONFIG_END = "// /tf:config";
export const BG_BEGIN = "// tf:bg";
export const BG_END = "// /tf:bg";
export const CONTENT_BEGIN = "// tf:content";
export const CONTENT_END = "// /tf:content";

/**
 * Everything `npx wxt@<WXT_PIN> init <dir> --template react --pm npm` wrote, transcribed once;
 * `src/hosts/browser.ts` proves it current by running that command again.
 */
export const BROWSER_SCAFFOLD = {
  template: "react",
  packageManager: "npm",
  /** The placeholder icon set the template ships; WXT auto-wires `icon/<size>.png`. */
  icons: ["16", "32", "48", "96", "128"],
  packageJson: {
    scripts: {
      dev: "wxt",
      "dev:firefox": "wxt -b firefox",
      build: "wxt build",
      "build:firefox": "wxt build -b firefox",
      zip: "wxt zip",
      "zip:firefox": "wxt zip -b firefox",
      compile: "tsc --noEmit",
      postinstall: "wxt prepare",
    },
    dependencies: {
      react: "^19.2.4",
      "react-dom": "^19.2.4",
    },
    devDependencies: {
      "@types/react": "^19.2.14",
      "@types/react-dom": "^19.2.3",
      "@wxt-dev/module-react": "^1.1.5",
      typescript: "^5.9.3",
      "web-ext": "^10.5.0",
      wxt: "^0.21.3",
    },
  },
  tsconfig: `{
  "extends": "./.wxt/tsconfig.json",
  "compilerOptions": {
    "allowImportingTsExtensions": true,
    "jsx": "react-jsx"
  }
}
`,
  gitignore: `# Logs
logs
*.log
npm-debug.log*
yarn-debug.log*
yarn-error.log*
pnpm-debug.log*
lerna-debug.log*

node_modules
.output
stats.html
stats-*.json
.wxt
web-ext.config.ts

# Editor directories and files
.vscode/*
!.vscode/extensions.json
.idea
.DS_Store
*.suo
*.ntvs*
*.njsproj
*.sln
*.sw?
`,
} as const;

/**
 * toolfactory's own pins on top of the scaffold's. The React half deliberately follows the `web`
 * surface's, because the popup bundles that tree and the two must resolve to one copy.
 */
const PINS = {
  wxt: WXT_PIN,
  "@wxt-dev/module-react": "^1.2.2",
  /** WXT's Firefox engine, and `web-ext lint`, the only keyless manifest validator that exists. */
  "web-ext": "^10.6.0",
  /** The fake extension API `WxtVitest()` installs for the unit tier. */
  "@webext-core/fake-browser": "^2.0.1",
  /** Matches the repository's own runner, and the vite major WXT builds with. */
  vitest: "^4.1.11",
} as const;

/** The private package `hosts/browser` is; its name is what `wxt zip` names the archives. */
export function browserPackage(project: Project): string {
  return `${project.identity.name}-browser`;
}

/**
 * The zip `wxt zip -b <browser>` writes, by name, inside the release assets. WXT names an archive
 * after `zip.name`, which the generated config sets to the tool's own name, so the assets sit
 * beside the tarball and the bundle under one identity instead of the package's local one.
 */
export function zipName(project: Project, browser: "chrome" | "firefox" | "edge"): string {
  return `${project.identity.name}-${project.identity.version ?? "0.0.0"}-${browser}.zip`;
}

/** The sources archive `wxt zip -b firefox` writes beside it; AMO asks for it when code is minified. */
export function sourcesZipName(project: Project): string {
  return `${project.identity.name}-${project.identity.version ?? "0.0.0"}-sources.zip`;
}

function options(project: Project) {
  return project.tool.browserExtension ?? {};
}

export function endpoint(project: Project): string {
  return options(project).endpoint ?? DEFAULT_ENDPOINT;
}

/**
 * Firefox's add-on id. Required for a Firefox MV3 build and recommended for MV2, so it is
 * emitted whenever it can be derived — an explicit `browserExtension.geckoId`, else the
 * owner-scoped default from the identity file's repository. A tool with neither ships without
 * the block, exactly as the README surface omits the lines that need a GitHub repository.
 */
export function geckoId(project: Project): string | undefined {
  const declared = options(project).geckoId;
  if (declared) return declared;
  const owner = githubOwner(project.identity.repository);
  return owner ? `${project.identity.name}@${owner}.github.io` : undefined;
}

/** Match patterns the extension may act in: loopback always, plus the declared session domains. */
export function hostPermissions(project: Project): string[] {
  // A port in a match pattern is Chromium-only (Firefox rejects it outright), so the portable
  // all-ports form is the only one emitted.
  return ["http://127.0.0.1/*", "http://localhost/*", ...(options(project).authDomains ?? [])];
}

/**
 * The permission list is a capability projection, never authored: `storage` for the pairing
 * store, `activeTab` when an operation declares `browser` (the store-friendly minimum for acting
 * in the tab the user invoked the action on), and the two opt-ins. Anything wider — `debugger`
 * and `tabGroups` for a CDP relay — is Chromium-only and belongs in the author's tail, where the
 * generated per-target filter still drops it for the other engines.
 */
export function permissions(project: Project, operations: Operation[]): string[] {
  const declared = options(project);
  return [
    "storage",
    ...(operations.some((operation) => operation.requires.includes("browser"))
      ? ["activeTab"]
      : []),
    ...(declared.cookieExport ? ["cookies"] : []),
    ...(declared.sidePanel ? ["sidePanel"] : []),
  ];
}

/**
 * The coalesced verdict, for `COVERAGE.md`'s single column: the browser is present, so a
 * `browser` operation is native here (bridge 3, authored in this directory) and a `user-input`
 * one is native too (the popup is the human). Nothing bridges a model or a channel.
 */
export function verdict(operation: Operation): Verdict {
  if (operation.requires.includes("model"))
    return { kind: "excluded", reason: "excluded:no-model-bridge" };
  if (operation.requires.includes("channel"))
    return { kind: "excluded", reason: "excluded:no-channel-bridge" };
  return { kind: "native" };
}

/**
 * The same verdict per engine, which is the finer grain `TARGETS.md` carries. The vocabulary has
 * one `browser` term, so the surface cannot tell a DOM operation from one that reaches for
 * `chrome.debugger`; that stays prose in `TARGETS.md`. What it can derive is the session export:
 * Safari Web Extensions cannot read httpOnly cookies, so an opted-in export degrades there.
 */
export function browserVerdict(operation: Operation, project: Project, engine: Engine): Verdict {
  const coalesced = verdict(operation);
  if (coalesced.kind !== "native") return coalesced;
  if (
    engine === "safari" &&
    options(project).cookieExport &&
    operation.requires.includes("browser")
  )
    return { kind: "degraded", reason: "degraded:no-httponly-cookies" };
  return coalesced;
}

/** The operations the reused page carries: the `web` surface's own rule, so the two agree. */
function pageOperations(project: Project): Operation[] {
  return project.operations.filter((operation) => mcpVerdict(operation).kind !== "excluded");
}

/** What the Playwright smoke submits: the first page operation with an example, else the first. */
function smokeCase(project: Project): { name: string; arguments: Record<string, unknown> } | null {
  const shown = pageOperations(project);
  const examples = project.tool.tests.examples;
  const operation = shown.find((candidate) => examples[candidate.name]) ?? shown[0];
  return operation ? { name: operation.name, arguments: examples[operation.name] ?? {} } : null;
}

/** npm writes a dependency map in name order; a merge patch that does not would churn it. */
function sorted(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a.localeCompare(b)));
}

function packageJsonPatch(project: Project, reuseWeb: boolean): Record<string, unknown> {
  const web = WEB_SCAFFOLD.packageJson;
  return {
    name: browserPackage(project),
    description: project.identity.description,
    private: true,
    version: project.identity.version ?? "0.0.0",
    type: "module",
    scripts: {
      ...BROWSER_SCAFFOLD.packageJson.scripts,
      test: "vitest run",
      smoke: "node tests/smoke.mjs",
    },
    // React follows `web/`'s pins: the popup bundles that tree, and `dedupe` resolves both to one copy.
    dependencies: {
      react: web.dependencies.react,
      "react-dom": web.dependencies["react-dom"],
    },
    devDependencies: sorted({
      ...BROWSER_SCAFFOLD.packageJson.devDependencies,
      "@types/react": web.devDependencies["@types/react"],
      "@types/react-dom": web.devDependencies["@types/react-dom"],
      ...PINS,
      playwright: WEB_SCAFFOLD.playwright,
      ...(reuseWeb ? { "@tailwindcss/vite": web.dependencies["@tailwindcss/vite"] } : {}),
    }),
  };
}

/** A string array as a formatted TypeScript literal, so the generated config reads like source. */
function list(values: string[]): string {
  return `[${values.map((value) => JSON.stringify(value)).join(", ")}]`;
}

function configRegion(project: Project, operations: Operation[], reuseWeb: boolean): string {
  const gecko = geckoId(project);
  return `
// Generated by toolfactory. Do not edit this region; run \`toolfactory build\` to regenerate.
// Everything below the end marker is yours — merge into \`generated\` there and it survives a rebuild.
${reuseWeb ? 'import { resolve } from "node:path";\nimport tailwindcss from "@tailwindcss/vite";\n' : ""}import { defineConfig } from "wxt";

/** Permissions only Chromium implements; dropped from every other target's manifest. */
export const CHROMIUM_ONLY = ["sidePanel", "debugger", "tabGroups"];
const CHROMIUM = ["chrome", "edge"];

const PERMISSIONS = ${list(permissions(project, operations))};
const HOST_PERMISSIONS = ${list(hostPermissions(project))};
${reuseWeb ? `const web = resolve(import.meta.dirname, ${JSON.stringify(WEB_SRC_FROM_HOST)});\n` : ""}
export const generated = {
  modules: ["@wxt-dev/module-react"],
  // The release assets carry the tool's name, not this package's local one.
  zip: { name: ${JSON.stringify(project.identity.name)} },${
    reuseWeb
      ? `
  vite: () => ({
    plugins: [
      tailwindcss(),
      // The popup and the options page are the \`web\` surface's own component tree, imported
      // rather than duplicated. \`enforce: "post"\` is what makes this alias outrank WXT's own
      // \`@\` (this directory, still reachable as \`~\`), so that tree's internal \`@/\` imports
      // resolve inside it.
      {
        name: "toolfactory:web-alias",
        enforce: "post" as const,
        config: () => ({ resolve: { alias: { "@web": web, "@": web } } }),
      },
    ],
    resolve: { dedupe: ["react", "react-dom"] },
  }),`
      : ""
  }
  // WXT emits one manifest per target from this: MV3 with a service worker for Chromium, MV2
  // with background scripts for Firefox and Safari, \`host_permissions\` folded into
  // \`permissions\` where the format has no such key.
  manifest: ({ browser }: { browser: string }) => ({
    name: ${JSON.stringify(project.identity.name)},
    permissions: PERMISSIONS.filter(
      (permission) => CHROMIUM.includes(browser) || !CHROMIUM_ONLY.includes(permission),
    ),
    host_permissions: HOST_PERMISSIONS,${
      gecko
        ? `
    browser_specific_settings: {
      gecko: {
        id: ${JSON.stringify(gecko)},
        // The floor for \`storage.session\` and for the data-collection key below.
        strict_min_version: "140.0",
        // Everything this extension sends goes to the kernel on this machine, so there is no
        // collection to declare. Change it if your operations ship user data to you.
        data_collection_permissions: { required: ["none"] },
      },
    },`
        : ""
    }
    action: { default_title: ${JSON.stringify(project.identity.name)} },
  }),
};
`;
}

const CONFIG_TAIL = `
// Yours: everything below the end marker survives \`toolfactory build\`. Merge into the generated
// config — extra \`modules\`, an \`srcDir\`, manifest keys your capability code needs:
//   export default defineConfig({ ...generated, manifest: (env) => ({ ...generated.manifest(env), … }) })
export default defineConfig({ ...generated });
`;

function mcpTs(project: Project): string {
  return `// Generated by toolfactory. Do not edit; run \`toolfactory build\` to regenerate.
import { browser } from "wxt/browser";

/** Where \`${project.identity.name} mcp --http\` listens by default. */
export const DEFAULT_ENDPOINT = ${JSON.stringify(endpoint(project))};
/** MCP revision whose per-request \`_meta\` keys the kernel reads. */
export const MCP_PROTOCOL_VERSION = ${JSON.stringify(MCP_PROTOCOL_VERSION)};

export interface McpRequest {
  method: string;
  params: { name: string };
}

/** The paired kernel: its URL (persisted) and this session's token (in memory only). */
export async function paired(): Promise<{ endpoint: string; token?: string }> {
  const { endpoint } = await browser.storage.local.get("endpoint");
  const { token } = await browser.storage.session.get("token");
  return {
    endpoint: typeof endpoint === "string" && endpoint ? endpoint : DEFAULT_ENDPOINT,
    token: typeof token === "string" && token ? token : undefined,
  };
}

/**
 * Pair with \`<url>#<token>\`, the string \`${project.identity.name} mcp --http --pair\` prints. The
 * token is kept in \`storage.session\` — in memory, cleared when the browser closes, unreachable
 * from a content script — and never in \`storage.local\`.
 */
export async function pair(pairing: string): Promise<{ endpoint: string; token: boolean }> {
  const hash = pairing.indexOf("#");
  const endpoint = (hash < 0 ? pairing : pairing.slice(0, hash)).trim() || DEFAULT_ENDPOINT;
  const token = hash < 0 ? "" : pairing.slice(hash + 1).trim();
  await browser.storage.local.set({ endpoint });
  await browser.storage.session.set({ token });
  return { endpoint, token: Boolean(token) };
}

/**
 * One stateless MCP POST, from the background worker and nowhere else: an extension page's fetch
 * would carry no token, and a content script's is not CORS-exempt. A worker fetch to a
 * \`host_permissions\` host is, and sends no preflight, so the kernel needs no CORS middleware.
 */
export async function post(request: McpRequest, endpoint?: string): Promise<string> {
  const target = await paired();
  const url = endpoint && /^https?:/i.test(endpoint) ? endpoint : target.endpoint;
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
        "Mcp-Method": request.method,
        "Mcp-Name": request.params.name,
        ...(target.token ? { Authorization: \`Bearer \${target.token}\` } : {}),
      },
      body: JSON.stringify(request),
    });
  } catch (cause) {
    throw new Error(
      \`\${url} refused the connection: start \\\`${project.identity.name} mcp --http\\\`, and on Chromium make sure the browser is 144 or newer (Local Network Access exempts an extension that holds the host permission).\`,
      { cause },
    );
  }
  return await response.text();
}

/** The same POST, parsed: plain JSON or the one \`data:\` SSE frame, exactly as the page reads it. */
export async function call(request: McpRequest, endpoint?: string): Promise<unknown> {
  const text = await post(request, endpoint);
  const framed = text.split("\\n").find((line) => line.startsWith("data:"));
  let body: { error?: unknown; result?: { structuredContent?: unknown } };
  try {
    body = JSON.parse(framed ? framed.slice(5).trim() : text);
  } catch {
    throw new Error(\`not an MCP response: \${text.slice(0, 500)}\`);
  }
  if (body.error) throw new Error(JSON.stringify(body.error));
  return body.result?.structuredContent ?? body.result;
}
`;
}

const BG_REGION = `
// Generated by toolfactory. Do not edit this region; run \`toolfactory build\` to regenerate.
// Everything below the end marker is yours: the operations that need a browser live there.
import { browser } from "wxt/browser";
import { defineBackground } from "wxt/utils/define-background";
import { call, pair, paired, post, type McpRequest } from "../utils/mcp";

export type Message =
  | { type: "mcp"; request: McpRequest; endpoint?: string }
  | { type: "fetch"; request: McpRequest; endpoint?: string }
  | { type: "pair"; pairing: string }
  | { type: "paired" };

/**
 * The router: the one place a message reaches the kernel, and the only context holding the
 * token. \`mcp\` answers with the operation's result — what your capability code wants — and
 * \`fetch\` with the raw MCP response, which the generated page parses itself.
 */
export async function route(message: Message): Promise<unknown> {
  switch (message.type) {
    case "mcp":
      return await call(message.request, message.endpoint);
    case "fetch":
      return await post(message.request, message.endpoint);
    case "pair":
      return await pair(message.pairing);
    case "paired": {
      const { endpoint, token } = await paired();
      return { endpoint, token: Boolean(token) };
    }
  }
}

export const background = defineBackground(() => {
  browser.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    route(message as Message).then(
      (value) => sendResponse({ value }),
      (error: unknown) =>
        sendResponse({ error: error instanceof Error ? error.message : String(error) }),
    );
    return true;
  });
});
`;

const BG_TAIL = `
// Yours: the operations that need a browser are implemented here, and survive every build.
// Decompose, don't inject (§4.5): the page state becomes JSON arguments, and the kernel runs the
// operation.
//
//   browser.runtime.onMessage.addListener(...)        // your own message types
//   await route({ type: "mcp", request: { method: "tools/call", params: { name: "…", arguments: {} } } })

export default background;
`;

const CONTENT_REGION = `
// Generated by toolfactory. Do not edit this region; run \`toolfactory build\` to regenerate.
import { browser } from "wxt/browser";
import { defineContentScript } from "wxt/utils/define-content-script";
`;

function contentTemplate(project: Project): string {
  const matches = options(project).authDomains ?? ["https://example.com/*"];
  return `${CONTENT_BEGIN}${CONTENT_REGION}${CONTENT_END}

// Yours: the shim that turns page state into JSON arguments. It runs inside the logged-in page,
// so the session is already there — read the DOM, hand the result to a portable operation, put
// the answer back. Never fetch the kernel from here: a content script's fetch uses the page's
// origin and is not CORS-exempt. Message the background worker instead, as below.
//
// This file is yours to keep working against the page it scrapes; a selector that moves is not
// something the generator can version-proof.
export default defineContentScript({
  matches: ${list(matches)},
  async main() {
    const answer = await browser.runtime.sendMessage({
      type: "mcp",
      request: { method: "tools/call", params: { name: "…", arguments: {} } },
    });
    console.log(${JSON.stringify(project.identity.name)}, answer);
  },
});
`;
}

const PAGE_TSX = `// Generated by toolfactory. Do not edit; run \`toolfactory build\` to regenerate.
import { useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { browser } from "wxt/browser";

async function send(message: unknown): Promise<unknown> {
  const response = (await browser.runtime.sendMessage(message)) as
    | { value: unknown }
    | { error: string };
  if (response && "error" in response) throw new Error(response.error);
  return (response as { value: unknown })?.value;
}

/**
 * The page never fetches: every MCP POST is forwarded to the background worker, which holds the
 * paired endpoint and the token. That is what lets an extension page be the \`web\` surface's own
 * component tree, unchanged — and what keeps the credential out of a document.
 */
function bridgeFetch(): void {
  const direct = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (init?.method !== "POST") return direct(input, init);
    const endpoint =
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const request = JSON.parse(String(init.body));
    const text = (await send({ type: "fetch", request, endpoint })) as string;
    return new Response(text, { headers: { "content-type": "application/json" } });
  };
}

/** Pairing: \`<url>#<token>\`, the string the kernel prints when it starts serving HTTP. */
export function Pairing() {
  const [pairing, setPairing] = useState("");
  const [status, setStatus] = useState("");
  const show = (state: { endpoint: string; token: boolean }) =>
    setStatus(\`\${state.endpoint}\${state.token ? " (token held for this browser session)" : ""}\`);
  useEffect(() => {
    send({ type: "paired" }).then((state) => show(state as { endpoint: string; token: boolean }));
  }, []);
  return (
    <form
      data-slot="pairing"
      style={{ display: "flex", gap: "0.5rem", alignItems: "center", padding: "0.5rem" }}
      onSubmit={(event) => {
        event.preventDefault();
        send({ type: "pair", pairing })
          .then((state) => show(state as { endpoint: string; token: boolean }))
          .catch((error: Error) => setStatus(error.message));
      }}
    >
      <input
        id="pairing"
        aria-label="Pairing string"
        placeholder="http://127.0.0.1:3000/mcp#token"
        style={{ flex: 1, minWidth: 0 }}
        value={pairing}
        onChange={(event) => setPairing(event.target.value)}
      />
      <button type="submit">Pair</button>
      <span data-slot="paired">{status}</span>
    </form>
  );
}

/**
 * The popup is the same page in 540 pixels; this is how it becomes a real one. \`openOptionsPage\`
 * is the WebExtension API for exactly that, and the options page already mounts this tree.
 */
export function OpenFullPage() {
  return (
    <button
      type="button"
      data-slot="open-full-page"
      style={{ marginLeft: "auto" }}
      onClick={() => browser.runtime.openOptionsPage()}
    >
      Open full page
    </button>
  );
}

export function mount(children: ReactNode): void {
  bridgeFetch();
  createRoot(document.getElementById("root") as HTMLElement).render(children);
}
`;

const PAGE_CSS = `/* Generated by toolfactory. Do not edit; run \`toolfactory build\` to regenerate. */
@import "../${WEB_SRC_FROM_HOST}/index.css";
/* Tailwind scans from this file's directory; the classes are in the web surface's tree. */
@source "../${WEB_SRC_FROM_HOST}";
`;

const ENV_D_TS = `// Generated by toolfactory. Do not edit; run \`toolfactory build\` to regenerate.
/**
 * \`@web/*\` is the \`web\` surface's component tree, resolved by the alias in \`wxt.config.ts\`. It
 * is declared here, not typechecked: \`web\`'s own build typechecks it, against its own React
 * types, and pulling it into this program would compile it against a second copy of them.
 */
declare module "@web/App" {
  const App: () => import("react").ReactNode;
  export default App;
}
`;

/** A page entrypoint's HTML. WXT reads the manifest slot and its options from the meta tags. */
function pageHtml(project: Project, kind: "popup" | "options" | "sidepanel"): string {
  const meta =
    kind === "popup"
      ? '\n    <meta name="manifest.type" content="browser_action" />'
      : kind === "options"
        ? '\n    <meta name="manifest.open_in_tab" content="true" />'
        : "";
  // A popup sizes itself to its content; the reused operations page needs room to be usable.
  const style =
    kind === "popup"
      ? "body { width: 540px; min-height: 320px; margin: 0; }"
      : "body { margin: 0; }";
  return `<!doctype html>
<!-- Generated by toolfactory. Do not edit; run \`toolfactory build\` to regenerate. -->
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${project.identity.name}</title>${meta}
    <style>
      ${style}
    </style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./main.tsx"></script>
  </body>
</html>
`;
}

/** The page entrypoint: the `web` surface's app under the pairing row, or pairing alone. */
function pageMain(reuseWeb: boolean, kind: "popup" | "options" | "sidepanel"): string {
  // Only the popup needs it: it is the one page that is not already a full one.
  const full = kind === "popup";
  return `// Generated by toolfactory. Do not edit; run \`toolfactory build\` to regenerate.
${reuseWeb ? 'import App from "@web/App";\nimport "../../utils/page.css";\n' : ""}import { mount, ${full ? "OpenFullPage, " : ""}Pairing } from "../../utils/page";

mount(
  <>
    <div style={{ display: "flex", alignItems: "center" }}>
      <Pairing />${full ? "\n      <OpenFullPage />" : ""}
    </div>${reuseWeb ? "\n    <App />" : ""}
  </>,
);
`;
}

const VITEST_CONFIG = `// Generated by toolfactory. Do not edit; run \`toolfactory build\` to regenerate.
import { defineConfig } from "vitest/config";
import { WxtVitest } from "wxt/testing/vitest-plugin";

// WxtVitest polyfills the extension APIs with @webext-core/fake-browser and applies the same
// aliases and auto-imports the build does, so a test imports an entrypoint like any module.
export default defineConfig({ plugins: [WxtVitest()] });
`;

const WEB_EXT_CONFIG = `// Generated by toolfactory. Do not edit; run \`toolfactory build\` to regenerate.
// What \`web-ext run\` and \`web-ext lint\` act on when run from this directory: the Firefox
// build \`wxt build -b firefox\` writes.
export default { sourceDir: ".output/firefox-mv2" };
`;

function backgroundTest(project: Project): string {
  const first = pageOperations(project)[0]?.name ?? "tools/list";
  return `// Generated by toolfactory. Do not edit; run \`toolfactory build\` to regenerate.
/**
 * The generated router, in memory: \`@webext-core/fake-browser\` stands in for the extension APIs
 * and \`fetch\` is the only thing stubbed, so what is under test is the pairing store and the one
 * privileged call to the kernel.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { route } from "../entrypoints/background";

const OPERATION = ${JSON.stringify(first)};
const ENVELOPE = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  result: { structuredContent: { ok: true } },
});

describe("the background router", () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
  });

  it("pairs from <url>#<token> and reports what it holds", async () => {
    expect(await route({ type: "pair", pairing: "http://127.0.0.1:4242/mcp#s3cret" })).toEqual({
      endpoint: "http://127.0.0.1:4242/mcp",
      token: true,
    });
    expect(await route({ type: "paired" })).toEqual({
      endpoint: "http://127.0.0.1:4242/mcp",
      token: true,
    });
  });

  it("calls the paired kernel with the MCP headers and the bearer token", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(ENVELOPE));
    await route({ type: "pair", pairing: "http://127.0.0.1:4242/mcp#s3cret" });
    const result = await route({
      type: "mcp",
      request: { method: "tools/call", params: { name: OPERATION } },
    });
    expect(result).toEqual({ ok: true });
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:4242/mcp");
    expect(init.headers).toMatchObject({
      "Mcp-Method": "tools/call",
      "Mcp-Name": OPERATION,
      Authorization: "Bearer s3cret",
    });
  });

  it("says which endpoint refused when the kernel is not running", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));
    await expect(
      route({ type: "mcp", request: { method: "tools/call", params: { name: OPERATION } } }),
    ).rejects.toThrow(\`\${${JSON.stringify(endpoint(project))}} refused the connection\`);
  });
});
`;
}

function smokeMjs(project: Project, reuseWeb: boolean): string {
  const kase = reuseWeb ? smokeCase(project) : null;
  const form = !kase
    ? `
  const popup = await context.newPage();
  await popup.goto(\`chrome-extension://\${id}/popup.html\`);
  await popup.locator('[data-slot="pairing"]').waitFor();
  console.log("PASS the popup renders the pairing form");
`
    : `
  const popup = await context.newPage();
  await popup.goto(\`chrome-extension://\${id}/popup.html\`);
  await popup.getByRole("button", { name: CASE.name, exact: true }).click();
  for (const [name, value] of Object.entries(CASE.arguments)) {
    if (typeof value === "string") await popup.locator(\`[id="\${CASE.name}-\${name}"]\`).fill(value);
  }
  console.log(\`PASS the popup renders the \${CASE.name} form\`);

  await popup.getByRole("button", { name: "Run" }).click();
  await popup.getByRole("tab", { name: "Result" }).click();
  const result = popup.locator('pre[data-slot="result"]');
  await result.waitFor({ state: "visible" });
  const text = (await result.textContent()).trim();
  if (!text.includes(MARKER)) throw new Error(\`the popup rendered no result: \${text}\`);
  console.log(\`PASS \${CASE.name} answered through the worker: \${text.replace(/\\s+/g, " ")}\`);

  const call = seen.at(-1);
  if (!call) throw new Error("the mock kernel was never called");
  if (call.headers.authorization !== \`Bearer \${TOKEN}\`) {
    throw new Error(\`the worker sent no bearer token: \${call.headers.authorization}\`);
  }
  if (call.body.params?.name !== CASE.name) {
    throw new Error(\`the worker called \${call.body.params?.name}, not \${CASE.name}\`);
  }
  console.log(\`PASS the worker sent Bearer <token> and Mcp-Name: \${call.headers["mcp-name"]}\`);
`;
  return `// Generated by toolfactory. Do not edit; run \`toolfactory build\` to regenerate.
/**
 * The keyless end-to-end: the built \`chrome-mv3\` output is side-loaded into a real Chromium and
 * driven the way a human drives it — the options page takes the pairing string, the popup renders
 * the operation, and Run reaches a mock kernel on loopback through the background worker, which
 * is the only context holding the token. No LLM, no store credentials, no real session.
 *
 * Run \`npm --prefix ${HOST_DIR} run build\` first; this loads \`.output/chrome-mv3\`.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const extension = fileURLToPath(new URL("../.output/chrome-mv3", import.meta.url));
const CASE = ${JSON.stringify(kase ?? { name: "", arguments: {} })};
const TOKEN = "smoke-token";
const MARKER = "${project.identity.name}-browser-smoke";

const seen = [];
const kernel = createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => {
    body += chunk;
  });
  request.on("end", () => {
    seen.push({ headers: request.headers, body: JSON.parse(body || "{}") });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: { structuredContent: { smoke: MARKER } } }),
    );
  });
});
await new Promise((resolve) => kernel.listen(0, "127.0.0.1", resolve));
const endpoint = \`http://127.0.0.1:\${kernel.address().port}/mcp\`;

const profile = mkdtempSync(join(tmpdir(), "${project.identity.name}-browser-"));
// \`channel: "chromium"\` is the full build; the headless shell cannot side-load an extension.
const context = await chromium.launchPersistentContext(profile, {
  channel: "chromium",
  args: [\`--disable-extensions-except=\${extension}\`, \`--load-extension=\${extension}\`],
});
const failures = [];
context.on("weberror", (error) => failures.push(error.error().message));
try {
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  const id = new URL(worker.url()).host;
  console.log(\`PASS the extension loaded as \${id}\`);

  const options = await context.newPage();
  await options.goto(\`chrome-extension://\${id}/options.html\`);
  await options.locator("#pairing").fill(\`\${endpoint}#\${TOKEN}\`);
  await options.getByRole("button", { name: "Pair" }).click();
  await options.locator('[data-slot="paired"]').filter({ hasText: endpoint }).waitFor();
  console.log(\`PASS paired with \${endpoint}\`);
${form}
  if (failures.length) throw new Error(\`the extension raised: \${failures.join("; ")}\`);
  console.log("PASS no uncaught page errors");
} finally {
  await context.close();
  kernel.close();
  rmSync(profile, { recursive: true, force: true });
}
`;
}

const ENGINE_LABEL: Record<Engine, string> = {
  chromium: "Chromium (chrome, edge)",
  firefox: "Firefox",
  safari: "Safari",
};

function verdictCell(verdict: Verdict): string {
  return verdict.kind === "native" ? "native" : `${verdict.kind} (${verdict.reason})`;
}

function targetsMarkdown(project: Project): string {
  const rows = project.operations.map(
    (operation) =>
      `| \`${operation.name}\` | ${ENGINES.map((engine) => verdictCell(browserVerdict(operation, project, engine))).join(" | ")} |`,
  );
  const table = project.operations.length
    ? [
        `| Operation | ${ENGINES.map((engine) => ENGINE_LABEL[engine]).join(" | ")} |`,
        `|---|${ENGINES.map(() => "---").join("|")}|`,
        ...rows,
      ].join("\n")
    : "No operation reaches this surface; what the extension does is the authored code in `entrypoints/`.";
  return `# Targets

<!-- Generated by toolfactory. Do not edit; run \`toolfactory build\` to regenerate. -->

One codebase, three engines. \`wxt build -b <chrome|edge|firefox|safari>\` writes each of them, and
every per-browser manifest difference — MV2 against MV3, \`background.scripts\` against
\`background.service_worker\`, \`browser_action\` against \`action\`, \`host_permissions\` folded into
\`permissions\` — is WXT's transform, not this project's.

${table}

## What the table cannot tell you

- **The vocabulary has one \`browser\` term.** An operation that reads the DOM from a content
  script is native on all three engines; one that reaches for \`chrome.debugger\` (a CDP relay, or
  driving another tab) is **Chromium only** — Firefox never implemented the debugger protocol and
  Safari has no such API. You know which one you wrote; the generator does not. Keep the
  Chromium-only permissions in \`CHROMIUM_ONLY\` in \`wxt.config.ts\` so the other targets' manifests
  drop them, and say so here.
- **Content scripts are yours to maintain.** A selector that follows the page it scrapes is
  authored escape-hatch code: the surface can bootstrap it, never version-proof it.
- **Session export degrades on Safari.** Safari Web Extensions cannot read httpOnly cookies, so
  "export the session" is Chromium and Firefox only; "act in the session" — the default, where the
  request is made inside the logged-in page and only the result leaves — works on all three.

## Installing what you built

| Engine | Install |
|---|---|
| Chromium (Chrome, Edge) | \`chrome://extensions\` → Load unpacked → \`.output/chrome-mv3\`. Unpacked installs expire after 30 days and Chrome 149 disables ever-unpacked extensions on update, so the store is the real channel. |
| Firefox | \`npm --prefix ${HOST_DIR} exec -- web-ext run\` for a temporary install, or the Mozilla-signed \`.xpi\` from the release — the one download-and-install channel that is not a store. |
| Safari | \`xcrun safari-web-extension-converter .output/safari-mv2\` on macOS, then Xcode. The payload builds anywhere; signing needs macOS and an Apple developer account. |
`;
}

function readme(project: Project, reuseWeb: boolean): string {
  const name = project.identity.name;
  return `# ${name} — browser extension

<!-- Generated by toolfactory. Do not edit; run \`toolfactory build\` to regenerate. -->

A [WXT](https://wxt.dev) extension for Chromium, Firefox and Safari. It is a client of this
tool's own kernel: the background worker POSTs stateless MCP to \`${name} mcp --http\` on
loopback, and ${
    reuseWeb
      ? "the popup and options page are the `web` surface's component tree, imported rather than duplicated"
      : "the popup is the pairing form"
  }.

\`\`\`
npm --prefix ${HOST_DIR} install          # wxt prepare runs as postinstall
npm --prefix ${HOST_DIR} run dev          # Chromium, hot reload
npm --prefix ${HOST_DIR} run dev:firefox
npm --prefix ${HOST_DIR} run build        # .output/chrome-mv3
npm --prefix ${HOST_DIR} run test         # the router, against a fake browser
npm --prefix ${HOST_DIR} run smoke        # a real Chromium, a mock kernel (build first)
\`\`\`

## Pairing

Any local process can POST to loopback, so the kernel's token is the bar for anything
destructive. Run \`${name} mcp --http --pair\` and paste the \`<url>#<token>\` it prints into the
extension's options page. The token lives in \`storage.session\` — in memory, gone when the
browser closes, invisible to content scripts — and only the background worker ever sends it.${
    reuseWeb
      ? "\nThe reused page's own *MCP endpoint* field is advisory: an absolute `http(s)` URL there is\nused as typed, and anything else falls back to the paired endpoint."
      : ""
  }

## What is generated and what is yours

| Path | Owner |
|---|---|
| \`wxt.config.ts\` | the region between the markers is generated (modules, aliases, the projected manifest); below it is yours |
| \`entrypoints/background.ts\` | the region is the router; below it is where operations that need a browser are implemented |
| \`entrypoints/example.content.ts\` | a template, matching \`example.com\` until you point it at your own domains (or delete it) — the whole script below the marker is yours |
| \`utils/\`, \`entrypoints/popup\`, \`entrypoints/options\`, \`tests/\` | generated |
| \`package.json\` | toolfactory owns the keys it writes; your own dependencies survive |
| \`public/icon/*.png\` | WXT's placeholder set, copied in by \`toolfactory validate\`; replace them with your own |

${
  reuseWeb
    ? "`@` and `@web` resolve to the web surface's `src/` so that tree's own imports work; use WXT's\n`~/` for files in this directory.\n\n"
    : ""
}## The boundary

Core logic stays in the kernel, where it is testable; the extension is transport and policy. An
operation that needs the page is *decomposed*, not injected: the content script reads the DOM,
hands the result to a portable operation as JSON arguments, and puts the answer back. That is why
\`get_professor_rating(name)\` belongs in the kernel and only the scraping belongs here.

Per-engine coverage, the Chromium-only caveats and how to install each build: \`TARGETS.md\`.
`;
}

export const surface: Surface = {
  id: "browser-extension",
  plan(project) {
    const operations = includedOperations(project, surface);
    const reuseWeb = has(project, "web");
    const file = (path: string, content: string): PlannedFile => ({
      kind: "file",
      path: `${HOST_DIR}/${path}`,
      content,
    });
    const page = (kind: "popup" | "options" | "sidepanel"): PlannedFile[] => [
      file(`entrypoints/${kind}/index.html`, pageHtml(project, kind)),
      file(`entrypoints/${kind}/main.tsx`, pageMain(reuseWeb, kind)),
    ];
    return [
      file(".gitignore", BROWSER_SCAFFOLD.gitignore),
      file("README.md", readme(project, reuseWeb)),
      file("TARGETS.md", targetsMarkdown(project)),
      {
        kind: "region",
        path: `${HOST_DIR}/entrypoints/background.ts`,
        regions: [{ begin: BG_BEGIN, end: BG_END, content: BG_REGION }],
        template: `${BG_BEGIN}${BG_END}\n${BG_TAIL}`,
      },
      {
        kind: "region",
        path: `${HOST_DIR}/entrypoints/example.content.ts`,
        regions: [{ begin: CONTENT_BEGIN, end: CONTENT_END, content: CONTENT_REGION }],
        template: contentTemplate(project),
      },
      ...page("popup"),
      ...page("options"),
      ...(options(project).sidePanel ? page("sidepanel") : []),
      {
        kind: "merge",
        path: `${HOST_DIR}/package.json`,
        format: "json",
        patch: packageJsonPatch(project, reuseWeb),
      },
      file("tests/background.test.ts", backgroundTest(project)),
      file("tests/smoke.mjs", smokeMjs(project, reuseWeb)),
      file("tsconfig.json", BROWSER_SCAFFOLD.tsconfig),
      file("utils/mcp.ts", mcpTs(project)),
      file("utils/page.tsx", PAGE_TSX),
      ...(reuseWeb ? [file("utils/page.css", PAGE_CSS), file("env.d.ts", ENV_D_TS)] : []),
      file("vitest.config.ts", VITEST_CONFIG),
      file("web-ext-config.mjs", WEB_EXT_CONFIG),
      {
        kind: "region",
        path: `${HOST_DIR}/wxt.config.ts`,
        regions: [
          {
            begin: CONFIG_BEGIN,
            end: CONFIG_END,
            content: configRegion(project, operations, reuseWeb),
          },
        ],
        template: `${CONFIG_BEGIN}${CONFIG_END}\n${CONFIG_TAIL}`,
      },
    ];
  },
  validate(project) {
    // Every step runs inside the extension, against the binaries it pins as devDependencies:
    // `wxt` reads its entrypoints from the working directory, so `npm --prefix` alone would
    // point it at the repository root.
    const at = { cwd: join(project.root, HOST_DIR) };
    const own = (label: string, ...args: string[]) => ({
      label,
      command: "npm",
      args: ["exec", "--no", "--", ...args],
      ...at,
    });
    return [
      { label: "npm install (hosts/browser)", command: "npm", args: ["install"], ...at },
      own("wxt prepare", "wxt", "prepare"),
      // C2: the scaffold is mirrored by running the real generator, never by trusting constants.
      // The same run seeds WXT's placeholder icons, which plan() cannot write: they are binary.
      {
        label: "browser scaffold drift",
        command: "node",
        args: [...execArgv, DRIFT_ENTRY, project.root],
        cwd: project.root,
      },
      own("wxt build (chrome-mv3)", "wxt", "build"),
      own("wxt build (firefox-mv2)", "wxt", "build", "-b", "firefox"),
      // addons-linter, wrapped: the only keyless manifest validator any engine publishes, and it
      // reads a Chromium manifest sensibly too.
      own("web-ext lint", "web-ext", "lint", "-s", ".output/firefox-mv2"),
      // The smoke drives the Chromium this project's own playwright expects; `install` is a
      // no-op once that revision is present.
      own("playwright install chromium (hosts/browser)", "playwright", "install", "chromium"),
      { label: "vitest (hosts/browser)", command: "npm", args: ["run", "test"], ...at },
      {
        label: "playwright smoke (hosts/browser)",
        command: "node",
        args: ["tests/smoke.mjs"],
        ...at,
      },
    ];
  },
  verdict,
};
