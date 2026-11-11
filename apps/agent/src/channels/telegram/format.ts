import type { RichPart, RichText } from "../channel";

/** Escape text for Telegram `parse_mode: "HTML"`. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const partText = (part: RichPart): string => (typeof part === "string" ? part : Object.values(part)[0]!);

const withText = (part: RichPart, text: string): RichPart => {
  if (typeof part === "string") return text;
  if ("bold" in part) return { bold: text };
  if ("italic" in part) return { italic: text };
  return { code: text };
};

function renderPart(part: RichPart): string {
  if (typeof part === "string") return escapeHtml(part);
  if ("bold" in part) return `<b>${escapeHtml(part.bold)}</b>`;
  if ("italic" in part) return `<i>${escapeHtml(part.italic)}</i>`;
  return `<code>${escapeHtml(part.code)}</code>`;
}

export function renderHtml(text: RichText): string {
  return (typeof text === "string" ? [text] : text).map(renderPart).join("");
}

/** Raw characters per piece when a single line is too long: escaping grows text at most 6x (`"` -> `&quot;`). */
const HARD_SPLIT_CHARS = 600;

/**
 * Render to HTML chunks of at most `maxChars`. Splits only between lines, and
 * every line is rendered on its own, so tags and entities are never cut; a
 * single line too long for one message is cut between characters of its text.
 */
export function renderHtmlChunks(text: RichText, maxChars: number): string[] {
  // Split parts at newlines into lines of parts, keeping each part's format.
  const lines: RichPart[][] = [[]];
  for (const part of typeof text === "string" ? [text] : text) {
    partText(part)
      .split("\n")
      .forEach((segment, index) => {
        if (index > 0) lines.push([]);
        if (segment) lines[lines.length - 1]!.push(withText(part, segment));
      });
  }

  // Pieces joined by `sep` inside a chunk: "\n" between lines, "" inside a hard-split line.
  const pieces: Array<{ html: string; sep: string }> = [];
  for (const [index, line] of lines.entries()) {
    const sep = index === 0 ? "" : "\n";
    const html = line.map(renderPart).join("");
    if (html.length <= maxChars) {
      pieces.push({ html, sep });
      continue;
    }
    let first = true;
    for (const part of line) {
      const chars = Array.from(partText(part)); // code points: never split a surrogate pair
      for (let start = 0; start < chars.length; start += HARD_SPLIT_CHARS) {
        pieces.push({ html: renderPart(withText(part, chars.slice(start, start + HARD_SPLIT_CHARS).join(""))), sep: first ? sep : "" });
        first = false;
      }
    }
  }

  const chunks: string[] = [];
  let current = "";
  for (const { html, sep } of pieces) {
    if (current && current.length + sep.length + html.length > maxChars) {
      chunks.push(current);
      current = html;
    } else {
      current = current ? current + sep + html : html;
    }
  }
  chunks.push(current);
  // Telegram rejects empty or whitespace-only texts.
  const sendable = chunks.filter((chunk) => chunk.trim().length > 0);
  return sendable.length > 0 ? sendable : ["…"];
}
