// @vitest-environment jsdom
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentChangeAuthority, AgentChangeAuthoritySource } from "@paperclipai/shared";
import { AgentChangeAuthorityField, agentChangeAuthorityHint } from "./AgentChangeAuthorityField";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function renderField(input: {
  value: AgentChangeAuthority;
  source: AgentChangeAuthoritySource;
  lowTrust?: boolean;
  disabled?: boolean;
}) {
  container = document.createElement("div");
  document.body.appendChild(container);
  const onChange = vi.fn();
  const createdRoot = createRoot(container);
  root = createdRoot;
  flushSync(() => {
    createdRoot.render(
      <AgentChangeAuthorityField
        value={input.value}
        source={input.source}
        lowTrust={input.lowTrust ?? false}
        disabled={input.disabled}
        onChange={onChange}
      />,
    );
  });
  const select = () => container?.querySelector("select") as HTMLSelectElement;
  return { onChange, select, text: () => container?.textContent ?? "" };
}

function chooseOption(select: HTMLSelectElement, value: string) {
  flushSync(() => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

afterEach(() => {
  if (root) {
    flushSync(() => root?.unmount());
  }
  container?.remove();
  root = null;
  container = null;
});

describe("AgentChangeAuthorityField", () => {
  it("renders the three levels and reports a selection", () => {
    const view = renderField({ value: "none", source: "none" });

    const labels = Array.from(view.select().options).map((option) => option.textContent);
    expect(labels).toEqual(["No", "Suggest changes (Board approves)", "Apply directly"]);
    expect(view.select().disabled).toBe(false);
    expect(view.text()).toContain("Cannot change other agents' configuration");

    chooseOption(view.select(), "suggest");
    expect(view.onChange).toHaveBeenCalledWith("suggest");
  });

  it("does not report a change for the current value", () => {
    const view = renderField({ value: "direct", source: "explicit_grant" });

    chooseOption(view.select(), "direct");
    expect(view.onChange).not.toHaveBeenCalled();
    expect(view.text()).toContain("Granted by the Board");
  });

  it("locks automatic defaults and explains why", () => {
    const view = renderField({ value: "direct", source: "root_ceo_default" });

    expect(view.select().disabled).toBe(true);
    expect(view.text()).toContain("Granted automatically to the root CEO.");
  });

  it("disables the control for low-trust review agents", () => {
    const view = renderField({ value: "none", source: "none", lowTrust: true });

    expect(view.select().disabled).toBe(true);
    expect(view.text()).toContain("Low-trust review agents cannot reconfigure other agents.");
  });

  it("describes each source", () => {
    expect(agentChangeAuthorityHint({ value: "suggest", source: "built_in_default", lowTrust: false })).toContain("built-in");
    expect(agentChangeAuthorityHint({ value: "suggest", source: "explicit_grant", lowTrust: false })).toContain("Board consent");
    expect(agentChangeAuthorityHint({ value: "direct", source: "explicit_grant", lowTrust: false })).toContain("apply immediately");
  });
});
