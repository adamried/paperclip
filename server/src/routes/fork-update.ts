import { Router } from "express";
import { forkUpdateSyncRequestSchema } from "@paperclipai/shared";
import { forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { isCloudManagedInstance } from "../services/cloud-instance.js";
import { forkUpdateService, type ForkUpdateService } from "../services/fork-update.js";
import { assertInstanceAdmin } from "./authz.js";

// Fork update endpoints: instance admins only, and never on cloud-managed
// instances, where the platform owns the deployed code. Responses echo the
// checkout path and git facts, which only an operator should see.
export function forkUpdateRoutes(service: ForkUpdateService = forkUpdateService()) {
  const router = Router();

  const guard = (req: Parameters<typeof assertInstanceAdmin>[0]) => {
    assertInstanceAdmin(req);
    if (isCloudManagedInstance()) {
      throw forbidden("Fork updates are platform-managed on cloud-managed instances", {
        code: "fork_update_platform_managed",
      });
    }
  };

  router.get("/instance/fork-update/status", async (req, res) => {
    guard(req);
    const refresh = req.query.refresh === "1" || req.query.refresh === "true";
    res.json(await service.getStatus({ refresh }));
  });

  router.post("/instance/fork-update/sync", validate(forkUpdateSyncRequestSchema), async (req, res) => {
    guard(req);
    res.status(202).json(await service.dispatchSync(req.body));
  });

  router.post("/instance/fork-update/apply", async (req, res) => {
    guard(req);
    res.status(202).json(await service.startApply());
  });

  return router;
}
