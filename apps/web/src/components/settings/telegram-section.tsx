import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ChatLink } from "@mpf/finance-contract";
import { Check, Copy, ExternalLink, Link2Off, MessageCircle, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";

import { ErrorState, FormError } from "@/components/error-state";
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
import { apiErrorMessage, isApiError } from "@/lib/api/errors";
import { useApiMutation } from "@/lib/api/mutations";
import { queryKeys } from "@/lib/api/keys";
import { chatLinksQuery } from "@/lib/api/queries";

/** How often the page checks whether the bot redeemed the code (no live updates until SSE). */
const LINK_POLL_MS = 3_000;

const linkedDate = (iso: string) =>
  new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

export function TelegramSection() {
  const links = useQuery(chatLinksQuery());
  const telegram = links.data?.items.find((link) => link.channel === "telegram");
  // Validated by the API config (TELEGRAM_BOT_USERNAME); absent when unset.
  const bot = links.data?.botUsernames?.telegram ?? null;

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
        {links.isPending ? (
          <div className="space-y-3">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-9 w-40" />
          </div>
        ) : links.isError && !links.data ? (
          <ErrorState
            error={links.error}
            fallback="Couldn't load your Telegram connection."
            onRetry={() => void links.refetch()}
            className="py-8 sm:py-8"
          />
        ) : telegram ? (
          <LinkedTelegram link={telegram} />
        ) : (
          <ConnectTelegram bot={bot} />
        )}
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/*  Not linked: consent, then a single-use link                               */
/* -------------------------------------------------------------------------- */

function ConnectTelegram({ bot }: { bot: string | null }) {
  const [consent, setConsent] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState<{ code: string; expiresAt: number } | null>(null);
  const [waiting, setWaiting] = useState(false);

  // While the code is valid: the linked view replaces this one once the list has the link.
  useQuery({ ...chatLinksQuery(), refetchInterval: waiting ? LINK_POLL_MS : false });
  useEffect(() => {
    if (!pending) return;
    setWaiting(true);
    const timer = setTimeout(() => setWaiting(false), Math.max(0, pending.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [pending]);

  const queryClient = useQueryClient();
  const { mutateAsync: createLinkCode, isPending } = useApiMutation("chatLinks", "createCode");

  const connect = async () => {
    if (!consent || isPending) return;
    setError("");
    try {
      const { code, expiresAt } = await createLinkCode({ channel: "telegram", consent: true });
      setPending({ code, expiresAt: Date.parse(expiresAt) });
    } catch (err) {
      // `conflict`: linked meanwhile (e.g. in another tab); the refetch shows the linked view.
      if (isApiError(err, "conflict")) void queryClient.invalidateQueries({ queryKey: queryKeys.chatLinks.all() });
      else setError(apiErrorMessage(err, "Couldn't create a link. Please try again."));
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
          bot={bot}
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

      <FormError message={error} className="mt-0" />
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
  bot,
  code,
  expiresAt,
  onRegenerate,
  regenerating,
}: {
  bot: string | null;
  code: string;
  expiresAt: number;
  onRegenerate: () => void;
  regenerating: boolean;
}) {
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
          {bot
            ? "Open the bot in Telegram and press Start."
            : "Send this message to the DALVA bot in a private chat on Telegram."}
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
              Link not working? Send this message to <span className="font-medium">@{bot}</span> in a private chat:
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
        This link works once, and creating a new one cancels it. This page updates when the bot confirms the
        connection.
      </p>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  Linked: status, read-only, unlink                                         */
/* -------------------------------------------------------------------------- */

function LinkedTelegram({ link }: { link: ChatLink }) {
  const queryClient = useQueryClient();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyDeleted, setHistoryDeleted] = useState(false);
  const [error, setError] = useState("");

  const { mutateAsync: setReadOnly, isPending: savingReadOnly } = useApiMutation("chatLinks", "setReadOnly");
  const { mutateAsync: unlink, isPending: unlinking } = useApiMutation("chatLinks", "unlink");
  const { mutateAsync: deleteHistory, isPending: deletingHistory } = useApiMutation("chatHistory", "delete");

  const toggleReadOnly = async (readOnly: boolean) => {
    setError("");
    try {
      await setReadOnly({ id: link.id, readOnly });
    } catch (err) {
      // Unlinked meanwhile (from the bot, another tab): the refetch shows the connect view.
      if (isApiError(err, "not_found")) void queryClient.invalidateQueries({ queryKey: queryKeys.chatLinks.all() });
      else setError(apiErrorMessage(err, "Couldn't update the setting. Please try again."));
    }
  };

  const confirmDeleteHistory = async () => {
    setError("");
    setHistoryDeleted(false);
    try {
      await deleteHistory({});
      setHistoryDeleted(true);
    } catch (err) {
      setError(apiErrorMessage(err, "Couldn't delete chat history. Please try again."));
    }
  };

  const confirmUnlink = async () => {
    setError("");
    try {
      await unlink({ id: link.id });
    } catch (err) {
      // Unlinked meanwhile (from the bot, another tab): the refetch shows the connect view.
      if (isApiError(err, "not_found")) void queryClient.invalidateQueries({ queryKey: queryKeys.chatLinks.all() });
      else setError(apiErrorMessage(err, "Couldn't unlink Telegram. Please try again."));
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

      <div className="flex items-center justify-between gap-4 border-b border-border pb-3">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">Chat history</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            The bot remembers recent conversations and keeps pending confirmations for a short time. Conversations are deleted after 30 days without activity, or any time you choose.
          </p>
        </div>
        <Button variant="outline" size="default" disabled={deletingHistory} onClick={() => setHistoryOpen(true)}>
          <Trash2 className="mr-1.5 size-4" />
          Delete chat history
        </Button>
      </div>

      {historyDeleted && (
        <p role="status" className="text-sm text-muted-foreground">
          Chat history deleted.
        </p>
      )}
      <FormError message={error} className="mt-0" />

      <div className="flex justify-end">
        <Button variant="outline" size="default" disabled={unlinking} onClick={() => setConfirmOpen(true)}>
          <Link2Off className="mr-1.5 size-4" />
          Unlink Telegram
        </Button>
      </div>

      <AlertDialog open={historyOpen} onOpenChange={setHistoryOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete chat history?</AlertDialogTitle>
            <AlertDialogDescription>
              The bot forgets your past conversations and cancels any pending confirmations. Your accounts and
              transactions are not affected. This can't be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void confirmDeleteHistory()}>
              Delete history
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unlink Telegram?</AlertDialogTitle>
            <AlertDialogDescription>
              The bot loses access to your finances right away and your chat history is deleted. You can connect
              again later.
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
