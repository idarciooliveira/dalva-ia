import { useMutation, useQuery } from "@tanstack/react-query";
import { convexQuery, useConvexAction, useConvexMutation } from "@convex-dev/react-query";
import { api } from "@mpf/backend/convex/_generated/api";
import type { Id } from "@mpf/backend/convex/_generated/dataModel";
import { Check, Copy, ExternalLink, Link2Off, MessageCircle, RefreshCw, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";

/** Telegram bot usernames: 5-32 chars of [A-Za-z0-9_]. Anything else is treated as not configured. */
function botUsername(): string | null {
  const env = (import.meta as unknown as { env: Record<string, string | undefined> }).env;
  const value = env.VITE_TELEGRAM_BOT_USERNAME?.replace(/^@/, "").trim();
  return value && /^[A-Za-z0-9_]{5,32}$/.test(value) ? value : null;
}

const linkedDate = (ms: number) =>
  new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

export function TelegramSection() {
  const { data: links, isLoading } = useQuery(convexQuery(api.channelLinks.listMine, {}));
  const telegram = links?.find((link) => link.channel === "telegram");

  return (
    <section aria-labelledby="telegram-heading" className="rounded-xl border border-border">
      <div className="flex items-start gap-3 border-b border-border px-4 py-4 sm:px-5">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent text-accent-foreground">
          <MessageCircle className="size-4.5" />
        </div>
        <div className="min-w-0">
          <h3 id="telegram-heading" className="text-base font-semibold text-foreground">
            Telegram
          </h3>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Check balances and log transactions by chatting with the DALVA bot.
          </p>
        </div>
      </div>

      <div className="px-4 py-4 sm:px-5">
        {isLoading ? (
          <div className="space-y-3">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-9 w-40" />
          </div>
        ) : telegram ? (
          <LinkedTelegram link={telegram} />
        ) : (
          <ConnectTelegram />
        )}
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/*  Not linked: consent, then a single-use link                               */
/* -------------------------------------------------------------------------- */

function ConnectTelegram() {
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<{ code: string; expiresAt: number } | null>(null);

  const { mutateAsync: createLinkCode, isPending } = useMutation({
    mutationFn: useConvexAction(api.channelLinks.createLinkCode),
  });

  const connect = async () => {
    setError("");
    try {
      setPending(await createLinkCode({ channel: "telegram", consent }));
    } catch {
      setError("Couldn't create a link. Please try again.");
    }
  };

  return (
    <div className="space-y-4">
      <div className="rounded-lg bg-muted/40 p-3 text-sm text-foreground sm:p-4">
        <p className="font-medium">Before you connect</p>
        <ul className="mt-2 list-disc space-y-1.5 pl-5 text-muted-foreground">
          <li>
            Your messages to the bot, and the finance data it needs to answer them (accounts, balances, transactions,
            categories, goals and debts), are processed by Telegram and by an AI provider.
          </li>
          <li>The bot can add and edit transactions for you. You can switch it to read-only after connecting.</li>
          <li>You can unlink at any time, here or from the bot. The bot loses access right away.</li>
        </ul>
      </div>

      <div className="flex items-start gap-3">
        <Checkbox
          id="telegram-consent"
          checked={consent}
          onCheckedChange={(checked) => setConsent(checked === true)}
          disabled={pending !== null}
          className="mt-0.5"
        />
        <Label htmlFor="telegram-consent" className="text-sm leading-snug font-normal text-foreground">
          I understand and agree that my messages and finance data are shared with Telegram and an AI provider.
        </Label>
      </div>

      {pending ? (
        <PendingLink
          code={pending.code}
          expiresAt={pending.expiresAt}
          onRegenerate={() => void connect()}
          regenerating={isPending}
        />
      ) : (
        <div className="flex justify-end">
          <Button variant="accent" size="default" disabled={!consent || isPending} onClick={() => void connect()}>
            {isPending ? "Connecting..." : "Connect Telegram"}
          </Button>
        </div>
      )}

      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}

function useSecondsLeft(expiresAt: number) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);
  return Math.max(0, Math.ceil((expiresAt - now) / 1000));
}

function PendingLink({
  code,
  expiresAt,
  onRegenerate,
  regenerating,
}: {
  code: string;
  expiresAt: number;
  onRegenerate: () => void;
  regenerating: boolean;
}) {
  const bot = botUsername();
  const secondsLeft = useSecondsLeft(expiresAt);
  const [copied, setCopied] = useState(false);
  const command = `/start ${code}`;
  const expired = secondsLeft === 0;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopied(false);
    }
  };

  if (expired) {
    return (
      <div className="space-y-3 border-t border-border pt-4">
        <p className="text-sm text-muted-foreground">This link expired. Create a new one to connect.</p>
        <div className="flex justify-end">
          <Button variant="accent" size="default" disabled={regenerating} onClick={onRegenerate}>
            <RefreshCw className="mr-1.5 size-4" />
            New link
          </Button>
        </div>
      </div>
    );
  }

  const minutes = Math.floor(secondsLeft / 60);
  const seconds = String(secondsLeft % 60).padStart(2, "0");

  return (
    <div className="space-y-3 border-t border-border pt-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-foreground">
          {bot ? "Open the bot in Telegram and press Start." : "Send this message to the DALVA bot in Telegram."}
        </p>
        <p className="text-xs text-muted-foreground tabular-nums" aria-live="polite">
          Expires in {minutes}:{seconds}
        </p>
      </div>

      {bot && (
        <Button asChild variant="accent" size="default" className="w-full sm:w-auto">
          <a href={`https://t.me/${bot}?start=${code}`} target="_blank" rel="noopener noreferrer">
            <ExternalLink className="mr-1.5 size-4" />
            Open Telegram
          </a>
        </Button>
      )}

      <div>
        <p className="mb-1.5 text-xs text-muted-foreground">
          {bot ? (
            <>
              Link not working? Send this message to <span className="font-medium">@{bot}</span>:
            </>
          ) : (
            "Message to send:"
          )}
        </p>
        <div className="flex items-center gap-2 border-b border-border pb-2">
          <code className="min-w-0 flex-1 truncate font-mono text-sm text-foreground" data-testid="telegram-start-command">
            {command}
          </code>
          <Button variant="outline" size="sm" onClick={() => void copy()} aria-label="Copy start command">
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
            <span className="ml-1">{copied ? "Copied" : "Copy"}</span>
          </Button>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        This link works once. This page updates when the bot confirms the connection.
      </p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Linked: status, read-only, unlink                                         */
/* -------------------------------------------------------------------------- */

interface TelegramLink {
  _id: Id<"channelIdentities">;
  username?: string;
  linkedAt: number;
  readOnly: boolean;
}

function LinkedTelegram({ link }: { link: TelegramLink }) {
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState("");

  const { mutateAsync: setReadOnly, isPending: savingReadOnly } = useMutation({
    mutationFn: useConvexMutation(api.channelLinks.setReadOnly),
  });
  const { mutateAsync: unlink, isPending: unlinking } = useMutation({
    mutationFn: useConvexMutation(api.channelLinks.unlink),
  });

  const toggleReadOnly = async (readOnly: boolean) => {
    setError("");
    try {
      await setReadOnly({ identityId: link._id, readOnly });
    } catch {
      setError("Couldn't update the setting. Please try again.");
    }
  };

  const confirmUnlink = async () => {
    setError("");
    try {
      await unlink({ identityId: link._id });
    } catch {
      setError("Couldn't unlink Telegram. Please try again.");
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm">
        <ShieldCheck className="size-4 text-wise-positive" />
        <span className="font-medium text-foreground">
          Connected{link.username ? ` as @${link.username}` : ""}
        </span>
        <span className="text-muted-foreground">· since {linkedDate(link.linkedAt)}</span>
      </div>

      <div className="flex items-center justify-between gap-4 border-y border-border py-3">
        <div className="min-w-0">
          <Label htmlFor="telegram-read-only" className="text-sm font-medium text-foreground">
            Read-only
          </Label>
          <p className="mt-0.5 text-xs text-muted-foreground">
            The bot can answer questions but can't add, edit or delete anything.
          </p>
        </div>
        <Switch
          id="telegram-read-only"
          checked={link.readOnly}
          disabled={savingReadOnly}
          onCheckedChange={(checked) => void toggleReadOnly(checked)}
        />
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex justify-end">
        <Button variant="outline" size="default" disabled={unlinking} onClick={() => setConfirmOpen(true)}>
          <Link2Off className="mr-1.5 size-4" />
          Unlink Telegram
        </Button>
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unlink Telegram?</AlertDialogTitle>
            <AlertDialogDescription>
              The bot stops answering and loses access to your finances right away. You can connect again later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void confirmUnlink()}>
              Unlink
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
