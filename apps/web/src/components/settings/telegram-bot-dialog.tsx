import { KeyRound } from "lucide-react";
import { useEffect, useState } from "react";

import { FormError } from "@/components/error-state";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { apiErrorMessage } from "@/lib/api/errors";
import { useApiMutation } from "@/lib/api/mutations";
import type { TelegramBotState } from "@/lib/api/types";

interface TelegramBotDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  current: TelegramBotState;
}

/** Paste a BotFather token. The API checks it with Telegram, finds the username and sets the webhook. */
export function TelegramBotDialog({ open, onOpenChange, current }: TelegramBotDialogProps) {
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const { mutateAsync: saveTelegram, isPending } = useApiMutation("instance", "saveTelegram");

  // The token lives only in this field: cleared whenever the dialog opens or closes.
  useEffect(() => {
    setToken("");
    setError("");
  }, [open]);

  async function handleSubmit() {
    setError("");
    if (!token.trim()) {
      setError("Paste the bot token from @BotFather");
      return;
    }
    try {
      await saveTelegram({ token: token.trim() });
      setToken("");
      onOpenChange(false);
    } catch (err) {
      setError(apiErrorMessage(err, "Couldn't save the bot. Try again."));
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md gap-0 overflow-hidden p-0 max-sm:max-w-[calc(100vw-1rem)]">
        <DialogHeader className="px-4 pt-4 pb-0 sm:px-5 sm:pt-5">
          <DialogTitle className="text-lg font-semibold">{current.status === "unset" ? "Set up the Telegram bot" : "Replace the bot token"}</DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">
            Create a bot with @BotFather and paste its token. DALVA checks it with Telegram and points the bot at this server.
          </DialogDescription>
        </DialogHeader>

        <form
          className="min-w-0 px-4 pt-3.5 pb-0 sm:px-5 sm:pt-4"
          onSubmit={(event) => {
            event.preventDefault();
            void handleSubmit();
          }}
        >
          <div className="flex items-center gap-3 border-b border-border py-3">
            <KeyRound className="size-5 shrink-0 text-muted-foreground" />
            <input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="123456789:AAH..."
              autoComplete="off"
              spellCheck={false}
              autoFocus
              className="min-w-0 flex-1 bg-transparent font-mono text-sm text-foreground outline-none placeholder:text-muted-foreground"
              aria-label="Bot token"
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "telegram-bot-form-error" : "telegram-bot-form-hint"}
            />
          </div>
          <p id="telegram-bot-form-hint" className="mt-2 text-xs text-muted-foreground">
            {current.status === "unset"
              ? "The token is stored encrypted and never shown again."
              : `Replaces @${current.botUsername}. The token is stored encrypted and never shown again.`}
          </p>

          <FormError id="telegram-bot-form-error" message={error} />

          <div className="mt-2 flex flex-col-reverse gap-2 py-4 sm:flex-row sm:items-center sm:justify-end sm:gap-3">
            <Button type="button" variant="outline" size="default" className="w-full sm:w-auto" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="accent" size="default" className="w-full sm:w-auto" disabled={isPending || !token.trim()}>
              {isPending ? "Checking with Telegram..." : "Save bot"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
