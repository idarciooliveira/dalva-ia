import type { Channel } from "@mpf/finance-contract";

/**
 * Channel-agnostic types. Platform SDKs and payload shapes stay inside
 * `src/channels/<platform>/`; everything else talks to a `ChannelAdapter`.
 */

export type ChatType = "private" | "group" | "channel";
export type InboundKind = "text" | "command" | "button" | "photo";

export interface InboundEvent {
  channel: Channel;
  /** Platform event id, unique per channel (Telegram `update_id`). Dedupe key. */
  eventId: string;
  externalUserId: string;
  chatId: string;
  chatType: ChatType;
  kind: InboundKind;
  /** Message text, or the photo caption. */
  text?: string;
  /** Lowercase command name without the slash (`balance`). */
  command?: string;
  args?: string[];
  /** Opaque payload of a pressed button (see `encodeButtonPayload`). */
  buttonPayload?: string;
  /** Platform id of the button press, for `answerButton`. */
  buttonId?: string;
  username?: string;
}

/** Inline formatting the adapter renders for its platform (and escapes). */
export type RichPart = string | { bold: string } | { italic: string } | { code: string };
export type RichText = string | RichPart[];

export type OutboundMessage =
  | { type: "text"; text: RichText }
  | { type: "confirm"; text: RichText; actionId: string }
  | { type: "typing" };

export interface ChatAddress {
  chatId: string;
}

/** What the transport did with a delivered raw event. */
export type DeliverResult = "accepted" | "ignored" | "dropped" | "overloaded";
export type Deliver = (raw: unknown) => DeliverResult;

/** Room left in the pipeline, so a pulling transport never fetches more than it can queue. */
export interface IntakeCapacity {
  available(): number;
  /** Resolves when `available() > 0`. */
  wait(): Promise<void>;
}

export interface WebhookIngress {
  /** HTTP path the platform posts to, e.g. `/webhooks/telegram`. */
  path: string;
  /** Authenticate and hand the body to `deliver`. Must answer fast. */
  handle(request: Request, deliver: Deliver): Promise<Response>;
}

export interface ChannelAdapter {
  readonly id: Channel;
  /** Platform payload -> event, or null for payloads the agent ignores. Never throws. */
  parse(raw: unknown): InboundEvent | null;
  send(to: ChatAddress, message: OutboundMessage): Promise<void>;
  /** Acknowledge a button press (stops the client spinner). */
  answerButton(buttonId: string, text?: string): Promise<void>;
  /** Present in webhook mode. */
  readonly webhook?: WebhookIngress;
  /** Start pulling events (polling mode). Resolves once started. */
  start(deliver: Deliver, capacity: IntakeCapacity): Promise<void>;
  /** Stop pulling events. */
  stop(): Promise<void>;
}

export type ButtonAction = "confirm" | "cancel";

/** `c:<actionId>` / `x:<actionId>`: short, so it fits Telegram's 64-byte callback data. */
export function encodeButtonPayload(action: ButtonAction, actionId: string): string {
  return `${action === "confirm" ? "c" : "x"}:${actionId}`;
}

export function decodeButtonPayload(payload: string): { action: ButtonAction; actionId: string } | null {
  const match = /^([cx]):([A-Za-z0-9_-]{1,128})$/.exec(payload);
  if (!match) return null;
  return { action: match[1] === "c" ? "confirm" : "cancel", actionId: match[2]! };
}
