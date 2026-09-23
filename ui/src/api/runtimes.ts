import type { RuntimeInventory } from "@paperclipai/shared";
import { api } from "./client";

export const runtimesApi = {
  inventory: () => api.get<RuntimeInventory>("/instance/runtimes", { cache: "no-store" }),
};
