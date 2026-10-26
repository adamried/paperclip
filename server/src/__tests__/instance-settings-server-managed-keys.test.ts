import { describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  SERVER_MANAGED_GENERAL_KEYS,
  instanceSettingsService,
} from "../services/instance-settings.js";

/** Mirrors the stub in instance-settings-operator-defaults.test.ts. */
function stubDb(row: Record<string, unknown>) {
  const persistedSets: Array<Record<string, unknown>> = [];
  const db = {
    select: () => ({ from: () => ({ where: () => Promise.resolve([row]) }) }),
    insert: () => {
      throw new Error("unexpected insert in test");
    },
    update: () => ({
      set: (values: Record<string, unknown>) => {
        persistedSets.push(values);
        return { where: () => ({ returning: () => Promise.resolve([{ ...row, ...values }]) }) };
      },
    }),
  } as unknown as Db;
  return { db, persistedSets };
}

function settingsRow(general: Record<string, unknown>) {
  return {
    id: "row-1",
    singletonKey: "default",
    defaultEnvironmentId: null,
    general,
    experimental: {},
    createdAt: new Date("2026-06-20T00:00:00.000Z"),
    updatedAt: new Date("2026-06-20T00:00:00.000Z"),
  };
}

describe("server-managed general settings keys", () => {
  it("registers operatorUserId as server-managed", () => {
    expect(SERVER_MANAGED_GENERAL_KEYS).toContain("operatorUserId");
  });

  it("strips operatorUserId from the general settings view", async () => {
    const { db } = stubDb(settingsRow({ keyboardShortcuts: true, operatorUserId: "op-1" }));
    const svc = instanceSettingsService(db, { runtimeEnv: {} });
    const general = await svc.getGeneral();
    expect(general.keyboardShortcuts).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(general, "operatorUserId")).toBe(false);
    const full = await svc.get();
    expect(Object.prototype.hasOwnProperty.call(full.general, "operatorUserId")).toBe(false);
  });

  it("keeps operatorUserId through a general settings write", async () => {
    const { db, persistedSets } = stubDb(settingsRow({ keyboardShortcuts: false, operatorUserId: "op-1" }));
    const svc = instanceSettingsService(db, { runtimeEnv: {} });
    const result = await svc.updateGeneral({ keyboardShortcuts: true });
    expect(persistedSets).toHaveLength(1);
    const persistedGeneral = persistedSets[0]!.general as Record<string, unknown>;
    expect(persistedGeneral.keyboardShortcuts).toBe(true);
    expect(persistedGeneral.operatorUserId).toBe("op-1");
    // ...and the response still does not expose it.
    expect(Object.prototype.hasOwnProperty.call(result.general, "operatorUserId")).toBe(false);
  });

  it("records the operator id by merging into the stored general object", async () => {
    const { db, persistedSets } = stubDb(settingsRow({ keyboardShortcuts: true, executionMode: "any" }));
    const svc = instanceSettingsService(db, { runtimeEnv: {} });
    await svc.recordOperatorUserId("op-2");
    expect(persistedSets).toHaveLength(1);
    expect(persistedSets[0]!.general).toEqual({ keyboardShortcuts: true, executionMode: "any", operatorUserId: "op-2" });
  });
});
