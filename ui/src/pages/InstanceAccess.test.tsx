// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/client";
import { CompanyProvider, useCompany } from "@/context/CompanyContext";
import { InstanceAccess } from "./InstanceAccess";

const mocks = vi.hoisted(() => ({
  list: vi.fn(), directory: vi.fn(), detachInflightList: vi.fn(), detachInflightDirectory: vi.fn(),
  getSession: vi.fn(), searchAdminUsers: vi.fn(), getUserCompanyAccess: vi.fn(),
  setUserCompanyAccess: vi.fn(), setBreadcrumbs: vi.fn(), pushToast: vi.fn(),
  listBoardMembers: vi.fn(), promoteInstanceAdmin: vi.fn(), demoteInstanceAdmin: vi.fn(),
}));
vi.mock("@/api/companies", () => ({ companiesApi: mocks }));
vi.mock("@/api/auth", () => ({ authApi: mocks }));
vi.mock("@/api/access", () => ({ accessApi: mocks }));
vi.mock("@/context/BreadcrumbContext", () => ({ useBreadcrumbs: () => mocks }));
vi.mock("@/context/ToastContext", () => ({ useToast: () => mocks }));

const companyA = { id: "company-a", name: "Company A", issuePrefix: "CPA", status: "active" };
const companyB = { id: "company-b", name: "Company B", issuePrefix: "CPB", status: "active" };
const user = { id: "admin", name: "Admin", email: "admin@example.com", isInstanceAdmin: true };
const adminSeat = { id: user.id, name: user.name, email: user.email, image: null, isOperator: true, memberSince: "2020-01-01T00:00:00Z" };
const danaSeat = { id: "dana", name: "Dana", email: "dana@example.com", image: null, isOperator: false, memberSince: "2020-02-01T00:00:00Z" };
const membershipA = {
  id: "membership-a", companyId: companyA.id, companyName: companyA.name,
  status: "active", membershipRole: "owner", updatedAt: "2020-01-01T00:00:00Z",
};

let container: HTMLDivElement;
let root: Root;
let client: QueryClient;

function NavigationProbe() {
  const { companies } = useCompany();
  return <nav data-testid="navigation">{companies.map((company) => company.name).join(", ")}</nav>;
}

async function renderPage() {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <CompanyProvider><NavigationProbe /><InstanceAccess /></CompanyProvider>
      </QueryClientProvider>,
    );
  });
}

async function eventually(assertion: () => void) {
  await vi.waitFor(async () => {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    assertion();
  });
}

function button(text: string) {
  return [...container.querySelectorAll("button")].find((element) => element.textContent === text);
}

beforeEach(() => {
  vi.resetAllMocks();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  localStorage.clear();
  mocks.getSession.mockResolvedValue({ session: { id: "session-admin", userId: user.id }, user });
  mocks.list.mockResolvedValue([companyA]);
  mocks.directory.mockResolvedValue([companyA, companyB]);
  mocks.searchAdminUsers.mockResolvedValue([user]);
  mocks.getUserCompanyAccess.mockResolvedValue({ user, companyAccess: [membershipA] });
  mocks.setUserCompanyAccess.mockResolvedValue({});
  mocks.listBoardMembers.mockResolvedValue({ members: [adminSeat, danaSeat], operatorUserId: user.id, legacySentinelHoldsAdmin: false });
  mocks.demoteInstanceAdmin.mockResolvedValue({});
  mocks.promoteInstanceAdmin.mockResolvedValue({});
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  container.remove();
});

describe("InstanceAccess company directory", () => {
  it("lets admins grant access outside their navigation list and refreshes their own navigation", async () => {
    await renderPage();
    await eventually(() => {
      expect(button("Save organization access")).toBeDefined();
      expect(container.querySelector("nav")?.textContent).toBe("Company A");
    });
    const otherCompany = [...container.querySelectorAll("label")].find((label) => label.textContent?.includes("Company B"));
    const checkbox = otherCompany?.querySelector<HTMLButtonElement>('[role="checkbox"]');
    expect(checkbox?.getAttribute("aria-checked")).toBe("false");
    mocks.setUserCompanyAccess.mockImplementation(async () => {
      mocks.list.mockResolvedValue([companyA, companyB]);
      mocks.getUserCompanyAccess.mockResolvedValue({ user, companyAccess: [membershipA, {
        ...membershipA, id: "membership-b", companyId: companyB.id, companyName: companyB.name,
      }] });
      return {};
    });
    await act(async () => checkbox!.click());
    await act(async () => button("Save organization access")!.click());
    await eventually(() => {
      expect(mocks.setUserCompanyAccess).toHaveBeenCalledWith(user.id, [companyA.id, companyB.id]);
      expect(container.querySelector("nav")?.textContent).toBe("Company A, Company B");
    });
  });

  it("prevents editing an incomplete directory and lets the admin retry", async () => {
    mocks.directory.mockRejectedValue(new Error("Unavailable"));
    await renderPage();
    await eventually(() => {
      expect(container.textContent).toContain("Failed to load organizations.");
      expect(container.querySelector("nav")?.textContent).toBe("Company A");
    });
    expect(button("Save organization access")).toBeUndefined();
    expect(mocks.setUserCompanyAccess).not.toHaveBeenCalled();
    mocks.directory.mockResolvedValue([companyA, companyB]);
    await act(async () => button("Try again")!.click());
    await eventually(() => expect(button("Save organization access")).toBeDefined());
  });

  it("does not request the directory when instance administration is forbidden", async () => {
    mocks.searchAdminUsers.mockRejectedValue(new ApiError("Forbidden", 403, {}));
    await renderPage();
    await eventually(() => expect(container.textContent).toContain("Instance admin access is required"));
    expect(mocks.directory).not.toHaveBeenCalled();
  });
});

describe("InstanceAccess Board section", () => {
  function memberRows() {
    return [...container.querySelectorAll('ul[aria-label="Board members"] > li')];
  }

  it("lists Board members with the operator badge and removes a member through the demote route", async () => {
    await renderPage();
    await eventually(() => expect(memberRows()).toHaveLength(2));
    const [adminRow, danaRow] = memberRows();
    expect(adminRow!.textContent).toContain("Admin");
    expect(adminRow!.textContent).toContain("Operator");
    expect(adminRow!.textContent).toContain("You");
    expect(danaRow!.textContent).toContain("Dana");
    expect(danaRow!.textContent).not.toContain("Operator");
    expect(container.textContent).toContain("Agents can report to Board members but cannot be Board members.");

    mocks.demoteInstanceAdmin.mockImplementation(async () => {
      mocks.listBoardMembers.mockResolvedValue({ members: [adminSeat], operatorUserId: user.id, legacySentinelHoldsAdmin: false });
      return {};
    });
    await act(async () => danaRow!.querySelector("button")!.click());
    await eventually(() => {
      expect(mocks.demoteInstanceAdmin).toHaveBeenCalledWith("dana");
      expect(memberRows()).toHaveLength(1);
    });
    // The last seat cannot be removed from the UI either.
    expect(memberRows()[0]!.querySelector("button")!.disabled).toBe(true);
  });

  it("shows the server's refusal when removing the last member fails with 409", async () => {
    mocks.demoteInstanceAdmin.mockRejectedValue(
      new ApiError("The Board must keep at least one member. Add another Board member before removing this one.", 409, {}),
    );
    await renderPage();
    await eventually(() => expect(memberRows()).toHaveLength(2));
    await act(async () => memberRows()[1]!.querySelector("button")!.click());
    await eventually(() => expect(container.textContent).toContain("The Board must keep at least one member."));
  });

  it("adds a Board member from the user search and never offers the sentinel", async () => {
    const newcomer = { id: "lee", name: "Lee", email: "lee@example.com", image: null, isInstanceAdmin: false, activeCompanyMembershipCount: 0 };
    mocks.searchAdminUsers.mockImplementation(async (query: string) => (query === "lee" ? [newcomer] : [user]));
    await renderPage();
    await eventually(() => expect(memberRows()).toHaveLength(2));
    const input = [...container.querySelectorAll("input")].find(
      (element) => element.getAttribute("placeholder") === "Search existing users by name or email",
    )!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "lee");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await eventually(() => expect(button("Add to Board")).toBeDefined());
    await act(async () => button("Add to Board")!.click());
    await eventually(() => expect(mocks.promoteInstanceAdmin).toHaveBeenCalledWith("lee"));
  });

  it("warns when the local placeholder still holds instance admin", async () => {
    mocks.listBoardMembers.mockResolvedValue({ members: [adminSeat], operatorUserId: null, legacySentinelHoldsAdmin: true });
    await renderPage();
    await eventually(() => expect(container.textContent).toContain("paperclipai auth board-claim-url"));
    expect(container.textContent).not.toContain("local-board");
  });
});
