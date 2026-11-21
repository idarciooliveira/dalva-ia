import { createHash } from "node:crypto";

/**
 * The Postgres id of a Convex document: a UUIDv7 whose timestamp is the
 * document's `_creationTime` (ms) and whose other bits come from a hash of the
 * table and Convex id. Same export, same ids: a re-run maps every row the same
 * way, and ids still sort by creation like `uuidv7()` ones.
 */
export function importId(table: string, convexId: string, creationTime: number): string {
  const ms = Math.floor(creationTime);
  if (!Number.isSafeInteger(ms) || ms < 0 || ms >= 2 ** 48) throw new Error(`creation time out of range: ${creationTime}`);
  const hash = createHash("sha256").update(`${table}\0${convexId}`).digest();
  const bytes = Buffer.alloc(16);
  bytes.writeUIntBE(ms, 0, 6);
  bytes[6] = 0x70 | (hash[0]! & 0x0f);
  bytes[7] = hash[1]!;
  bytes[8] = 0x80 | (hash[2]! & 0x3f);
  hash.copy(bytes, 9, 3, 10);
  return formatUuid(bytes);
}

/** A stable UUID (version 8, name-based) for a value that must become a `uuid` but isn't one. */
export function nameUuid(namespace: string, value: string): string {
  const bytes = createHash("sha256").update(`${namespace}\0${value}`).digest().subarray(0, 16);
  bytes[6] = 0x80 | (bytes[6]! & 0x0f);
  bytes[8] = 0x80 | (bytes[8]! & 0x3f);
  return formatUuid(bytes);
}

function formatUuid(bytes: Buffer): string {
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
