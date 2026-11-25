/** Telegram shows "typing…" for about 5 seconds per call. */
const TYPING_INTERVAL_MS = 4_500;

/**
 * Keeps the typing indicator on until the returned function is called (call
 * it before sending the reply, or the next tick would show it again).
 * Failures are ignored: the indicator is cosmetic.
 */
export function startTyping(typing: (() => Promise<void>) | undefined, intervalMs = TYPING_INTERVAL_MS): () => void {
  if (!typing) return () => {};
  let stopped = false;
  const send = () => {
    if (!stopped) void typing().catch(() => {});
  };
  send();
  const timer = setInterval(send, intervalMs);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
