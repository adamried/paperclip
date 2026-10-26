// @vitest-environment jsdom
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthSession } from "@paperclipai/shared";
import { BOOTSTRAP_FALLBACK_COMMAND, OPERATOR_CREDENTIALS_COMMAND } from "@/bootstrapSetup";
import {
  BootstrapPendingPage,
  CLAIM_MAKES_FIRST_ADMIN_COPY,
  INSTANCE_LOGIN_EXPLAINER,
  INVITE_MAKES_FIRST_ADMIN_COPY,
} from "./BootstrapPendingPage";

vi.mock("@/lib/router", () => ({
  Link: ({ children, to, ...props }: { children: ReactNode; to: string } & ComponentProps<"a">) => (
    <a href={to} {...props}>{children}</a>
  ),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const session = {
  user: { id: "user-1", email: "alice@example.com", name: "Alice" },
} as unknown as AuthSession;

describe("BootstrapPendingPage", () => {
  let container: HTMLDivElement;
  let root: Root;

  const render = async (props: Partial<ComponentProps<typeof BootstrapPendingPage>>) => {
    await act(async () =>
      root.render(
        <BootstrapPendingPage
          claimAvailable
          session={null}
          claimState="idle"
          onClaim={() => undefined}
          {...props}
        />,
      ),
    );
  };
  const explainer = () => container.querySelector('[data-testid="instance-login-explainer"]')?.textContent ?? "";

  beforeEach(() => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("explains that login belongs to this instance before sign-in, with both host-side commands", async () => {
    await render({ session: null });

    expect(INSTANCE_LOGIN_EXPLAINER).toContain("not to a hosted subscription");
    expect(explainer()).toBe(`${INSTANCE_LOGIN_EXPLAINER} ${CLAIM_MAKES_FIRST_ADMIN_COPY}`);
    expect(container.textContent).toContain("Sign in / Create account");
    expect(container.textContent).toContain(BOOTSTRAP_FALLBACK_COMMAND);
    expect(container.textContent).toContain(OPERATOR_CREDENTIALS_COMMAND);
    expect(container.textContent).toContain("already run without login");
  });

  it("keeps the claim button and says the signed-in account becomes the first admin", async () => {
    const onClaim = vi.fn();
    await render({ session, onClaim });

    const button = Array.from(container.querySelectorAll("button")).find((el) =>
      el.textContent?.includes("Claim this instance"),
    );
    expect(button).toBeDefined();
    expect(explainer()).toBe(`${INSTANCE_LOGIN_EXPLAINER} ${CLAIM_MAKES_FIRST_ADMIN_COPY}`);
    expect(container.textContent).toContain("alice@example.com");

    await act(async () => button!.click());
    expect(onClaim).toHaveBeenCalledTimes(1);
  });

  it("uses the invite wording when browser claim is disabled (public exposure)", async () => {
    await render({ claimAvailable: false, session: null });

    expect(explainer()).toBe(`${INSTANCE_LOGIN_EXPLAINER} ${INVITE_MAKES_FIRST_ADMIN_COPY}`);
    expect(container.textContent).toContain("waiting on its first admin");
    expect(container.querySelector("button")).toBeNull();
  });
});
