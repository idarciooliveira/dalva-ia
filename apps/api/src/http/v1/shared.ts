import { isUuid } from "../../db/ids";
import type { Account } from "../../domain/accounts";
import { invalid } from "../../domain/errors";
import type { UserProfile } from "../../domain/userProfiles";
import { toMoney } from "./money";

/* Ids ---------------------------------------------------------------------- */

/** Contract-valid id -> row id. One that can't be a row id is `validation_failed`, as Convex's `normalizeId`. */
export function toId(value: string, field: string): string {
  if (!isUuid(value)) throw invalid(field, `Invalid ${field}`);
  return value;
}

/* Dates -------------------------------------------------------------------- */

export const todayUtc = () => new Date().toISOString().slice(0, 10);

/** Instants travel as ISO 8601 strings. */
export const iso = (date: Date) => date.toISOString();

/* DTOs: optional fields omitted (never null), `archived` only when true ----- */

function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}

export const accountDto = (a: Account) =>
  compact({
    id: a.id,
    name: a.name,
    type: a.type,
    balance: toMoney(a.balance, a.currency),
    theme: a.theme ?? undefined,
    icon: a.icon ?? undefined,
    description: a.description ?? undefined,
    archived: a.archived || undefined,
  });

export const profileDto = (p: UserProfile) =>
  compact({
    name: p.name ?? undefined,
    baseCurrency: p.baseCurrency,
    onboardingCompleted: p.onboardingCompleted,
  });
