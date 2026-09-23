import { Router } from "express";
import { collectRuntimeInventory } from "../services/runtime-inventory.js";
import { assertInstanceAdmin } from "./authz.js";

/** Which provider CLI build each local adapter runs on. Instance admins only: paths on the host are operator information. */
export function runtimeInventoryRoutes() {
  const router = Router();
  router.get("/instance/runtimes", async (req, res) => {
    assertInstanceAdmin(req);
    res.setHeader("Cache-Control", "no-store");
    res.json(await collectRuntimeInventory());
  });
  return router;
}
