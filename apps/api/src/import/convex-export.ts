/**
 * Reads a `npx convex export` snapshot: the zip, or the directory it unzips
 * to. Each table is `<table>/documents.jsonl`, one document per line, with
 * `_id` and `_creationTime`. Component tables (`_components/...`), file
 * storage (`_storage`) and the table list (`_tables`) are not read.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { crc32, inflateRawSync } from "node:zlib";

/** A Convex document as exported. Field values are plain JSON. */
export interface ConvexDoc {
  _id: string;
  _creationTime: number;
  [field: string]: unknown;
}

/** Documents per top-level table, in file order. */
export type ConvexExport = Map<string, unknown[]>;

const TABLE_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
const DOCUMENTS_FILE = /^([A-Za-z][A-Za-z0-9_]*)\/documents\.jsonl$/;
const SCHEMA_FILE = /^([A-Za-z][A-Za-z0-9_]*)\/generated_schema\.jsonl$/;

export async function readConvexExport(path: string): Promise<ConvexExport> {
  const info = await stat(path);
  const files = info.isDirectory()
    ? await readDirectory(path)
    : readZip(await readFile(path), (name) => DOCUMENTS_FILE.test(name) || SCHEMA_FILE.test(name));
  const tables: ConvexExport = new Map();
  for (const [name, content] of files) {
    const match = DOCUMENTS_FILE.exec(name);
    if (match) tables.set(match[1]!, parseJsonl(content, name));
  }
  for (const name of files.keys()) {
    // An exported table always has its documents file, empty for an empty table: this export is incomplete.
    const table = SCHEMA_FILE.exec(name)?.[1];
    if (table && !tables.has(table)) throw new Error(`${table}/documents.jsonl is missing: the export is incomplete`);
  }
  if (tables.size === 0) throw new Error("no <table>/documents.jsonl in the export: is this a `npx convex export`?");
  return tables;
}

async function readDirectory(root: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  for (const entry of await readdir(root, { withFileTypes: true })) {
    // `_storage`, `_components`, `_tables`: not tables, never read.
    if (!entry.isDirectory() || !TABLE_NAME.test(entry.name)) continue;
    for (const file of ["documents.jsonl", "generated_schema.jsonl"]) {
      const content = await readOptional(join(root, entry.name, file));
      if (content) files.set(`${entry.name}/${file}`, content);
    }
  }
  return files;
}

async function readOptional(file: string): Promise<Buffer | undefined> {
  return await readFile(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
}

function parseJsonl(content: Buffer, name: string): unknown[] {
  const docs: unknown[] = [];
  const lines = content.toString("utf8").split("\n");
  lines.forEach((line, index) => {
    if (line.trim() === "") return;
    try {
      docs.push(JSON.parse(line));
    } catch {
      throw new Error(`${name}:${index + 1}: not valid JSON`);
    }
  });
  return docs;
}

/* -------------------------------------------------------------------------- */
/*  Zip                                                                       */
/* -------------------------------------------------------------------------- */

const EOCD = 0x06054b50;
const ZIP64_EOCD_LOCATOR = 0x07064b50;
const ZIP64_EOCD = 0x06064b50;
const CENTRAL_ENTRY = 0x02014b50;
const LOCAL_HEADER = 0x04034b50;
const U32_MAX = 0xffffffff;

/**
 * The files of a zip that `wanted` selects (default all; stored or deflated,
 * zip64 and data descriptors included), CRC-checked. Enough for Convex
 * exports; encrypted and multi-disk archives are refused.
 */
export function readZip(zip: Buffer, wanted: (name: string) => boolean = () => true): Map<string, Buffer> {
  const eocd = findEocd(zip);
  let count = zip.readUInt16LE(eocd + 10);
  let directoryOffset: number = zip.readUInt32LE(eocd + 16);
  let disks = [zip.readUInt16LE(eocd + 4), zip.readUInt16LE(eocd + 6)];
  const locator = eocd - 20;
  if (locator >= 0 && zip.readUInt32LE(locator) === ZIP64_EOCD_LOCATOR) {
    // Zip64 writers may saturate every field of the classic record: the zip64 one is authoritative.
    const zip64 = Number(zip.readBigUInt64LE(locator + 8));
    if (zip.readUInt32LE(zip64) !== ZIP64_EOCD) throw new Error("zip: bad zip64 end of central directory");
    disks = [zip.readUInt32LE(zip64 + 16), zip.readUInt32LE(zip64 + 20)];
    count = Number(zip.readBigUInt64LE(zip64 + 32));
    directoryOffset = Number(zip.readBigUInt64LE(zip64 + 48));
  }
  if (disks.some((disk) => disk !== 0)) throw new Error("zip: multi-disk archives are not supported");

  const files = new Map<string, Buffer>();
  let at = directoryOffset;
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(at) !== CENTRAL_ENTRY) throw new Error("zip: bad central directory entry");
    const flags = zip.readUInt16LE(at + 8);
    const method = zip.readUInt16LE(at + 10);
    const crc = zip.readUInt32LE(at + 16);
    let compressedSize: number = zip.readUInt32LE(at + 20);
    let size: number = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    let localOffset: number = zip.readUInt32LE(at + 42);
    const name = zip.toString("utf8", at + 46, at + 46 + nameLength);

    // Zip64 extra field: the 64-bit values, in this order, for each field saturated above.
    const extra = zip.subarray(at + 46 + nameLength, at + 46 + nameLength + extraLength);
    for (let e = 0; e + 4 <= extra.length; ) {
      const id = extra.readUInt16LE(e);
      const length = extra.readUInt16LE(e + 2);
      if (id === 0x0001) {
        let field = e + 4;
        const next = () => {
          const value = Number(extra.readBigUInt64LE(field));
          field += 8;
          return value;
        };
        if (size === U32_MAX) size = next();
        if (compressedSize === U32_MAX) compressedSize = next();
        if (localOffset === U32_MAX) localOffset = next();
      }
      e += 4 + length;
    }
    at += 46 + nameLength + extraLength + commentLength;

    if (name.endsWith("/") || !wanted(name)) continue;
    if (flags & 0x1) throw new Error(`zip: ${name} is encrypted`);
    if (zip.readUInt32LE(localOffset) !== LOCAL_HEADER) throw new Error(`zip: bad local header for ${name}`);
    const dataStart = localOffset + 30 + zip.readUInt16LE(localOffset + 26) + zip.readUInt16LE(localOffset + 28);
    const raw = zip.subarray(dataStart, dataStart + compressedSize);
    let content: Buffer;
    if (method === 0) content = Buffer.from(raw);
    else if (method === 8) content = inflateRawSync(raw);
    else throw new Error(`zip: ${name} uses unsupported compression method ${method}`);
    if (content.length !== size || crc32(content) !== crc) throw new Error(`zip: ${name} is corrupt (size or CRC mismatch)`);
    if (files.has(name)) throw new Error(`zip: ${name} appears twice`);
    files.set(name, content);
  }
  return files;
}

function findEocd(zip: Buffer): number {
  // The record is 22 bytes plus a comment of up to 64 KiB, at the very end.
  // Its comment length must end it exactly at the end of the file: a signature inside a comment is not it.
  for (let at = zip.length - 22; at >= Math.max(0, zip.length - 22 - 0xffff); at--) {
    if (zip.readUInt32LE(at) === EOCD && at + 22 + zip.readUInt16LE(at + 20) === zip.length) return at;
  }
  throw new Error("not a zip file (no end of central directory)");
}
