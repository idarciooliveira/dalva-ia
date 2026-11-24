import { describe, expect, it } from "vitest";
import { z } from "zod";

import { raw, seedUser, tokenFor } from "../../test/api";
import { testApp } from "../../test/app";
import { ACCOUNT_IN_USE_MESSAGE } from "../domain/accounts";
import { conflict, DomainError, invalid, notFound } from "../domain/errors";
import { createLogger } from "../log";
import { financeRead, router } from "./init";

/** The app with an `accounts.list` that throws `error`. */
function throwing(error: unknown) {
  const lines: Array<Record<string, unknown>> = [];
  const logger = createLogger({ level: "debug", write: (line) => lines.push(JSON.parse(line)) });
  const list = financeRead.input(z.object({}).optional()).query(() => {
    throw error;
  });
  const { app } = testApp({ logger, router: router({ accounts: router({ list }) }) });
  return { app, lines };
}

describe("errors", () => {
  it("maps a DomainError to its code, message, details and status", async () => {
    const token = await tokenFor(await seedUser());
    const cases = [
      [notFound("Account"), 404, { code: "not_found", message: "Account not found" }],
      [conflict(ACCOUNT_IN_USE_MESSAGE), 409, { code: "conflict", message: ACCOUNT_IN_USE_MESSAGE }],
      [
        invalid("amount.currency", "Currency must be USD, got EUR"),
        400,
        {
          code: "validation_failed",
          message: "Currency must be USD, got EUR",
          details: { issues: [{ path: "amount.currency", message: "Currency must be USD, got EUR" }] },
        },
      ],
      [new DomainError("rate_limited", "Slow down", { retryAfter: 1 }), 429, { code: "rate_limited", message: "Slow down", details: { retryAfter: 1 } }],
    ] as const;
    for (const [error, status, body] of cases) {
      const response = await raw(throwing(error).app, "accounts.list", {}, { token });
      expect(response.status).toBe(status);
      expect(response.body).toEqual({ ok: false, error: body });
    }
  });

  it("answers anything else with a bare 500, logged without its message", async () => {
    const token = await tokenFor(await seedUser());
    const { app, lines } = throwing(Object.assign(new Error("relation secret_table: password=hunter2"), { code: "42P01" }));
    const response = await app.request(`/api/trpc/accounts.list?input=${encodeURIComponent("{}")}`, { headers: { authorization: `Bearer ${token}` } });
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(JSON.parse(body)).toEqual({
      error: { message: "Internal error", code: -32603, data: { code: "INTERNAL_SERVER_ERROR", httpStatus: 500, path: "accounts.list", apiCode: "internal" } },
    });
    expect(body).not.toContain("hunter2");
    expect(lines).toEqual([expect.objectContaining({ level: "error", msg: "request_failed", errorName: "Error", errorCode: "42P01" })]);
    expect(JSON.stringify(lines)).not.toContain("hunter2");
  });
});
