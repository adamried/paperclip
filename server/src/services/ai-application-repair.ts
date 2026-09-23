import { and, eq, exists, ne, sql } from "drizzle-orm";
import { toolApplications, toolConnections, type Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

/**
 * Removing the last AI account archives the provider application row. Until
 * `save()` learned to reactivate it, a later reconnect attached new accounts
 * to the archived application, which hid them on the Connectors page. Bring
 * back any archived application that still has non-archived connections.
 * Idempotent; runs at startup.
 */
export async function repairArchivedApplicationsWithLiveConnections(db: Db): Promise<number> {
  try {
    const restored = await db
      .update(toolApplications)
      .set({ status: "active", archivedAt: null, updatedAt: new Date() })
      .where(
        and(
          eq(toolApplications.status, "archived"),
          exists(
            db
              .select({ one: sql`1` })
              .from(toolConnections)
              .where(
                and(
                  eq(toolConnections.applicationId, toolApplications.id),
                  ne(toolConnections.status, "archived"),
                ),
              ),
          ),
        ),
      )
      .returning({ id: toolApplications.id, name: toolApplications.name });
    if (restored.length > 0) {
      logger.info({ applications: restored.map((row) => row.name) }, "restored archived applications that still have live connections");
    }
    return restored.length;
  } catch (err) {
    logger.warn({ err }, "archived application repair failed; continuing startup");
    return 0;
  }
}
