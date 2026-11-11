import type { RichText } from "../channel";

/** Escape text for Telegram `parse_mode: "HTML"`. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function renderHtml(text: RichText): string {
  const parts = typeof text === "string" ? [text] : text;
  return parts
    .map((part) => {
      if (typeof part === "string") return escapeHtml(part);
      if ("bold" in part) return `<b>${escapeHtml(part.bold)}</b>`;
      if ("italic" in part) return `<i>${escapeHtml(part.italic)}</i>`;
      return `<code>${escapeHtml(part.code)}</code>`;
    })
    .join("");
}
