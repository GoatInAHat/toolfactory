/** Surface "workflows": GitHub Actions ci.yml (always) and release.yml (when a registry surface is selected). To be implemented. */
import type { Surface } from "../model.js";

export const surface: Surface = {
  id: "workflows",
  plan() {
    return [];
  },
};
