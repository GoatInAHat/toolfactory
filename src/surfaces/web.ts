/** Surface "web": to be implemented. */
import type { Surface } from "../model.js";

export const surface: Surface = {
  id: "web",
  plan() {
    throw new Error('Surface "web" is not implemented yet.');
  },
};
