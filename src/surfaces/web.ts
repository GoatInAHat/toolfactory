/**
 * Web UI: `web/` is a Vite + React + Tailwind v4 + shadcn/ui project, in exactly the shape
 * `npm create vite`, the Tailwind and alias steps from ui.shadcn.com/docs/installation/vite,
 * and `shadcn init` produce. `App.tsx` renders one shadcn form per operation from the
 * `web/src/ops.json` snapshot, previews the equivalent CLI invocation and MCP `tools/call`
 * request, and POSTs that request to a streamable-HTTP MCP server with the 2026-07-28
 * per-request `_meta` fields (there is no handshake in that revision: protocol version,
 * capabilities and client identity travel on every request instead). The dev server proxies
 * `/mcp` to the kernel, so the page never needs CORS.
 *
 * §8 C2, "mirror scaffolds by execution, not transcription": `plan()` is pure and therefore
 * has to carry the scaffolders' output, so every pinned value lives in WEB_SCAFFOLD below and
 * nowhere else, and `validate()` runs `src/hosts/web.ts`, which re-runs the real generators in
 * a temp directory and fails naming whatever drifted. The components under
 * `web/src/components/ui/` are deliberately not planned: they are the shadcn CLI's to write
 * into the author's tree, and `validate()` asks it for them.
 */
import { execArgv } from "node:process";
import { getBinding } from "../bindings/index.js";
import { DRIFT_ENTRY } from "../hosts/web.js";
import type { Operation, Project, Surface } from "../model.js";
import { includedOperations } from "../report/coverage.js";
import { envName, has, json, mcpVerdict } from "./shared.js";

export const WEB_DIR = "web";

/** MCP revision whose per-request `_meta` keys the page sends. */
const MCP_PROTOCOL_VERSION = "2026-07-28";
/**
 * Where the page POSTs by default, relative to the document: one build then serves under `/`
 * (the kernel's own `mcp --http`), under a plugin's prefix (the OpenClaw Control UI tab), and
 * on GitHub Pages, without a rebuild. The dev server proxies the same path to the kernel.
 */
const ENDPOINT_PATH = "mcp";

/**
 * Everything the upstream generators wrote, transcribed once; `validate()` proves it current.
 * Sources, in the order `src/hosts/web.ts` replays them:
 *   npm create vite@latest <dir> -- --template react-ts
 *   ui.shadcn.com/docs/installation/vite  (Tailwind, the `@/*` alias, vite.config.ts)
 *   npx shadcn@latest init -y --base base --preset nova
 *   npx shadcn@latest add -y <components>
 */
export const WEB_SCAFFOLD = {
  viteTemplate: "react-ts",
  base: "base",
  preset: "nova",
  /** The shadcn components the page composes; the CLI copies them into src/components/ui. */
  components: [
    "alert",
    "badge",
    "button",
    "card",
    "empty",
    "field",
    "input",
    "select",
    "switch",
    "tabs",
    "textarea",
    "toggle-group",
  ],
  /** toolfactory's own addition: the browser the smoke script drives. */
  playwright: "^1.62.1",
  /** `npm create vite` output, before the shadcn documentation's edits. */
  vite: {
    "vite.config.ts": `import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
})
`,
    "tsconfig.json": `{
  "files": [],
  "references": [
    { "path": "./tsconfig.app.json" },
    { "path": "./tsconfig.node.json" }
  ]
}
`,
    "tsconfig.app.json": `{
  "compilerOptions": {
    "tsBuildInfoFile": "./node_modules/.tmp/tsconfig.app.tsbuildinfo",
    "target": "es2023",
    "lib": ["ES2023", "DOM"],
    "module": "esnext",
    "types": ["vite/client"],
    "allowArbitraryExtensions": true,
    "skipLibCheck": true,

    /* Bundler mode */
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "moduleDetection": "force",
    "noEmit": true,
    "jsx": "react-jsx",

    /* Linting */
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "erasableSyntaxOnly": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["src"]
}
`,
    "tsconfig.node.json": `{
  "compilerOptions": {
    "tsBuildInfoFile": "./node_modules/.tmp/tsconfig.node.tsbuildinfo",
    "target": "es2023",
    "lib": ["ES2023"],
    "types": ["node"],
    "skipLibCheck": true,

    /* Bundler mode */
    "module": "nodenext",
    "allowImportingTsExtensions": true,
    "verbatimModuleSyntax": true,
    "moduleDetection": "force",
    "noEmit": true,

    /* Linting */
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "erasableSyntaxOnly": true,
    "noFallthroughCasesInSwitch": true
  },
  "include": ["vite.config.ts"]
}
`,
    ".oxlintrc.json": `{
  "$schema": "./node_modules/oxlint/configuration_schema.json",
  "plugins": ["react", "typescript", "oxc"],
  "rules": {
    "react/rules-of-hooks": "error",
    "react/only-export-components": ["warn", { "allowConstantExport": true }]
  }
}
`,
  },
  packageJson: {
    scripts: {
      dev: "vite",
      build: "tsc -b && vite build",
      lint: "oxlint",
      preview: "vite preview",
    },
    dependencies: {
      "@base-ui/react": "^1.7.0",
      "@fontsource-variable/geist": "^5.3.0",
      "@tailwindcss/vite": "^4.3.3",
      "class-variance-authority": "^0.7.1",
      clsx: "^2.1.1",
      "lucide-react": "^1.39.0",
      react: "^19.2.8",
      "react-dom": "^19.2.8",
      shadcn: "^4.20.1",
      "tailwind-merge": "^3.6.0",
      tailwindcss: "^4.3.3",
      "tw-animate-css": "^1.4.0",
    },
    devDependencies: {
      "@types/node": "^24.13.3",
      "@types/react": "^19.2.18",
      "@types/react-dom": "^19.2.4",
      "@vitejs/plugin-react": "^6.1.0",
      oxlint: "^1.79.0",
      typescript: "~6.0.2",
      vite: "^8.2.2",
    },
  },
  componentsJson: {
    $schema: "https://ui.shadcn.com/schema.json",
    style: "base-nova",
    rsc: false,
    tsx: true,
    tailwind: {
      config: "",
      css: "src/index.css",
      baseColor: "neutral",
      cssVariables: true,
      prefix: "",
    },
    iconLibrary: "lucide",
    rtl: false,
    aliases: {
      components: "@/components",
      utils: "@/lib/utils",
      ui: "@/components/ui",
      lib: "@/lib",
      hooks: "@/hooks",
    },
    menuColor: "default",
    menuAccent: "subtle",
    registries: {},
  },
  indexCss: `@import "tailwindcss";
@import "tw-animate-css";
@import "shadcn/tailwind.css";
@import "@fontsource-variable/geist";

@custom-variant dark (&:is(.dark *));

@theme inline {
    --font-heading: var(--font-sans);
    --font-sans: 'Geist Variable', sans-serif;
    --color-sidebar-ring: var(--sidebar-ring);
    --color-sidebar-border: var(--sidebar-border);
    --color-sidebar-accent-foreground: var(--sidebar-accent-foreground);
    --color-sidebar-accent: var(--sidebar-accent);
    --color-sidebar-primary-foreground: var(--sidebar-primary-foreground);
    --color-sidebar-primary: var(--sidebar-primary);
    --color-sidebar-foreground: var(--sidebar-foreground);
    --color-sidebar: var(--sidebar);
    --color-chart-5: var(--chart-5);
    --color-chart-4: var(--chart-4);
    --color-chart-3: var(--chart-3);
    --color-chart-2: var(--chart-2);
    --color-chart-1: var(--chart-1);
    --color-ring: var(--ring);
    --color-input: var(--input);
    --color-border: var(--border);
    --color-destructive: var(--destructive);
    --color-accent-foreground: var(--accent-foreground);
    --color-accent: var(--accent);
    --color-muted-foreground: var(--muted-foreground);
    --color-muted: var(--muted);
    --color-secondary-foreground: var(--secondary-foreground);
    --color-secondary: var(--secondary);
    --color-primary-foreground: var(--primary-foreground);
    --color-primary: var(--primary);
    --color-popover-foreground: var(--popover-foreground);
    --color-popover: var(--popover);
    --color-card-foreground: var(--card-foreground);
    --color-card: var(--card);
    --color-foreground: var(--foreground);
    --color-background: var(--background);
    --radius-sm: calc(var(--radius) * 0.6);
    --radius-md: calc(var(--radius) * 0.8);
    --radius-lg: var(--radius);
    --radius-xl: calc(var(--radius) * 1.4);
    --radius-2xl: calc(var(--radius) * 1.8);
    --radius-3xl: calc(var(--radius) * 2.2);
    --radius-4xl: calc(var(--radius) * 2.6);
}

:root {
    --background: oklch(1 0 0);
    --foreground: oklch(0.145 0 0);
    --card: oklch(1 0 0);
    --card-foreground: oklch(0.145 0 0);
    --popover: oklch(1 0 0);
    --popover-foreground: oklch(0.145 0 0);
    --primary: oklch(0.205 0 0);
    --primary-foreground: oklch(0.985 0 0);
    --secondary: oklch(0.97 0 0);
    --secondary-foreground: oklch(0.205 0 0);
    --muted: oklch(0.97 0 0);
    --muted-foreground: oklch(0.556 0 0);
    --accent: oklch(0.97 0 0);
    --accent-foreground: oklch(0.205 0 0);
    --destructive: oklch(0.577 0.245 27.325);
    --border: oklch(0.922 0 0);
    --input: oklch(0.922 0 0);
    --ring: oklch(0.708 0 0);
    --chart-1: oklch(0.87 0 0);
    --chart-2: oklch(0.556 0 0);
    --chart-3: oklch(0.439 0 0);
    --chart-4: oklch(0.371 0 0);
    --chart-5: oklch(0.269 0 0);
    --radius: 0.625rem;
    --sidebar: oklch(0.985 0 0);
    --sidebar-foreground: oklch(0.145 0 0);
    --sidebar-primary: oklch(0.205 0 0);
    --sidebar-primary-foreground: oklch(0.985 0 0);
    --sidebar-accent: oklch(0.97 0 0);
    --sidebar-accent-foreground: oklch(0.205 0 0);
    --sidebar-border: oklch(0.922 0 0);
    --sidebar-ring: oklch(0.708 0 0);
}

.dark {
    --background: oklch(0.145 0 0);
    --foreground: oklch(0.985 0 0);
    --card: oklch(0.205 0 0);
    --card-foreground: oklch(0.985 0 0);
    --popover: oklch(0.205 0 0);
    --popover-foreground: oklch(0.985 0 0);
    --primary: oklch(0.922 0 0);
    --primary-foreground: oklch(0.205 0 0);
    --secondary: oklch(0.269 0 0);
    --secondary-foreground: oklch(0.985 0 0);
    --muted: oklch(0.269 0 0);
    --muted-foreground: oklch(0.708 0 0);
    --accent: oklch(0.269 0 0);
    --accent-foreground: oklch(0.985 0 0);
    --destructive: oklch(0.704 0.191 22.216);
    --border: oklch(1 0 0 / 10%);
    --input: oklch(1 0 0 / 15%);
    --ring: oklch(0.556 0 0);
    --chart-1: oklch(0.87 0 0);
    --chart-2: oklch(0.556 0 0);
    --chart-3: oklch(0.439 0 0);
    --chart-4: oklch(0.371 0 0);
    --chart-5: oklch(0.269 0 0);
    --sidebar: oklch(0.205 0 0);
    --sidebar-foreground: oklch(0.985 0 0);
    --sidebar-primary: oklch(0.488 0.243 264.376);
    --sidebar-primary-foreground: oklch(0.985 0 0);
    --sidebar-accent: oklch(0.269 0 0);
    --sidebar-accent-foreground: oklch(0.985 0 0);
    --sidebar-border: oklch(1 0 0 / 10%);
    --sidebar-ring: oklch(0.556 0 0);
}

@layer base {
  * {
    @apply border-border outline-ring/50;
    }
  body {
    @apply bg-background text-foreground;
    }
  html {
    @apply font-sans;
    }
}`,
  utils: `import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
`,
} as const;

/** `src/index.css` after the documentation's Tailwind step and before `shadcn init` rewrites it. */
export const TAILWIND_CSS = '@import "tailwindcss";\n';

const MAIN_TSX = `// Generated by toolfactory. Do not edit; run \`toolfactory build\` to regenerate.
import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import "./index.css"
import App from "./App.tsx"

document.documentElement.classList.toggle(
  "dark",
  window.matchMedia("(prefers-color-scheme: dark)").matches,
)

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
`;

/**
 * `src/App.tsx` is a RegionFile: the generated region is the operations page (everything
 * the operator forms need, over `ops.json`) exported as `OperationsPage`; the template's tail —
 * never touched again once the file exists — is the author's `pages` array and the shell that
 * renders whichever one is active. A page an author adds below the end marker (the d3
 * degree-planner graph vutoolkit needs, say) survives every `toolfactory build` because
 * `apply()` only ever replaces the text between the markers (src/project/apply.ts `render()`).
 */
export const APP_BEGIN = "// tf:app";
export const APP_END = "// /tf:app";

const APP_REGION = `
// Generated by toolfactory. Do not edit this region; run \`toolfactory build\` to regenerate.
// Everything below the end marker is yours — add pages there and they survive a rebuild.
import { useEffect, useState, type ReactNode } from "react"
import { MoonIcon, SunIcon } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  initialValues,
  SchemaFields,
  toArguments,
  type FieldValue,
  type FormValues,
  type JsonSchema,
} from "@/schema-form"
import page from "./ops.json"

interface Operation {
  name: string
  description?: string
  inputSchema: JsonSchema
}
interface Page {
  tool: { name: string; version?: string; description?: string }
  cliAvailable: boolean
  defaultEndpoint: string
  mcpProtocolVersion: string
  operations: Operation[]
  excluded: { name: string; reason?: string }[]
}
/** TypeScript widens ops.json into a union of literal schemas; the page reads it as one shape. */
const DATA = page as unknown as Page

/**
 * Same origin as whatever served this document, so one build works under \`/\` (the kernel's
 * \`mcp --http\`), under a plugin route's prefix, and on GitHub Pages.
 */
const DEFAULT_ENDPOINT = new URL(DATA.defaultEndpoint, document.baseURI).href

/**
 * \`<url>/#<token>\` is what \`mcp --http --open\` opens: read the fragment once, keep it in
 * memory and strip it from the address bar, then present it on the API calls. Nothing stores it.
 */
const TOKEN = (() => {
  const fragment = window.location.hash.replace(/^#/, "")
  if (!fragment) return ""
  window.history.replaceState(null, "", window.location.pathname + window.location.search)
  return fragment
})()

/** \`Authorization\` when this page was opened with a token; nothing when it was not. */
function authorization(): Record<string, string> {
  return TOKEN ? { Authorization: \`Bearer \${TOKEN}\` } : {}
}

interface Outcome {
  cli: string | null
  request: unknown
  result?: unknown
  error?: string
}

function mcpRequest(operation: Operation, args: Record<string, unknown>) {
  return {
    jsonrpc: "2.0",
    id: Date.now(),
    method: "tools/call",
    params: {
      name: operation.name,
      arguments: args,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": DATA.mcpProtocolVersion,
        "io.modelcontextprotocol/clientCapabilities": {},
        "io.modelcontextprotocol/clientInfo": {
          name: \`\${DATA.tool.name}-web\`,
          version: DATA.tool.version ?? "0.0.0",
        },
      },
    },
  }
}

/**
 * 2026-07-28 streamable HTTP: no handshake, so protocol version, method and client identity
 * ride on the request itself, and a single tools/call answers with plain JSON or an SSE frame.
 */
async function call(
  endpoint: string,
  request: { method: string; params: { name: string } },
): Promise<unknown> {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": DATA.mcpProtocolVersion,
      "Mcp-Method": request.method,
      "Mcp-Name": request.params.name,
      ...authorization(),
    },
    body: JSON.stringify(request),
  })
  const text = await response.text()
  const framed = text.split("\\n").find((line) => line.startsWith("data:"))
  let body: { error?: unknown; result?: { structuredContent?: unknown } }
  try {
    body = JSON.parse(framed ? framed.slice(5).trim() : text)
  } catch {
    throw new Error(\`HTTP \${response.status}: \${text.slice(0, 500)}\`)
  }
  if (body.error) throw new Error(JSON.stringify(body.error))
  return body.result?.structuredContent ?? body.result
}

function Preview({ outcome }: { outcome: Outcome }) {
  const tabs = [
    outcome.cli === null ? null : { value: "cli", label: "CLI", body: outcome.cli, failed: false },
    {
      value: "mcp",
      label: "MCP tools/call",
      body: JSON.stringify(outcome.request, null, 2),
      failed: false,
    },
    {
      value: "result",
      label: outcome.error ? "Error" : "Result",
      body: outcome.error ?? JSON.stringify(outcome.result, null, 2),
      failed: Boolean(outcome.error),
    },
  ].filter((tab) => tab !== null)
  return (
    <Tabs defaultValue={tabs[0].value} className="w-full">
      <TabsList variant="line">
        {tabs.map((tab) => (
          <TabsTrigger key={tab.value} value={tab.value}>
            {tab.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {tabs.map((tab) => (
        <TabsContent key={tab.value} value={tab.value}>
          <pre
            data-slot={tab.value}
            data-failed={tab.failed}
            className="overflow-x-auto rounded-lg border bg-muted p-3 font-mono text-xs whitespace-pre-wrap data-[failed=true]:border-destructive data-[failed=true]:text-destructive"
          >
            {tab.body}
          </pre>
        </TabsContent>
      ))}
    </Tabs>
  )
}

function OperationCard({ operation, endpoint }: { operation: Operation; endpoint: string }) {
  const [values, setValues] = useState<FormValues>(() => initialValues(operation.inputSchema))
  const [outcome, setOutcome] = useState<Outcome | null>(null)
  const [busy, setBusy] = useState(false)
  const change = (name: string, value: FieldValue) =>
    setValues((current) => ({ ...current, [name]: value }))

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    try {
      const args = toArguments(operation.inputSchema, values)
      const request = mcpRequest(operation, args)
      const cli = DATA.cliAvailable
        ? \`\${DATA.tool.name} \${operation.name} --json '\${JSON.stringify(args)}'\`
        : null
      const target = endpoint.trim()
      if (!target) {
        setOutcome({ cli, request })
      } else {
        try {
          setOutcome({ cli, request, result: await call(target, request) })
        } catch (error) {
          setOutcome({ cli, request, error: error instanceof Error ? error.message : String(error) })
        }
      }
    } catch (error) {
      setOutcome({
        cli: null,
        request: null,
        error: error instanceof Error ? error.message : String(error),
      })
    }
    setBusy(false)
  }

  return (
    <Card>
      <form onSubmit={submit}>
        <CardHeader>
          <CardTitle>{operation.name}</CardTitle>
          {operation.description ? (
            <CardDescription>{operation.description}</CardDescription>
          ) : null}
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          <SchemaFields
            schema={operation.inputSchema}
            values={values}
            onChange={change}
            idPrefix={operation.name}
          />
          <Button type="submit" disabled={busy} className="w-fit">
            Run
          </Button>
          {outcome ? <Preview outcome={outcome} /> : null}
        </CardContent>
      </form>
    </Card>
  )
}

/**
 * The developer's own \`.env\`, edited from the page the kernel is already serving: the kernel
 * answers \`/env\` with the names it declares and which of them have a value, and takes one
 * \`{name, value}\` back. It is the escape hatch for an author working inside an agent harness,
 * where there is no terminal to type a credential into — never the tool's runtime config, which
 * a host injects into the environment.
 *
 * The panel is absent wherever \`/env\` is not answered: a static host (GitHub Pages), a kernel
 * whose project declares no secret, or a build served by anything but the kernel.
 */
function SecretsPanel() {
  const [env, setEnv] = useState<{ declared: string[]; present: string[] } | null>(null)
  const [values, setValues] = useState<Record<string, string>>({})
  const [status, setStatus] = useState("")
  const url = new URL("env", document.baseURI).href
  const load = () =>
    fetch(url, { headers: authorization() })
      .then((response) => (response.ok ? response.json() : Promise.reject(response.status)))
      .then((body: { declared: string[]; present: string[] }) => setEnv(body))
      .catch(() => setEnv(null))
  // Once, on mount: the kernel is the only thing that can answer, and it does not change.
  useEffect(() => {
    load()
  }, [])
  if (!env || env.declared.length === 0) return null

  async function save(name: string) {
    setStatus("")
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authorization() },
      body: JSON.stringify({ name, value: values[name] ?? "" }),
    })
    const body = (await response.json()) as { present?: string[]; error?: string }
    if (!response.ok) return setStatus(body.error ?? \`HTTP \${response.status}\`)
    setValues((current) => ({ ...current, [name]: "" }))
    setStatus(\`\${name} written to .env\`)
    await load()
  }

  return (
    <Card data-slot="secrets">
      <CardHeader>
        <CardTitle>Secrets</CardTitle>
        <CardDescription>
          Written to this checkout's gitignored <code>.env</code>, which the live tests and
          <code> toolfactory bootstrap-repo</code> read. Run <code>toolfactory secrets check</code>{" "}
          to ask each registry whether it accepts them.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {env.declared.map((name) => (
          <Field key={name} orientation="horizontal">
            <FieldLabel htmlFor={\`secret-\${name}\`} className="w-64 shrink-0">
              {name}{" "}
              <Badge variant={env.present.includes(name) ? "secondary" : "outline"}>
                {env.present.includes(name) ? "set" : "missing"}
              </Badge>
            </FieldLabel>
            <Input
              id={\`secret-\${name}\`}
              type="password"
              autoComplete="off"
              placeholder={env.present.includes(name) ? "replace" : "paste the value"}
              value={values[name] ?? ""}
              onChange={(event) => setValues({ ...values, [name]: event.target.value })}
            />
            <Button
              type="button"
              variant="secondary"
              disabled={!values[name]}
              onClick={() => save(name)}
            >
              Save
            </Button>
          </Field>
        ))}
        {status ? (
          <p data-slot="secrets-status" className="text-sm text-muted-foreground">
            {status}
          </p>
        ) : null}
      </CardContent>
    </Card>
  )
}

/** The generated operations page: one form per operation over \`ops.json\`, wired to \`/mcp\`. */
export function OperationsPage() {
  const [endpoint, setEndpoint] = useState(DEFAULT_ENDPOINT)
  const [active, setActive] = useState(DATA.operations[0]?.name ?? "")
  const activeOperation = DATA.operations.find((operation) => operation.name === active)

  return (
    <div className="flex flex-col gap-6">
      <SecretsPanel />
      <Field>
        <FieldLabel htmlFor="endpoint">MCP endpoint</FieldLabel>
        <Input
          id="endpoint"
          value={endpoint}
          placeholder={DEFAULT_ENDPOINT}
          onChange={(event) => setEndpoint(event.target.value)}
        />
      </Field>

      {activeOperation ? (
        <div className="flex flex-col gap-6 md:flex-row">
          <ToggleGroup
            orientation="vertical"
            className="md:w-44"
            value={[activeOperation.name]}
            onValueChange={(names) => names[0] && setActive(String(names[0]))}
          >
            {DATA.operations.map((operation) => (
              <ToggleGroupItem key={operation.name} value={operation.name} className="justify-start">
                {operation.name}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <div className="min-w-0 flex-1">
            <OperationCard
              key={activeOperation.name}
              operation={activeOperation}
              endpoint={endpoint}
            />
          </div>
        </div>
      ) : (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No operations on this surface</EmptyTitle>
            <EmptyDescription>
              Every operation needs a host capability a web page cannot provide.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}

      {DATA.excluded.length > 0 ? (
        <Alert>
          <AlertTitle>
            {DATA.excluded.length} operation(s) are not reachable over MCP
          </AlertTitle>
          <AlertDescription>
            <div className="flex flex-wrap gap-2">
              {DATA.excluded.map((operation) => (
                <Badge key={operation.name} variant="outline">
                  {operation.name} — {operation.reason ?? "excluded"}
                </Badge>
              ))}
            </div>
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  )
}
`;

/**
 * The template's tail, written once when `src/App.tsx` does not exist yet and never touched
 * again: the `pages` array and the shell that renders whichever one is active. `OperationsPage`,
 * every shadcn import it needs, and `DATA` all come from the generated region above — nothing
 * here imports anything of its own.
 */
const APP_TEMPLATE_TAIL = `
export const pages: { id: string; title: string; element: ReactNode }[] = [
  { id: "operations", title: "Operations", element: <OperationsPage /> },
  // Add your own pages here — e.g. a d3 graph in src/pages/planner.tsx, imported above:
  //   import { PlannerPage } from "./pages/planner"
  //   { id: "planner", title: "Degree planner", element: <PlannerPage /> },
]

export default function App() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains("dark"))
  const [active, setActive] = useState(pages[0]?.id ?? "")
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark)
  }, [dark])
  const page = pages.find((candidate) => candidate.id === active) ?? pages[0]

  return (
    <div className="min-h-svh bg-background text-foreground">
      <header className="border-b">
        <div className="mx-auto flex max-w-5xl flex-col gap-4 px-6 py-6">
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-semibold">{DATA.tool.name}</h1>
            {DATA.tool.version ? <Badge variant="secondary">{DATA.tool.version}</Badge> : null}
            {pages.length > 1 ? (
              <nav className="flex gap-1">
                {pages.map((candidate) => (
                  <Button
                    key={candidate.id}
                    variant={candidate.id === active ? "secondary" : "ghost"}
                    size="sm"
                    onClick={() => setActive(candidate.id)}
                  >
                    {candidate.title}
                  </Button>
                ))}
              </nav>
            ) : null}
            <Button
              variant="ghost"
              size="icon"
              className="ml-auto"
              aria-label="Toggle theme"
              onClick={() => setDark(!dark)}
            >
              {dark ? <SunIcon /> : <MoonIcon />}
            </Button>
          </div>
          {DATA.tool.description ? (
            <p className="text-sm text-muted-foreground">{DATA.tool.description}</p>
          ) : null}
        </div>
      </header>

      <main className="mx-auto flex max-w-5xl flex-col gap-6 px-6 py-6">{page?.element}</main>
    </div>
  )
}
`;

const SCHEMA_FORM_TSX = `// Generated by toolfactory. Do not edit; run \`toolfactory build\` to regenerate.
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"

export interface JsonSchema {
  type?: string
  description?: string
  enum?: (string | number)[]
  items?: { type?: string }
  properties?: Record<string, JsonSchema>
  required?: string[]
}

export type FieldValue = string | boolean | null
export type FormValues = Record<string, FieldValue>

type Control = "switch" | "select" | "number" | "list" | "json" | "text"

/** One control per property, chosen exactly as the generated CLI chooses a flag. */
function control(property: JsonSchema): Control {
  if (property.enum) return "select"
  if (property.type === "boolean") return "switch"
  if (property.type === "number" || property.type === "integer") return "number"
  if (property.type === "array") return property.items?.type === "string" ? "list" : "json"
  if (property.type === "string") return "text"
  return "json"
}

const HINT: Partial<Record<Control, string>> = {
  list: "comma-separated",
  json: "JSON",
}

function properties(schema: JsonSchema): [string, JsonSchema][] {
  return Object.entries(schema.properties ?? {})
}

export function initialValues(schema: JsonSchema): FormValues {
  return Object.fromEntries(
    properties(schema).map(([name, property]) => {
      const kind = control(property)
      return [name, kind === "switch" ? false : kind === "select" ? null : ""]
    }),
  )
}

/** The filled-in controls as JSON arguments, coerced the way the CLI coerces its flags. */
export function toArguments(schema: JsonSchema, values: FormValues): Record<string, unknown> {
  const entries = properties(schema).flatMap(([name, property]) => {
    const value = values[name]
    if (value === null || value === "") return []
    if (typeof value === "boolean") return value ? [[name, true] as const] : []
    switch (control(property)) {
      case "number":
        return [[name, Number(value)] as const]
      case "list":
        return [[name, value.split(",").map((item) => item.trim()).filter(Boolean)] as const]
      case "json":
        return [[name, JSON.parse(value) as unknown] as const]
      default:
        return [[name, value] as const]
    }
  })
  return Object.fromEntries(entries)
}

export function SchemaFields({
  schema,
  values,
  onChange,
  idPrefix,
}: {
  schema: JsonSchema
  values: FormValues
  onChange: (name: string, value: FieldValue) => void
  idPrefix: string
}) {
  const required = new Set(schema.required ?? [])
  return (
    <FieldGroup>
      {properties(schema).map(([name, property]) => {
        const kind = control(property)
        const id = \`\${idPrefix}-\${name}\`
        const hint = HINT[kind]
        const description = [property.description, hint && \`(\${hint})\`].filter(Boolean).join(" ")
        const label = (
          <FieldLabel htmlFor={id}>
            {name}
            {required.has(name) ? <span className="text-destructive">*</span> : null}
          </FieldLabel>
        )
        const note = description ? <FieldDescription>{description}</FieldDescription> : null
        if (kind === "switch") {
          return (
            <Field key={name} orientation="horizontal">
              <Switch
                id={id}
                checked={values[name] === true}
                onCheckedChange={(checked) => onChange(name, checked)}
              />
              {label}
              {note}
            </Field>
          )
        }
        if (kind === "select") {
          const items = [
            { label: \`Select \${name}\`, value: null },
            ...(property.enum ?? []).map((option) => ({ label: String(option), value: String(option) })),
          ]
          return (
            <Field key={name}>
              {label}
              <Select
                items={items}
                value={values[name] as string | null}
                onValueChange={(value) => onChange(name, value as FieldValue)}
              >
                <SelectTrigger id={id}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {items.map((item) => (
                      <SelectItem key={String(item.value)} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              {note}
            </Field>
          )
        }
        if (kind === "json") {
          return (
            <Field key={name}>
              {label}
              <Textarea
                id={id}
                value={String(values[name] ?? "")}
                onChange={(event) => onChange(name, event.target.value)}
              />
              {note}
            </Field>
          )
        }
        return (
          <Field key={name}>
            {label}
            <Input
              id={id}
              type={kind === "number" ? "number" : "text"}
              value={String(values[name] ?? "")}
              onChange={(event) => onChange(name, event.target.value)}
            />
            {note}
          </Field>
        )
      })}
    </FieldGroup>
  )
}
`;

/**
 * Playwright smoke for the generated page, driven the way a user runs it: `mcp --http` serves
 * `web/dist` beside the MCP endpoint on one port, so the page is loaded from the very origin it
 * calls, with the token in the fragment exactly as `--open` hands it over. The first read-only
 * operation is then submitted for real and its result has to come back; an operation that is
 * not read-only is never run, because this is the author's own project.
 *
 * Run `npm --prefix web run build` first; the kernel serves what it wrote.
 */
function smokeMjs(project: Project): string {
  const { command, args } = getBinding(project.tool.binding).kernelCommand(project);
  return `// Generated by toolfactory. Do not edit; run \`toolfactory build\` to regenerate.
import { spawn } from "node:child_process"
import { readFile } from "node:fs/promises"
import { chromium } from "playwright"

const page = JSON.parse(await readFile(new URL("./src/ops.json", import.meta.url), "utf8"))
const KERNEL = ${JSON.stringify([command, ...args])}
// A token of this run's own, so the smoke never depends on whether the author has paired, and
// the fragment-to-bearer path the page uses is what gets exercised.
const TOKEN = \`smoke-\${Math.random().toString(36).slice(2)}\`

const kernel = spawn(KERNEL[0], [...KERNEL.slice(1), "--http", "0"], {
  stdio: ["ignore", "ignore", "pipe"],
  env: { ...process.env, ${JSON.stringify(`${envName(project.identity.name)}_MCP_TOKEN`)}: TOKEN },
})
const origin = await new Promise((resolve, reject) => {
  let output = ""
  kernel.stderr.setEncoding("utf8")
  kernel.stderr.on("data", (chunk) => {
    output += chunk
    const serving = /Serving MCP streamable HTTP on (\\S+)/.exec(output)
    if (serving) resolve(new URL("/", serving[1]).href)
  })
  kernel.on("exit", (code) => reject(new Error(\`the kernel exited with \${code}: \${output}\`)))
})
console.log(\`PASS the kernel serves \${origin}\`)

// Read-only, because clicking Run here calls the real operation against the real project.
const operation = page.operations.find((candidate) => candidate.annotations?.readOnlyHint)
if (!operation) {
  console.log("PASS no read-only operation to round-trip; nothing to smoke")
  kernel.kill()
  process.exit(0)
}

const browser = await chromium.launch()
try {
  const tab = await browser.newPage()
  const failures = []
  tab.on("pageerror", (error) => failures.push(error.message))
  await tab.goto(\`\${origin}#\${TOKEN}\`)

  await tab.getByRole("button", { name: operation.name, exact: true }).click()
  const expected = Object.keys(operation.inputSchema.properties ?? {})
  for (const name of expected) {
    await tab.locator(\`[id="\${operation.name}-\${name}"]\`).waitFor({ state: "visible" })
  }
  console.log(\`PASS \${operation.name} renders \${expected.length} field(s): \${expected.join(", ")}\`)

  // Only a required plain string: anything with a default is already the value that works.
  const filled = (operation.inputSchema.required ?? []).find((name) => {
    const property = operation.inputSchema.properties[name]
    return property.type === "string" && !property.enum
  })
  if (filled) await tab.locator(\`[id="\${operation.name}-\${filled}"]\`).fill("smoke")

  await tab.getByRole("button", { name: "Run" }).click()

  if (page.cliAvailable) {
    const cli = tab.locator('pre[data-slot="cli"]')
    await cli.waitFor({ state: "visible" })
    const text = (await cli.textContent()).trim()
    if (filled && !text.includes(\`"\${filled}":"smoke"\`)) {
      throw new Error(\`cli preview lost the \${filled} argument: \${text}\`)
    }
    console.log(\`PASS cli preview: \${text}\`)
  }

  // The round trip: same origin, bearer from the fragment, a real tools/call answered by the
  // kernel that served this page.
  await tab.getByRole("tab", { name: "Result" }).click()
  const result = tab.locator('pre[data-slot="result"]')
  await result.waitFor({ state: "visible" })
  if ((await result.getAttribute("data-failed")) === "true") {
    throw new Error(\`\${operation.name} failed: \${(await result.textContent()).trim()}\`)
  }
  console.log(\`PASS \${operation.name} round-tripped: \${(await result.textContent()).trim().slice(0, 200)}\`)

  if (failures.length) throw new Error(\`page raised: \${failures.join("; ")}\`)
  console.log("PASS no uncaught page errors")
} finally {
  await browser.close()
  kernel.kill()
}
`;
}

const VITE_CONFIG_TS = `// Generated by toolfactory. Do not edit; run \`toolfactory build\` to regenerate.
import path from "path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// Where \`<tool> mcp --http\` listens. The dev server proxies /mcp there so the page POSTs
// same-origin (no CORS), and changeOrigin rewrites Host so the kernel's loopback guard passes.
const mcp = new URL(process.env.VITE_MCP_URL ?? "http://localhost:3000/mcp")

// https://vite.dev/config/
export default defineConfig({
  // Relative, so the one build is served the same wherever it is mounted: at "/" by
  // \`mcp --http\`, under a plugin route's prefix in the OpenClaw Control UI, and under
  // /<repo>/ on GitHub Pages. PAGES_BASE stays an override for a deployment that needs an
  // absolute one; the dev server is always "/".
  base: process.env.PAGES_BASE ?? "./",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
  server: {
    proxy: {
      "/mcp": { target: mcp.origin, changeOrigin: true, rewrite: () => mcp.pathname },
    },
  },
})
`;

/**
 * The documentation's tsconfig steps, minus `baseUrl`: the TypeScript the Vite scaffold pins
 * (6.x) errors on that option, and `paths` alone resolves relative to the config file.
 */
function tsconfigWithAlias(): string {
  return WEB_SCAFFOLD.vite["tsconfig.json"].replace(
    "\n  ]\n}",
    '\n  ],\n  "compilerOptions": {\n    "paths": {\n      "@/*": ["./src/*"]\n    }\n  }\n}',
  );
}

function tsconfigAppWithAlias(): string {
  return WEB_SCAFFOLD.vite["tsconfig.app.json"].replace(
    '"compilerOptions": {',
    '"compilerOptions": {\n    "paths": {\n      "@/*": ["./src/*"]\n    },',
  );
}

/**
 * `web/package.json` is a MergeFile, not a FullFile: an author page that needs its own
 * dependency (`npm --prefix web install d3`, say) survives the next `toolfactory build`
 * because deepMerge only overwrites the keys below, leaving an added `dependencies.d3` alone.
 */
function packageJsonPatch(project: Project): Record<string, unknown> {
  return {
    name: `${project.identity.name}-web`,
    private: true,
    version: project.identity.version ?? "0.0.0",
    type: "module",
    scripts: { ...WEB_SCAFFOLD.packageJson.scripts, smoke: "node smoke.mjs" },
    dependencies: WEB_SCAFFOLD.packageJson.dependencies,
    devDependencies: {
      ...WEB_SCAFFOLD.packageJson.devDependencies,
      playwright: WEB_SCAFFOLD.playwright,
    },
  };
}

function indexHtml(project: Project): string {
  return `<!doctype html>
<!-- Generated by toolfactory. Do not edit; run \`toolfactory build\` to regenerate. -->
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${project.identity.name} — operations</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`;
}

/** Everything the page reads: the operations this surface carries, and why the others are missing. */
function opsJson(project: Project, operations: Operation[]): string {
  const included = new Set(operations.map((operation) => operation.name));
  return json({
    tool: {
      name: project.identity.name,
      version: project.identity.version,
      description: project.identity.description,
    },
    cliAvailable: has(project, "cli"),
    defaultEndpoint: ENDPOINT_PATH,
    mcpProtocolVersion: MCP_PROTOCOL_VERSION,
    operations: operations.map((operation) => ({
      name: operation.name,
      description: operation.description,
      inputSchema: operation.inputSchema,
      // The tool contract's own hints, as MCP carries them; `smoke.mjs` only ever runs a
      // `readOnlyHint` operation, because it runs it against the author's real project.
      annotations: operation.annotations,
    })),
    excluded: project.operations
      .filter((operation) => !included.has(operation.name))
      .map((operation) => ({ name: operation.name, reason: mcpVerdict(operation).reason })),
  });
}

export const surface: Surface = {
  id: "web",
  plan(project) {
    const operations = includedOperations(project, surface);
    const file = (path: string, content: string, output?: true) =>
      ({
        kind: "file",
        path: `${WEB_DIR}/${path}`,
        content,
        ...(output ? { output } : {}),
      }) as const;
    return [
      file(".oxlintrc.json", WEB_SCAFFOLD.vite[".oxlintrc.json"]),
      file("components.json", json(WEB_SCAFFOLD.componentsJson)),
      file("index.html", indexHtml(project)),
      {
        kind: "merge",
        path: `${WEB_DIR}/package.json`,
        format: "json",
        patch: packageJsonPatch(project),
      },
      file("smoke.mjs", smokeMjs(project)),
      {
        kind: "region",
        path: `${WEB_DIR}/src/App.tsx`,
        regions: [{ begin: APP_BEGIN, end: APP_END, content: APP_REGION }],
        template: `${APP_BEGIN}${APP_END}\n${APP_TEMPLATE_TAIL}`,
      },
      file("src/index.css", WEB_SCAFFOLD.indexCss),
      file("src/lib/utils.ts", WEB_SCAFFOLD.utils),
      file("src/main.tsx", MAIN_TSX),
      // A lossy duplicate of dev.toolfactory/ops.json rebuilt by `npm run build`; not tracked (D8).
      file("src/ops.json", opsJson(project, operations), true),
      file("src/schema-form.tsx", SCHEMA_FORM_TSX),
      file("tsconfig.app.json", tsconfigAppWithAlias()),
      file("tsconfig.json", tsconfigWithAlias()),
      file("tsconfig.node.json", WEB_SCAFFOLD.vite["tsconfig.node.json"]),
      file("vite.config.ts", VITE_CONFIG_TS),
    ];
  },
  validate(project) {
    const at = { cwd: project.root };
    return [
      {
        label: "npm install (web)",
        command: "npm",
        args: ["--prefix", WEB_DIR, "install"],
        ...at,
      },
      // The smoke drives the Chromium the project's own playwright expects; `install` is a
      // no-op once that revision is present, so this costs nothing on a warm machine.
      {
        label: "playwright install chromium (web)",
        command: "npm",
        args: ["--prefix", WEB_DIR, "exec", "--no", "--", "playwright", "install", "chromium"],
        ...at,
      },
      // The components under src/components/ui are the shadcn CLI's files, not toolfactory's;
      // run the shadcn the project pins rather than whatever is on PATH. `add` writes the ones
      // that are missing and leaves an unmodified copy of the others alone.
      {
        label: "shadcn add (web)",
        command: "npm",
        args: [
          "--prefix",
          WEB_DIR,
          "exec",
          "--no",
          "--",
          "shadcn",
          "add",
          "--yes",
          "--cwd",
          WEB_DIR,
          ...WEB_SCAFFOLD.components,
        ],
        ...at,
      },
      // C2: the scaffold is mirrored by running the real generators, never by trusting constants.
      {
        label: "web scaffold drift",
        command: "node",
        args: [...execArgv, DRIFT_ENTRY, project.root],
        ...at,
      },
      {
        label: "vite build (web)",
        command: "npm",
        args: ["--prefix", WEB_DIR, "run", "build"],
        ...at,
      },
      {
        label: "playwright smoke (web)",
        command: "node",
        args: [`${WEB_DIR}/smoke.mjs`],
        ...at,
      },
    ];
  },
  verdict: mcpVerdict,
};
