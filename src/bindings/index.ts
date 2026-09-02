import type { Binding, PlannedFile, Project } from "../model.js";
import * as python from "./python.js";
import * as typescript from "./typescript.js";

export interface BindingModule {
  /** Files generated on every build for every tool: the contract, config, and the MCP server toolfactory introspects. */
  kernel(project: Project): PlannedFile[];
  /** The `cli` surface's files. */
  cli(project: Project): PlannedFile[];
  /** The T4 live test; empty when no config key is both required and sensitive. */
  liveTest(project: Project): PlannedFile[];
  /** Files written once by `init` when absent, then owned by the author. */
  scaffold(project: Project): PlannedFile[];
  /** How to launch the kernel MCP server from the repo root without a build step. */
  kernelCommand(project: Project): { command: string; args: string[] };
  /** The kernel CLI counterpart of `kernelCommand`, for the `cli` surface's smoke check. */
  cliCommand(project: Project): { command: string; args: string[] };
}

const bindings: Partial<Record<Binding, BindingModule>> = {
  typescript: {
    kernel: typescript.kernel,
    cli: typescript.cli,
    liveTest: typescript.liveTest,
    scaffold: typescript.scaffold,
    kernelCommand: () => typescript.kernelCommand(),
    cliCommand: () => typescript.cliCommand(),
  },
  python: {
    kernel: python.kernel,
    cli: python.cli,
    liveTest: python.liveTest,
    scaffold: python.scaffold,
    kernelCommand: python.kernelCommand,
    cliCommand: python.cliCommand,
  },
};

export function registerBinding(id: Binding, module: BindingModule): void {
  bindings[id] = module;
}

export function getBinding(id: Binding): BindingModule {
  const binding = bindings[id];
  if (!binding) throw new Error(`Binding "${id}" is not implemented in this toolfactory version.`);
  return binding;
}
