import type { AgentChangeAuthority, AgentChangeAuthoritySource } from "@paperclipai/shared";
import { AGENT_CHANGE_AUTHORITY_LEVELS } from "@paperclipai/shared";

// Same control styling as the trust preset select that sits above this row on
// the Permissions tab, so the two read as one form.
const selectClass =
  "rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm placeholder:text-muted-foreground/40 disabled:opacity-50";

export const AGENT_CHANGE_AUTHORITY_LABELS: Record<AgentChangeAuthority, string> = {
  none: "No",
  suggest: "Suggest changes (Board approves)",
  direct: "Apply directly",
};

export function isAgentChangeAuthorityLocked(source: AgentChangeAuthoritySource) {
  return source === "root_ceo_default" || source === "built_in_default";
}

export function agentChangeAuthorityHint(input: {
  value: AgentChangeAuthority;
  source: AgentChangeAuthoritySource;
  lowTrust: boolean;
}) {
  if (input.lowTrust) return "Low-trust review agents cannot reconfigure other agents.";
  switch (input.source) {
    case "root_ceo_default":
      return "Granted automatically to the root CEO.";
    case "built_in_default":
      return "Granted by default for this built-in agent.";
    case "explicit_grant":
      return input.value === "suggest"
        ? "Granted by the Board. Proposed changes wait for Board consent before they apply."
        : "Granted by the Board. Changes to other agents apply immediately.";
    default:
      return "Cannot change other agents' configuration. Recommends changes to the Board instead.";
  }
}

export function AgentChangeAuthorityField({
  value,
  source,
  lowTrust,
  disabled,
  onChange,
}: {
  value: AgentChangeAuthority;
  source: AgentChangeAuthoritySource;
  lowTrust: boolean;
  disabled?: boolean;
  onChange: (next: AgentChangeAuthority) => void;
}) {
  const locked = isAgentChangeAuthorityLocked(source);
  const inactive = Boolean(disabled) || locked || lowTrust;
  return (
    <div className="flex items-center justify-between gap-4 text-sm">
      <div className="space-y-1">
        <div>Can change other agents' configuration</div>
        <p className="text-xs text-muted-foreground">
          {agentChangeAuthorityHint({ value, source, lowTrust })}
        </p>
      </div>
      <select
        aria-label="Agent change authority"
        className={selectClass}
        value={value}
        disabled={inactive}
        onChange={(event) => {
          const next = event.target.value as AgentChangeAuthority;
          if (next !== value) onChange(next);
        }}
      >
        {AGENT_CHANGE_AUTHORITY_LEVELS.map((level) => (
          <option key={level} value={level}>
            {AGENT_CHANGE_AUTHORITY_LABELS[level]}
          </option>
        ))}
      </select>
    </div>
  );
}
