import type {
  ForkUpdateApplyResponse,
  ForkUpdateStatus,
  ForkUpdateSyncRequest,
  ForkUpdateSyncResponse,
} from "@paperclipai/shared";
import { api } from "./client";

export const forkUpdateApi = {
  status: (opts: { refresh?: boolean } = {}) =>
    api.get<ForkUpdateStatus>(`/instance/fork-update/status${opts.refresh ? "?refresh=1" : ""}`, { cache: "no-store" }),
  sync: (body: ForkUpdateSyncRequest = {}) =>
    api.post<ForkUpdateSyncResponse>("/instance/fork-update/sync", body),
  apply: () =>
    api.post<ForkUpdateApplyResponse>("/instance/fork-update/apply", {}),
};
