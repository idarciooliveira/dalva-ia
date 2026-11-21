import { FinanceApiError } from "@mpf/finance-contract";
import { describe, expect, it } from "vitest";

import { SessionError } from "../auth-client";
import { apiErrorMessage, GENERIC_ERROR, isTransientError, LegacyBackendError, OFFLINE_ERROR } from "./errors";

const err = (code: FinanceApiError["code"], message = "Server says", status: number | null = 400, details?: unknown) =>
  new FinanceApiError(code, message, status, details);

describe("apiErrorMessage", () => {
  it("maps codes to user-facing text", () => {
    expect(apiErrorMessage(err("network_error", "Request failed", null))).toBe(OFFLINE_ERROR);
    expect(apiErrorMessage(err("conflict", "Account has transactions", 409))).toBe("Account has transactions");
    expect(apiErrorMessage(err("validation_failed", "Invalid request", 400, { issues: [{ path: "name", message: "Too long" }] }))).toBe(
      "Too long",
    );
    expect(apiErrorMessage(err("internal", "boom", 500), "Couldn't save.")).toBe("Couldn't save.");
    expect(apiErrorMessage(err("invalid_response", "HTTP 502", 502))).toBe(OFFLINE_ERROR);
    expect(apiErrorMessage(err("invalid_response", "HTTP 500", 500))).toBe(OFFLINE_ERROR);
    expect(apiErrorMessage(err("forbidden", "Forbidden", 403))).toBe(GENERIC_ERROR);
    expect(apiErrorMessage(new Error("x"))).toBe(GENERIC_ERROR);
    expect(apiErrorMessage(new LegacyBackendError())).toMatch(/moving to the new backend/);
    expect(apiErrorMessage(new TypeError("Failed to fetch"))).toBe(OFFLINE_ERROR);
    expect(apiErrorMessage(new SessionError(502))).toBe(OFFLINE_ERROR);
  });
});

describe("isTransientError", () => {
  it("retries only failures that a retry can fix", () => {
    expect(isTransientError(err("network_error", "x", null))).toBe(true);
    expect(isTransientError(err("internal", "x", 500))).toBe(true);
    expect(isTransientError(err("invalid_response", "x", 502))).toBe(true);
    expect(isTransientError(err("invalid_response", "x", 200))).toBe(false);
    expect(isTransientError(err("validation_failed"))).toBe(false);
    expect(isTransientError(err("unauthorized", "x", 401))).toBe(false);
    expect(isTransientError(new LegacyBackendError())).toBe(false);
    // The session check: no answer, or the proxy without the API.
    expect(isTransientError(new TypeError("Failed to fetch"))).toBe(true);
    expect(isTransientError(new SessionError(502))).toBe(true);
    expect(isTransientError(new SessionError(400))).toBe(false);
  });
});
