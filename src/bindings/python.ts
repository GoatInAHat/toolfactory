/** Python binding: to be implemented. */
import type { PlannedFile, Project } from "../model.js";

export function kernelCommand(_project: Project): { command: string; args: string[] } {
  throw new Error("The python binding is not implemented yet.");
}

export function kernel(_project: Project): PlannedFile[] {
  throw new Error("The python binding is not implemented yet.");
}

export function scaffold(_project: Project): PlannedFile[] {
  throw new Error("The python binding is not implemented yet.");
}
