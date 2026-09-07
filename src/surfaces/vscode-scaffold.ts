/** Captured by running generator-code@1.12.0 (TypeScript/esbuild); hosts/vscode.ts verifies it. */

export const VSCODE_GENERATOR = "1.12.0";
export const GITIGNORE = "out\ndist\nnode_modules\n.vscode-test/\n*.vsix\n";

export const VSCODE_SCAFFOLD = {
  engines: {
    vscode: "^1.136.0",
  },
  scripts: {
    "vscode:prepublish": "npm run package",
    compile: "npm run check-types && npm run lint && node esbuild.js",
    watch: "npm-run-all -p watch:*",
    "watch:esbuild": "node esbuild.js --watch",
    "watch:tsc": "tsc --noEmit --watch --project tsconfig.json",
    package: "npm run check-types && npm run lint && node esbuild.js --production",
    "compile-tests": "tsc -p . --outDir out",
    "watch-tests": "tsc -p . -w --outDir out",
    pretest: "npm run compile-tests && npm run compile && npm run lint",
    "check-types": "tsc --noEmit",
    lint: "eslint src",
    test: "vscode-test",
  },
  devDependencies: {
    "@types/vscode": "^1.136.0",
    "@types/mocha": "^10.0.10",
    "@types/node": "24.x",
    "typescript-eslint": "^8.61.1",
    eslint: "^10.5.0",
    esbuild: "^0.28.1",
    "npm-run-all": "^4.1.5",
    typescript: "^6.0.3",
    "@vscode/test-cli": "^0.0.15",
    "@vscode/test-electron": "^3.0.0",
  },
  overrides: {
    diff: "^8.0.4",
    "serialize-javascript": "^7.0.6",
  },
} as const;

export const ESBUILD =
  "const esbuild = require(\"esbuild\");\n\nconst production = process.argv.includes('--production');\nconst watch = process.argv.includes('--watch');\n\n/**\n * @type {import('esbuild').Plugin}\n */\nconst esbuildProblemMatcherPlugin = {\n\tname: 'esbuild-problem-matcher',\n\n\tsetup(build) {\n\t\tbuild.onStart(() => {\n\t\t\tconsole.log('[watch] build started');\n\t\t});\n\t\tbuild.onEnd((result) => {\n\t\t\tresult.errors.forEach(({ text, location }) => {\n\t\t\t\tconsole.error(`\u2718 [ERROR] ${text}`);\n\t\t\t\tconsole.error(`    ${location.file}:${location.line}:${location.column}:`);\n\t\t\t});\n\t\t\tconsole.log('[watch] build finished');\n\t\t});\n\t},\n};\n\nasync function main() {\n\tconst ctx = await esbuild.context({\n\t\tentryPoints: [\n\t\t\t'src/extension.ts'\n\t\t],\n\t\tbundle: true,\n\t\tformat: 'cjs',\n\t\tminify: production,\n\t\tsourcemap: !production,\n\t\tsourcesContent: false,\n\t\tplatform: 'node',\n\t\toutfile: 'dist/extension.js',\n\t\texternal: ['vscode'],\n\t\tlogLevel: 'silent',\n\t\tplugins: [\n\t\t\t/* add to the end of plugins array */\n\t\t\tesbuildProblemMatcherPlugin,\n\t\t],\n\t});\n\tif (watch) {\n\t\tawait ctx.watch();\n\t} else {\n\t\tawait ctx.rebuild();\n\t\tawait ctx.dispose();\n\t}\n}\n\nmain().catch(e => {\n\tconsole.error(e);\n\tprocess.exit(1);\n});\n";

export const ESLINT =
  'import typescriptEslint from "typescript-eslint";\n\nexport default [{\n    files: ["**/*.ts"],\n}, {\n    plugins: {\n        "@typescript-eslint": typescriptEslint.plugin,\n    },\n\n    languageOptions: {\n        parser: typescriptEslint.parser,\n        ecmaVersion: 2022,\n        sourceType: "module",\n    },\n\n    rules: {\n        "@typescript-eslint/naming-convention": ["warn", {\n            selector: "import",\n            format: ["camelCase", "PascalCase"],\n        }],\n\n        curly: "warn",\n        eqeqeq: "warn",\n        "no-throw-literal": "warn",\n        semi: "warn",\n    },\n}];';

export const IGNORE =
  ".vscode/**\n.vscode-test/**\nout/**\nnode_modules/**\nsrc/**\n.gitignore\n.yarnrc\nesbuild.js\nvsc-extension-quickstart.md\n**/tsconfig.json\n**/eslint.config.mjs\n**/*.map\n**/*.ts\n**/.vscode-test.*\n";

export const LAUNCH =
  '// A launch configuration that compiles the extension and then opens it inside a new window\n// Use IntelliSense to learn about possible attributes.\n// Hover to view descriptions of existing attributes.\n// For more information, visit: https://go.microsoft.com/fwlink/?linkid=830387\n{\n\t"version": "0.2.0",\n\t"configurations": [\n\t\t{\n\t\t\t"name": "Run Extension",\n\t\t\t"type": "extensionHost",\n\t\t\t"request": "launch",\n\t\t\t"args": [\n\t\t\t\t"--extensionDevelopmentPath=${workspaceFolder}"\n\t\t\t],\n\t\t\t"outFiles": [\n\t\t\t\t"${workspaceFolder}/dist/**/*.js"\n\t\t\t],\n\t\t\t"preLaunchTask": "${defaultBuildTask}"\n\t\t}\n\t]\n}\n';

export const TASKS =
  '// See https://go.microsoft.com/fwlink/?LinkId=733558\n// for the documentation about the tasks.json format\n{\n\t"version": "2.0.0",\n\t"tasks": [\n\t\t{\n            "label": "watch",\n            "dependsOn": [\n                "npm: watch:tsc",\n                "npm: watch:esbuild"\n            ],\n            "presentation": {\n                "reveal": "never"\n            },\n            "group": {\n                "kind": "build",\n                "isDefault": true\n            }\n        },\n        {\n            "type": "npm",\n            "script": "watch:esbuild",\n            "group": "build",\n            "problemMatcher": "$esbuild-watch",\n            "isBackground": true,\n            "label": "npm: watch:esbuild",\n            "presentation": {\n                "group": "watch",\n                "reveal": "never"\n            }\n        },\n\t\t{\n            "type": "npm",\n            "script": "watch:tsc",\n            "group": "build",\n            "problemMatcher": "$tsc-watch",\n            "isBackground": true,\n            "label": "npm: watch:tsc",\n            "presentation": {\n                "group": "watch",\n                "reveal": "never"\n            }\n        },\n\t\t{\n\t\t\t"type": "npm",\n\t\t\t"script": "watch-tests",\n\t\t\t"problemMatcher": "$tsc-watch",\n\t\t\t"isBackground": true,\n\t\t\t"presentation": {\n\t\t\t\t"reveal": "never",\n\t\t\t\t"group": "watchers"\n\t\t\t},\n\t\t\t"group": "build"\n\t\t},\n\t\t{\n\t\t\t"label": "tasks: watch-tests",\n\t\t\t"dependsOn": [\n\t\t\t\t"npm: watch",\n\t\t\t\t"npm: watch-tests"\n\t\t\t],\n\t\t\t"problemMatcher": []\n\t\t}\n\t]\n}\n';
