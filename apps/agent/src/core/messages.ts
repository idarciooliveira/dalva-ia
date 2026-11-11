import type { RichPart, RichText } from "../channels/channel";

const COMMANDS: RichPart[] = [
  { code: "/balance" },
  " your account balances\n",
  { code: "/forget" },
  " delete this chat's history\n",
  { code: "/unlink" },
  " disconnect this chat from DALVA\n",
  { code: "/help" },
  " show this list",
];

const HOW_TO_LINK: RichPart[] = [
  "To connect, open DALVA → ",
  { bold: "Settings → Telegram" },
  ", create a link code and tap the link (or send ",
  { code: "/start <code>" },
  " here).",
];

export const texts = {
  welcomeUnlinked: (): RichText => [{ bold: "Welcome to DALVA." }, "\n\n", ...HOW_TO_LINK],
  welcomeBack: (name?: string): RichText => [
    { bold: name ? `Welcome back, ${name}.` : "Welcome back." },
    "\n\nThis chat is connected to DALVA. Commands:\n",
    ...COMMANDS,
  ],
  notLinked: (): RichText => ["This chat isn't connected to DALVA yet.\n\n", ...HOW_TO_LINK],
  help: (): RichText => [{ bold: "Commands" }, "\n", ...COMMANDS],
  helpUnlinked: (): RichText => [{ bold: "Commands" }, "\n", ...COMMANDS, "\n\n", ...HOW_TO_LINK],
  linked: (): RichText => [{ bold: "Connected." }, " This chat is now linked to your DALVA account.\n\n", ...COMMANDS],
  linkInvalid: (): RichText => [
    "That link code is invalid or has expired. Create a new one in DALVA → ",
    { bold: "Settings → Telegram" },
    ".",
  ],
  alreadyLinked: (): RichText => [
    "This Telegram account or your DALVA account is already connected. Send ",
    { code: "/unlink" },
    " here, or unlink in DALVA → ",
    { bold: "Settings → Telegram" },
    ", then try again.",
  ],
  privateOnly: (): RichText => "I only work in a private chat. Message me directly.",
  comingSoon: (): RichText => ["Chat is coming soon. For now I understand these commands:\n", ...COMMANDS],
  unknownCommand: (): RichText => ["I don't know that command.\n\n", ...COMMANDS],
  unlinked: (): RichText => "Disconnected. This chat is no longer linked to DALVA and its history was deleted.",
  forgotten: (): RichText => "Done. Your chat history with DALVA was deleted.",
  noAccounts: (): RichText => "You have no accounts yet. Add one in DALVA.",
  linkRevoked: (): RichText => ["This chat is no longer connected to DALVA.\n\n", ...HOW_TO_LINK],
  notAllowed: (): RichText => "This chat isn't allowed to do that. Check DALVA → Settings → Telegram.",
  rateLimited: (): RichText => "Too many requests. Please wait a moment and try again.",
  unavailable: (): RichText => "That isn't available right now. Please try again later.",
  failed: (): RichText => "Something went wrong. Please try again in a moment.",
  buttonUnavailable: () => "This action isn't available yet.",
};
