/**
 * Encryption at rest for secrets the owner enters in the web app (bot token,
 * AI provider key) and the generated webhook secret. AES-256-GCM with a key
 * derived (HKDF-SHA256, own purpose label) from `BETTER_AUTH_SECRET`, so there
 * is nothing to configure. Each value is bound to its column (`label`, the
 * GCM additional data): a sealed token can't be read back as a key.
 *
 * Rotating `BETTER_AUTH_SECRET` makes every stored secret unreadable: `open`
 * returns null and the owner enters them again.
 */
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const SEGMENT_RE = /^[A-Za-z0-9_-]+$/;

export interface SecretBox {
  /** `v1.<iv>.<ciphertext>.<tag>`, base64url. */
  seal(plaintext: string, label: string): string;
  /** The plaintext, or null when the value is malformed or sealed under another key or label. */
  open(sealed: string, label: string): string | null;
}

export function deriveSecretBoxKey(authSecret: string): Buffer {
  return Buffer.from(hkdfSync("sha256", authSecret, "", "dalva:instance-settings-secrets", 32));
}

export function createSecretBox(authSecret: string): SecretBox {
  const key = deriveSecretBoxKey(authSecret);
  return {
    seal(plaintext, label) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(Buffer.from(label, "utf8"));
      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      return [VERSION, iv, ciphertext, cipher.getAuthTag()].map((part) => (typeof part === "string" ? part : part.toString("base64url"))).join(".");
    },
    open(sealed, label) {
      const parts = sealed.split(".");
      if (parts.length !== 4 || parts[0] !== VERSION || !parts.slice(1).every((part) => SEGMENT_RE.test(part))) return null;
      const [iv, ciphertext, tag] = parts.slice(1).map((part) => Buffer.from(part, "base64url")) as [Buffer, Buffer, Buffer];
      if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) return null;
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, iv);
        decipher.setAAD(Buffer.from(label, "utf8"));
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
      } catch {
        return null;
      }
    },
  };
}
