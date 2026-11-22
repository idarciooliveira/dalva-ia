import { describe, expect, it } from "vitest";

import { authErrorMessage } from "./auth-errors";

describe("authErrorMessage", () => {
  it("keeps the old copy for Better Auth codes", () => {
    expect(authErrorMessage({ status: 422, code: "USER_ALREADY_EXISTS" }, "signUp")).toMatch(/already exists/);
    expect(authErrorMessage({ status: 401, code: "INVALID_EMAIL_OR_PASSWORD" }, "signIn")).toBe(
      "Invalid email or password. Please try again.",
    );
    expect(authErrorMessage({ status: 429, code: "TOO_MANY_ATTEMPTS" })).toMatch(/Too many attempts/);
    expect(authErrorMessage({ status: 429 })).toMatch(/Too many attempts/);
  });

  it("falls back per flow, and says when the server is unreachable", () => {
    expect(authErrorMessage({ status: 400, code: "SOMETHING_NEW" }, "signUp")).toBe("Unable to create account. Please try again.");
    expect(authErrorMessage({ status: 502 }, "signIn")).toMatch(/Can't reach DALVA/);
    expect(authErrorMessage(new TypeError("Failed to fetch"), "signIn")).toMatch(/Can't reach DALVA/);
  });
});
