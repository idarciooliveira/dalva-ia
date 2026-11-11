import { describe, expect, it } from "vitest";

import { collectSearchPage, decodeSearchCursor, type SearchPosition } from "../../domain/transactions";

type Row = { id: string; date: string; _creationTime: number };

/** Synthetic index: newest first, ties on (date, _creationTime) kept in a fixed order. */
const ROWS: Row[] = [
  { id: "a", date: "2026-05-02", _creationTime: 10 },
  { id: "b", date: "2026-05-01", _creationTime: 7 },
  { id: "c", date: "2026-05-01", _creationTime: 7 },
  { id: "d", date: "2026-05-01", _creationTime: 7 },
  { id: "e", date: "2026-05-01", _creationTime: 5 },
  { id: "f", date: "2026-04-30", _creationTime: 9 },
  { id: "g", date: "2026-04-30", _creationTime: 9 },
];

/** Mimics the two index ranges the domain builds from a cursor. */
function sourcesAfter(after: SearchPosition | null) {
  async function* from(rows: Row[]) {
    yield* rows;
  }
  if (!after) return [() => from(ROWS)];
  return [
    () => from(ROWS.filter((r) => r.date === after.date && r._creationTime <= after.creationTime)),
    () => from(ROWS.filter((r) => r.date < after.date)),
  ];
}

async function pageAll(limit: number, scanLimit: number, matches: (r: Row) => boolean = () => true) {
  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const after: SearchPosition | null = cursor ? decodeSearchCursor(cursor) : null;
    const page: { items: Row[]; nextCursor: string | null } = await collectSearchPage(sourcesAfter(after), after, { limit, scanLimit, matches });
    seen.push(...page.items.map((r) => r.id));
    cursor = page.nextCursor;
    if (++pages > 50) throw new Error("no progress");
  } while (cursor);
  return seen;
}

describe("transactions search paging", () => {
  it("never skips or repeats rows that tie on (date, _creationTime)", async () => {
    for (const limit of [1, 2, 3, 4, 7, 10]) {
      expect(await pageAll(limit, 1000)).toEqual(ROWS.map((r) => r.id));
    }
  });

  it("makes progress under a tiny scan limit and with sparse matches", async () => {
    for (const scanLimit of [1, 2, 3]) {
      expect(await pageAll(10, scanLimit)).toEqual(ROWS.map((r) => r.id));
      expect(await pageAll(1, scanLimit, (r) => r.id === "c" || r.id === "g")).toEqual(["c", "g"]);
    }
  });

  it("rejects malformed cursors", () => {
    for (const bad of ["", "!!", btoa("[]"), btoa('["2026-01-01",1]'), btoa('["2026-01-01",1,0]'), btoa('[1,1,1]')]) {
      expect(() => decodeSearchCursor(bad)).toThrow("Invalid cursor");
    }
  });
});
