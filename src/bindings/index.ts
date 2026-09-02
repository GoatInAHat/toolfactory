import type { Binding, PlannedFile, Project } from "../model.js";
import * as python from "./python.js";
import * as typescript from "./typescript.js";

export interface BindingModule {
  /** Files generated on every build for the kernel surfaces (mcp, cli). */
  kernel(project: Project): PlannedFile[];
  /** Files written once by `init` when absent, then owned by the author. */
  scaffold(project: Project): PlannedFile[];
  /** How to launch the kernel MCP server from the repo root without a build step. */
  kernelCommand(project: Project): { command: string; args: string[] };
}

const bindings: Partial<Record<Binding, BindingModule>> = {
  typescript: {
    kernel: typescript.kernel,
    scaffold: typescript.scaffold,
    kernelCommand: () => typescript.kernelCommand(),
  },
  python: {
    kernel: python.kernel,
    scaffold: python.scaffold,
    kernelCommand: python.kernelCommand,
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
