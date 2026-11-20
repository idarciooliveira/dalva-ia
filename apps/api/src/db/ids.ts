const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Row ids are UUIDs, written lowercase as Postgres prints them. The contract
 * accepts any URL-safe id, so check before a value reaches a `uuid` column:
 * Postgres would fail the query (22P02) instead of matching nothing. Only the
 * canonical form passes, so one row has one id string (idempotency hashes the
 * request as sent).
 */
export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}
