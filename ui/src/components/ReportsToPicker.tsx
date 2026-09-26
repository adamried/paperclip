import { useState } from "react";
import type { Agent } from "@paperclipai/shared";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Landmark, User } from "lucide-react";
import { cn } from "../lib/utils";
import { roleLabels } from "./agent-config-primitives";
import { AgentIcon } from "./AgentIconPicker";
import { Identity } from "./Identity";
import type { CompanyUserDirectoryEntry } from "@/api/access";
import { buildCompanyUserProfileMap } from "@/lib/company-members";
import {
  BOARD_SELECTION,
  selectionsEqual,
  type ReportsToSelection,
} from "@/lib/reports-to-selection";

export const BOARD_MANAGER_LABEL = "The Board";

/** Viewers are read-only members and cannot manage agents. */
export function eligibleManagerUsers(users: CompanyUserDirectoryEntry[] | null | undefined) {
  return (users ?? []).filter((entry) => entry.status === "active" && entry.membershipRole !== "viewer");
}

/**
 * Picks what an agent reports to: the Board, a person on the Board, or
 * another agent. Selection is a discriminated value; the caller turns it into
 * the two-column patch with `selectionToPatch`.
 */
export function ReportsToPicker({
  agents,
  users = [],
  value,
  onChange,
  disabled = false,
  excludeAgentIds = [],
  currentUserId = null,
  disabledEmptyLabel = `Reports to: ${BOARD_MANAGER_LABEL}`,
  chooseLabel = "Reports to...",
}: {
  agents: Agent[];
  users?: CompanyUserDirectoryEntry[];
  value: ReportsToSelection;
  onChange: (selection: ReportsToSelection) => void;
  disabled?: boolean;
  excludeAgentIds?: string[];
  currentUserId?: string | null;
  disabledEmptyLabel?: string;
  chooseLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const exclude = new Set(excludeAgentIds);
  const agentRows = agents.filter(
    (a) => a.status !== "terminated" && !exclude.has(a.id),
  );
  const userRows = eligibleManagerUsers(users);
  const profiles = buildCompanyUserProfileMap(users);

  const currentAgent = value.kind === "agent" ? agents.find((a) => a.id === value.id) ?? null : null;
  const currentUser = value.kind === "user" ? profiles.get(value.id) ?? null : null;
  const terminatedManager = currentAgent?.status === "terminated";
  const unknownAgent = value.kind === "agent" && !currentAgent;
  const unknownUser = value.kind === "user" && !currentUser;
  const isBoard = value.kind === "board";

  const select = (next: ReportsToSelection) => {
    if (!selectionsEqual(next, value)) onChange(next);
    setOpen(false);
  };

  const rowClass = "flex items-center gap-2 w-full min-w-0 px-2 py-1.5 text-xs rounded hover:bg-accent/50 overflow-hidden";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex max-w-full min-w-0 items-center gap-1.5 overflow-hidden rounded-md border border-border px-2 py-1 text-xs hover:bg-accent/50 transition-colors",
            terminatedManager && "border-amber-600/45 bg-amber-500/5",
            disabled && "opacity-60 cursor-not-allowed",
          )}
          disabled={disabled}
        >
          {unknownAgent ? (
            <>
              <User className="h-3 w-3 shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate text-muted-foreground">Unknown manager (stale ID)</span>
            </>
          ) : unknownUser ? (
            <>
              <User className="h-3 w-3 shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate text-muted-foreground">Unknown manager (former member)</span>
            </>
          ) : currentAgent ? (
            <>
              <AgentIcon icon={currentAgent.icon} className="h-3 w-3 shrink-0 text-muted-foreground" />
              <span
                className={cn(
                  "min-w-0 truncate",
                  terminatedManager && "text-amber-900 dark:text-amber-200",
                )}
              >
                {`Reports to ${currentAgent.name}${terminatedManager ? " (terminated)" : ""}`}
              </span>
            </>
          ) : currentUser ? (
            <>
              <Identity name={currentUser.label} avatarUrl={currentUser.image} size="xs" />
              <span className="min-w-0 truncate">
                {`Reports to ${currentUser.label}${value.kind === "user" && value.id === currentUserId ? " (you)" : ""}`}
              </span>
            </>
          ) : isBoard ? (
            <>
              <Landmark className="h-3 w-3 shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate">
                {disabled ? disabledEmptyLabel : `Reports to ${BOARD_MANAGER_LABEL}`}
              </span>
            </>
          ) : (
            <>
              <User className="h-3 w-3 shrink-0 text-muted-foreground" />
              <span className="min-w-0 truncate">{chooseLabel}</span>
            </>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-56 p-1" align="start">
        <button
          type="button"
          className={cn(rowClass, isBoard && "bg-accent")}
          onClick={() => select(BOARD_SELECTION)}
        >
          <Landmark className="shrink-0 h-3 w-3 text-muted-foreground" />
          <span className="min-w-0 truncate">{BOARD_MANAGER_LABEL}</span>
        </button>
        {terminatedManager && currentAgent && (
          <div className="flex min-w-0 items-center gap-2 overflow-hidden px-2 py-1.5 text-xs text-muted-foreground border-b border-border mb-0.5">
            <AgentIcon icon={currentAgent.icon} className="shrink-0 h-3 w-3" />
            <span className="min-w-0 truncate">
              Current: {currentAgent.name} (terminated)
            </span>
          </div>
        )}
        {(unknownAgent || unknownUser) && (
          <div className="px-2 py-1.5 text-xs text-muted-foreground border-b border-border mb-0.5">
            Saved manager is missing from this organization. Choose a new manager or clear.
          </div>
        )}
        {userRows.length > 0 && (
          <div className="px-2 pt-2 pb-1 text-(length:--text-micro) uppercase tracking-wide text-muted-foreground">
            People
          </div>
        )}
        {userRows.map((entry) => {
          const profile = profiles.get(entry.principalId);
          const label = profile?.label ?? entry.principalId;
          const selected = value.kind === "user" && value.id === entry.principalId;
          return (
            <button
              type="button"
              key={entry.principalId}
              className={cn(rowClass, selected && "bg-accent")}
              onClick={() => select({ kind: "user", id: entry.principalId })}
            >
              <Identity name={label} avatarUrl={profile?.image ?? null} size="xs" />
              <span className="min-w-0 truncate">{label}</span>
              <span className="text-muted-foreground ml-auto shrink-0">
                {entry.principalId === currentUserId ? "you" : entry.membershipRole ?? "member"}
              </span>
            </button>
          );
        })}
        {agentRows.length > 0 && (
          <div className="px-2 pt-2 pb-1 text-(length:--text-micro) uppercase tracking-wide text-muted-foreground">
            Agents
          </div>
        )}
        {agentRows.map((a) => (
          <button
            type="button"
            key={a.id}
            className={cn(rowClass, value.kind === "agent" && a.id === value.id && "bg-accent")}
            onClick={() => select({ kind: "agent", id: a.id })}
          >
            <AgentIcon icon={a.icon} className="shrink-0 h-3 w-3 text-muted-foreground" />
            <span className="min-w-0 truncate">{a.name}</span>
            <span className="text-muted-foreground ml-auto shrink-0">{roleLabels[a.role] ?? a.role}</span>
          </button>
        ))}
      </PopoverContent>
    </Popover>
  );
}
