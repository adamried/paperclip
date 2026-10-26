import { describe, expect, it } from "vitest";
import {
  updateAdminUserSchema,
  updateCompanyMemberWithPermissionsSchema,
  updateCurrentUserProfileSchema,
} from "@paperclipai/shared";

describe("access validators", () => {
  it("accepts HTTP(S) and Paperclip asset image URLs", () => {
    expect(updateCurrentUserProfileSchema.safeParse({
      name: "Ada Lovelace",
      image: "https://example.com/avatar.png",
    }).success).toBe(true);
    expect(updateCurrentUserProfileSchema.safeParse({
      name: "Ada Lovelace",
      image: "/api/assets/avatar/content",
    }).success).toBe(true);
  });

  it("rejects data URI profile images", () => {
    expect(updateCurrentUserProfileSchema.safeParse({
      name: "Ada Lovelace",
      image: "data:image/png;base64,AAAA",
    }).success).toBe(false);
  });

  it("defaults omitted combined member grants to an empty list", () => {
    const result = updateCompanyMemberWithPermissionsSchema.parse({
      membershipRole: "operator",
    });

    expect(result.grants).toEqual([]);
  });

  it("normalizes an admin user email patch to lowercase and requires at least one field", () => {
    expect(updateAdminUserSchema.parse({ email: "  Ada@Example.COM " })).toEqual({
      email: "ada@example.com",
    });
    expect(updateAdminUserSchema.parse({ name: " Ada Lovelace " })).toEqual({
      name: "Ada Lovelace",
    });
    expect(updateAdminUserSchema.safeParse({}).success).toBe(false);
    expect(updateAdminUserSchema.safeParse({ email: "not-an-email" }).success).toBe(false);
    expect(updateAdminUserSchema.safeParse({ name: "" }).success).toBe(false);
  });
});
