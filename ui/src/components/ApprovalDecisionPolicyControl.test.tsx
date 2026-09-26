// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ApprovalDecisionPolicy } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApprovalDecisionPolicyControl } from "./ApprovalDecisionPolicyControl";

const mockApi = vi.hoisted(() => ({ getMine: vi.fn(), updateMine: vi.fn() }));

vi.mock("@/api/approval-decision-policy", () => ({ approvalDecisionPolicyApi: mockApi }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function waitForAssertion(assertion: () => void, attempts = 20) {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await flush();
    }
  }
  throw lastError;
}

function policy(overrides: Partial<ApprovalDecisionPolicy> = {}): ApprovalDecisionPolicy {
  return {
    companyId: "company-1",
    userId: "user-1",
    policy: "any_board",
    materialized: false,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

function render(container: HTMLDivElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(container);
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <ApprovalDecisionPolicyControl companyId="company-1" />
      </QueryClientProvider>,
    );
  });
  return root;
}

function optionByTitle(container: HTMLElement, title: string) {
  return Array.from(container.querySelectorAll('[role="radio"]'))
    .find((node) => node.textContent?.includes(title)) as HTMLButtonElement | undefined;
}

function saveButton(container: HTMLElement) {
  return Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("Save"));
}

describe("ApprovalDecisionPolicyControl", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockApi.getMine.mockResolvedValue(policy());
    mockApi.updateMine.mockImplementation((_companyId: string, input: { policy: ApprovalDecisionPolicy["policy"] }) =>
      Promise.resolve(policy({ policy: input.policy, materialized: true })),
    );
  });

  afterEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("renders both options with the persisted policy selected", async () => {
    mockApi.getMine.mockResolvedValue(policy({ policy: "addressee_only" }));
    const root = render(container);
    await flush();

    await waitForAssertion(() => {
      expect(optionByTitle(container, "Anyone on the Board can decide")?.getAttribute("aria-checked")).toBe("false");
      expect(optionByTitle(container, "Only I can decide")?.getAttribute("aria-checked")).toBe("true");
      expect(saveButton(container)?.disabled).toBe(true);
    });

    act(() => root.unmount());
  });

  it("saves a changed policy through the PUT endpoint", async () => {
    const root = render(container);
    await flush();

    await waitForAssertion(() => {
      expect(optionByTitle(container, "Only I can decide")).toBeTruthy();
    });
    act(() => optionByTitle(container, "Only I can decide")?.click());
    await waitForAssertion(() => {
      expect(saveButton(container)?.disabled).toBe(false);
    });
    act(() => saveButton(container)?.click());

    await waitForAssertion(() => {
      expect(mockApi.updateMine).toHaveBeenCalledWith("company-1", { policy: "addressee_only" });
      expect(container.textContent).toContain("Saved");
    });

    act(() => root.unmount());
  });

  it("surfaces load failures", async () => {
    mockApi.getMine.mockRejectedValue(new Error("Policy endpoint failed"));
    const root = render(container);
    await flush();

    await waitForAssertion(() => {
      expect(container.textContent).toContain("Policy endpoint failed");
    });

    act(() => root.unmount());
  });
});
