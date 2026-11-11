import { describe, expect, it } from "vitest";

import { collectSearchPage, decodeSearchCursor, type SearchPosition } from "../../domain/transactions";

type Row = { _id: string; date: string; _creationTime: number };

/** Synthetic index: newest first, ties on (date, _creationTime) kept in a fixed order. */
const row = (_id: string, date: string, _creationTime: number): Row => ({ _id, date, _creationTime });
const ROWS: Row[] = [
  row("a", "2026-05-02", 10),
  row("b", "2026-05-01", 7),
  row("c", "2026-05-01", 7),
  row("d", "2026-05-01", 7),
  row("e", "2026-05-01", 5),
  row("f", "2026-04-30", 9),
  row("g", "2026-04-30", 9),
  // A tie group larger than the cursor's id cap.
  ...Array.from({ length: 9 }, (_, i) => row(`h${i}`, "2026-04-29", 3)),
];

/** Mimics the two index ranges the domain builds from a cursor. */
function sourcesAfter(after: SearchPosition | null, rows: Row[] = ROWS) {
  async function* from(list: Row[]) {
    yield* list;
  }
  if (!after) return [() => from(rows)];
  return [
    () => from(rows.filter((r) => r.date === after.date && r._creationTime <= after.creationTime)),
    () => from(rows.filter((r) => r.date < after.date)),
  ];
}

async function pageAll(limit: number, scanLimit: number, matches: (r: Row) => boolean = () => true) {
  const seen: string[] = [];
  let cursor: string | null = null;
  let pages = 0;
  do {
    const after: SearchPosition | null = cursor ? decodeSearchCursor(cursor) : null;
    const page: { items: Row[]; nextCursor: string | null } = await collectSearchPage(sourcesAfter(after), after, { limit, scanLimit, matches });
    seen.push(...page.items.map((r) => r._id));
    cursor = page.nextCursor;
    if (++pages > 50) throw new Error("no progress");
  } while (cursor);
  return seen;
}

describe("transactions search paging", () => {
  it("never skips or repeats rows that tie on (date, _creationTime)", async () => {
    for (const limit of [1, 2, 3, 4, 7, 10]) {
      expect(await pageAll(limit, 1000)).toEqual(ROWS.map((r) => r._id));
    }
  });

  it("does not skip a tied row when an already-returned tied row is deleted between pages", async () => {
    const first = await collectSearchPage(sourcesAfter(null), null, { limit: 2, scanLimit: 1000, matches: () => true });
    expect(first.items.map((r) => r._id)).toEqual(["a", "b"]);
    const after = decodeSearchCursor(first.nextCursor!);
    const withoutB = ROWS.filter((r) => r._id !== "b");
    const second = await collectSearchPage(sourcesAfter(after, withoutB), after, { limit: 3, scanLimit: 1000, matches: () => true });
    expect(second.items.map((r) => r._id)).toEqual(["c", "d", "e"]);
  });

  it("makes progress under a tiny scan limit and with sparse matches", async () => {
    for (const scanLimit of [1, 2, 3]) {
      expect(await pageAll(10, scanLimit)).toEqual(ROWS.map((r) => r._id));
      expect(await pageAll(1, scanLimit, (r) => r._id === "c" || r._id === "g")).toEqual(["c", "g"]);
    }
  });

  it("rejects malformed cursors", () => {
    for (const bad of ["", "!!", btoa("[]"), btoa('["2026-01-01",1]'), btoa('["2026-01-01",1,0]'), btoa('["2026-01-01",1,3]'), btoa('["2026-01-01",1,[]]'), btoa('["2026-01-01",1,["a/b"]]'), btoa('[1,1,1]')]) {
      expect(() => decodeSearchCursor(bad)).toThrow("Invalid cursor");
    }
  });
});
