import { TRPCClientError } from "@trpc/client";
import { describe, expect, it } from "vitest";

import { SessionError } from "../auth-client";
import { apiErrorMessage, GENERIC_ERROR, isApiError, isTransientError, OFFLINE_ERROR } from "./errors";

/** An error the API answered: its code on `data.apiCode`. */
const answered = (apiCode: string, message = "Server says", httpStatus = 400, details?: unknown) =>
  TRPCClientError.from({ error: { message, code: -32600, data: { apiCode, httpStatus, ...(details ? { details } : {}) } } } as never);
/** No API answer: the proxy (or nothing) answered with `status`. */
const proxied = (status: number) =>
  new TRPCClientError("Unable to transform response from server", { meta: { response: new Response("<html>", { status }) } });
const offline = () => TRPCClientError.from(new TypeError("Failed to fetch"));

describe("apiErrorMessage", () => {
  it("maps codes to user-facing text", () => {
    expect(apiErrorMessage(offline())).toBe(OFFLINE_ERROR);
    expect(apiErrorMessage(answered("conflict", "Account has transactions", 409))).toBe("Account has transactions");
    expect(apiErrorMessage(answered("validation_failed", "Invalid request", 400, { issues: [{ path: "name", message: "Too long" }] }))).toBe(
      "Too long",
    );
    expect(apiErrorMessage(answered("internal", "Internal error", 500), "Couldn't save.")).toBe("Couldn't save.");
    expect(apiErrorMessage(proxied(502))).toBe(OFFLINE_ERROR);
    expect(apiErrorMessage(proxied(500))).toBe(OFFLINE_ERROR);
    expect(apiErrorMessage(answered("forbidden", "Forbidden", 403))).toBe(GENERIC_ERROR);
    expect(apiErrorMessage(new Error("x"))).toBe(GENERIC_ERROR);
    expect(apiErrorMessage(new TypeError("Failed to fetch"))).toBe(OFFLINE_ERROR);
    expect(apiErrorMessage(new SessionError(502))).toBe(OFFLINE_ERROR);
  });

  it("reads the code from the error data", () => {
    expect(isApiError(answered("not_found", "Account not found", 404), "not_found")).toBe(true);
    expect(isApiError(offline(), "network_error")).toBe(true);
    expect(isApiError(new Error("x"), "network_error")).toBe(false);
  });
});

describe("isTransientError", () => {
  it("retries only failures that a retry can fix", () => {
    expect(isTransientError(offline())).toBe(true);
    expect(isTransientError(answered("internal", "x", 500))).toBe(true);
    expect(isTransientError(proxied(502))).toBe(true);
    expect(isTransientError(proxied(200))).toBe(false);
    expect(isTransientError(answered("validation_failed"))).toBe(false);
    expect(isTransientError(answered("unauthorized", "x", 401))).toBe(false);
    // The session check: no answer, or the proxy without the API.
    expect(isTransientError(new TypeError("Failed to fetch"))).toBe(true);
    expect(isTransientError(new SessionError(502))).toBe(true);
    expect(isTransientError(new SessionError(400))).toBe(false);
  });
});
