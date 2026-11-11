import { ConvexError } from "convex/values";
import { describe, expect, it } from "vitest";

import { ACCOUNT_IN_USE } from "../../domain/accounts";
import { mapDomainErrors, readApiErrorData } from "./errors";

describe("mapDomainErrors", () => {
  it("maps the account-in-use ConvexError to a conflict", async () => {
    const thrown = await mapDomainErrors(async () => {
      throw new ConvexError({ code: ACCOUNT_IN_USE, message: "Archive it instead" });
    }).catch((e: unknown) => e);
    expect(readApiErrorData(thrown)).toMatchObject({ code: "conflict", message: "Archive it instead" });
  });

  it("leaves other ConvexErrors untouched", async () => {
    const original = new ConvexError({ code: "OTHER", message: "x" });
    await expect(
      mapDomainErrors(async () => {
        throw original;
      }),
    ).rejects.toBe(original);
  });
});
