import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Bot, RefreshCw, Sparkles, Trash2 } from "lucide-react";
import { useState } from "react";

import { FormError } from "@/components/error-state";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { apiErrorMessage } from "@/lib/api/errors";
import { useApiMutation } from "@/lib/api/mutations";
import { telegramStatusQuery } from "@/lib/api/queries";
import type { AiProviderState, InstanceSettings, TelegramBotState } from "@/lib/api/types";

import { AiProviderDialog, providerLabel } from "./ai-provider-dialog";
import { TelegramBotDialog } from "./telegram-bot-dialog";

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

/**
 * The instance owner's settings: the Telegram bot and the AI provider the chat
 * agent runs with. Rendered only for the owner (`instance.get` says so).
 * Secrets are write-only: the page shows their last 4 characters at most.
 */
export function AssistantSection({ settings }: { settings: InstanceSettings }) {
  return (
    <section aria-labelledby="assistant-heading" className="mb-4 rounded-xl border border-border sm:mb-6">
      <div className="flex items-start gap-3 border-b border-border px-4 py-4 sm:px-5">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
          <Bot className="size-4.5" />
        </div>
        <div className="min-w-0">
          <h3 id="assistant-heading" className="text-base font-semibold text-foreground">
            Assistant setup
          </h3>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Only you see this, as the owner of this DALVA. The chat agent picks up changes within seconds.
          </p>
        </div>
      </div>
      <div className="divide-y divide-border">
        <TelegramBotRow state={settings.telegram} />
        <AiProviderRow state={settings.ai} />
      </div>
    </section>
  );
}

function Unreadable({ what }: { what: string }) {
  return (
    <p role="status" className="mt-1.5 flex items-start gap-1.5 text-xs text-destructive">
      <AlertTriangle className="mt-px size-3.5 shrink-0" />
      <span>The saved {what} can't be read: the server's BETTER_AUTH_SECRET changed. Enter it again.</span>
    </p>
  );
}

/* -------------------------------------------------------------------------- */
/*  Telegram bot                                                              */
/* -------------------------------------------------------------------------- */

function TelegramBotRow({ state }: { state: TelegramBotState }) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const { mutateAsync: removeTelegram, isPending: removing } = useApiMutation("instance", "removeTelegram");

  const confirmRemove = async () => {
    setError("");
    setNotice("");
    try {
      const { webhookDeleted } = await removeTelegram({});
      if (!webhookDeleted && state.status === "configured" && state.delivery === "webhook") {
        setNotice("Bot removed. Telegram didn't confirm the webhook removal; delete it in @BotFather if the bot still gets messages.");
      }
    } catch (err) {
      setError(apiErrorMessage(err, "Couldn't remove the bot. Try again."));
    }
  };

  return (
    <div className="px-4 py-4 sm:px-5" data-testid="telegram-bot-settings">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">Telegram bot</p>
          {state.status === "unset" ? (
            <p className="mt-0.5 text-sm text-muted-foreground">Not set up. Users can't link Telegram until you add a bot.</p>
          ) : (
            <>
              <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
                <span className="font-medium text-foreground">@{state.botUsername}</span>
                <span>· token …{state.tokenHint}</span>
                <Badge variant="outline">{state.delivery === "webhook" ? "Webhook" : "Polling (local dev)"}</Badge>
              </p>
              {state.status === "unreadable" && <Unreadable what="token" />}
            </>
          )}
        </div>
        <div className="flex shrink-0 gap-2">
          {state.status !== "unset" && (
            <Button variant="outline" size="default" disabled={removing} onClick={() => setRemoveOpen(true)}>
              <Trash2 className="mr-1.5 size-4" />
              Remove bot
            </Button>
          )}
          <Button variant={state.status === "configured" ? "outline" : "accent"} size="default" onClick={() => setDialogOpen(true)}>
            {state.status === "unset" ? "Set up bot" : state.status === "unreadable" ? "Enter token" : "Replace bot"}
          </Button>
        </div>
      </div>

      {state.status === "configured" && <WebhookStatus />}
      {notice && (
        <p role="status" className="mt-3 text-sm text-muted-foreground">
          {notice}
        </p>
      )}
      <FormError message={error} />

      <TelegramBotDialog open={dialogOpen} onOpenChange={setDialogOpen} current={state} />

      <AlertDialog open={removeOpen} onOpenChange={setRemoveOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove the Telegram bot?</AlertDialogTitle>
            <AlertDialogDescription>
              DALVA deletes the bot's webhook and forgets its token. The bot stops answering. Linked chats stay linked and work
              again once a bot is set up.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => void confirmRemove()}>
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** `getWebhookInfo`, read through the API: where Telegram delivers, what's queued, the last failure. */
function WebhookStatus() {
  const status = useQuery(telegramStatusQuery());

  return (
    <div className="mt-3 rounded-lg bg-muted/40 p-3 text-sm" data-testid="telegram-webhook-status">
      <div className="flex items-center justify-between gap-2">
        <p className="font-medium text-foreground">Delivery status</p>
        <Button
          variant="ghost"
          size="sm"
          className="gap-1.5"
          disabled={status.isFetching}
          onClick={() => void status.refetch()}
          aria-label="Refresh delivery status"
        >
          <RefreshCw className={status.isFetching ? "size-3.5 animate-spin" : "size-3.5"} />
          Refresh
        </Button>
      </div>
      {status.isPending ? (
        <div className="mt-2 space-y-2">
          <Skeleton className="h-3.5 w-2/3" />
          <Skeleton className="h-3.5 w-1/3" />
        </div>
      ) : status.isError ? (
        <p className="mt-1 text-destructive">{apiErrorMessage(status.error, "Couldn't read the status from Telegram.")}</p>
      ) : status.data.status === "error" ? (
        <p className="mt-1 text-destructive">Telegram didn't answer: {status.data.message}</p>
      ) : status.data.status === "ok" ? (
        <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-muted-foreground">
          <dt>Webhook</dt>
          <dd className="min-w-0 truncate font-mono text-xs leading-5 text-foreground">
            {status.data.webhookUrl ?? (status.data.delivery === "polling" ? "none (the agent polls)" : "not set")}
          </dd>
          <dt>Pending updates</dt>
          <dd className="text-foreground tabular-nums">{status.data.pendingUpdateCount}</dd>
          <dt>Last error</dt>
          <dd className={status.data.lastErrorMessage ? "text-destructive" : "text-foreground"}>
            {status.data.lastErrorMessage
              ? `${status.data.lastErrorAt ? `${when(status.data.lastErrorAt)}: ` : ""}${status.data.lastErrorMessage}`
              : "none"}
          </dd>
        </dl>
      ) : null}
      {status.data?.status === "ok" && status.data.delivery === "webhook" && !status.data.webhookMatches && (
        <p className="mt-2 flex items-start gap-1.5 text-xs text-destructive">
          <AlertTriangle className="mt-px size-3.5 shrink-0" />
          The webhook doesn't point at this DALVA. Replace the bot with the same token to set it again.
        </p>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/*  AI provider                                                               */
/* -------------------------------------------------------------------------- */

function AiProviderRow({ state }: { state: AiProviderState }) {
  const [dialogOpen, setDialogOpen] = useState(false);

  return (
    <div className="px-4 py-4 sm:px-5" data-testid="ai-provider-settings">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-sm font-medium text-foreground">
            <Sparkles className="size-3.5 text-muted-foreground" />
            AI provider
          </p>
          {state.status === "unset" ? (
            <p className="mt-0.5 text-sm text-muted-foreground">Not set up. The bot answers commands only, no chat.</p>
          ) : (
            <>
              <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
                <span className="font-medium text-foreground">{providerLabel(state.provider)}</span>
                <span className="font-mono text-xs">{state.model}</span>
                <span>· key …{state.keyHint}</span>
              </p>
              {state.status === "unreadable" && <Unreadable what="API key" />}
            </>
          )}
        </div>
        <Button
          variant={state.status === "configured" ? "outline" : "accent"}
          size="default"
          className="shrink-0"
          onClick={() => setDialogOpen(true)}
        >
          {state.status === "unset" ? "Set up AI provider" : state.status === "unreadable" ? "Enter key" : "Change AI provider"}
        </Button>
      </div>
      <AiProviderDialog open={dialogOpen} onOpenChange={setDialogOpen} current={state} />
    </div>
  );
}
