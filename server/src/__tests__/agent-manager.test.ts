import { describe, expect, it } from "vitest";
import {
  humanManagerMembershipIsActive,
  isHumanManagerRole,
} from "../services/agent-manager.js";

describe("agent-manager eligibility", () => {
  it("lets owners, admins, and operators manage agents but not viewers", () => {
    expect(isHumanManagerRole("owner")).toBe(true);
    expect(isHumanManagerRole("admin")).toBe(true);
    expect(isHumanManagerRole("operator")).toBe(true);
    // Legacy "member" normalizes to operator.
    expect(isHumanManagerRole("member")).toBe(true);
    expect(isHumanManagerRole("viewer")).toBe(false);
    // An unknown or missing role fails closed.
    expect(isHumanManagerRole(null)).toBe(false);
    expect(isHumanManagerRole("board")).toBe(false);
  });

  it("requires an active membership with a manager role", () => {
    expect(humanManagerMembershipIsActive({ status: "active", membershipRole: "owner" })).toBe(true);
    expect(humanManagerMembershipIsActive({ status: "suspended", membershipRole: "owner" })).toBe(false);
    expect(humanManagerMembershipIsActive({ status: "active", membershipRole: "viewer" })).toBe(false);
    expect(humanManagerMembershipIsActive(null)).toBe(false);
  });
});
