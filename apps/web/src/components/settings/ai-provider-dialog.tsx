import { Cpu, KeyRound, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";

import { FormError } from "@/components/error-state";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { apiErrorMessage } from "@/lib/api/errors";
import { useApiMutation } from "@/lib/api/mutations";
import type { AiProvider, AiProviderState } from "@/lib/api/types";

export const AI_PROVIDERS: Array<{ value: AiProvider; label: string }> = [
  { value: "gateway", label: "Vercel AI Gateway" },
  { value: "openrouter", label: "OpenRouter" },
];

export const providerLabel = (provider: AiProvider) => AI_PROVIDERS.find((p) => p.value === provider)?.label ?? provider;

interface AiProviderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  current: AiProviderState;
}

/** Provider, model and key for the chat agent. The stored key can be kept (same provider, still readable). */
export function AiProviderDialog({ open, onOpenChange, current }: AiProviderDialogProps) {
  const [provider, setProvider] = useState<AiProvider>("gateway");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState("");
  const { mutateAsync: saveAi, isPending } = useApiMutation("instance", "saveAi");

  useEffect(() => {
    setProvider(current.status === "unset" ? "gateway" : current.provider);
    setModel(current.status === "unset" ? "" : current.model);
    setApiKey("");
    setError("");
  }, [open, current]);

  const canKeepKey = current.status === "configured" && current.provider === provider;

  async function handleSubmit() {
    setError("");
    if (!model.trim()) {
      setError("Enter the model id");
      return;
    }
    if (!apiKey.trim() && !canKeepKey) {
      setError("Enter the API key for this provider");
      return;
    }
    try {
      await saveAi({ provider, model: model.trim(), ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) });
      setApiKey("");
      onOpenChange(false);
    } catch (err) {
      setError(apiErrorMessage(err, "Couldn't save the AI provider. Try again."));
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md gap-0 overflow-hidden p-0 max-sm:max-w-[calc(100vw-1rem)]">
        <DialogHeader className="px-4 pt-4 pb-0 sm:px-5 sm:pt-5">
          <DialogTitle className="text-lg font-semibold">AI provider</DialogTitle>
          <DialogDescription className="text-sm text-muted-foreground">
            The model the Telegram assistant chats with. The key is stored encrypted and never shown again.
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
            <Sparkles className="size-5 shrink-0 text-muted-foreground" />
            <Select value={provider} onValueChange={(v) => setProvider(v as AiProvider)}>
              <SelectTrigger
                aria-label="Provider"
                className="h-auto w-full min-w-0 gap-1.5 rounded-full border-0 bg-muted/60 px-3 py-1.5 text-left text-sm font-medium shadow-none ring-0 focus:ring-0"
              >
                <SelectValue>{providerLabel(provider)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {AI_PROVIDERS.map((p) => (
                  <SelectItem key={p.value} value={p.value}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center gap-3 border-b border-border py-3">
            <Cpu className="size-5 shrink-0 text-muted-foreground" />
            <input
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="Model id, like vendor/model"
              autoComplete="off"
              spellCheck={false}
              autoFocus
              className="min-w-0 flex-1 bg-transparent font-mono text-sm text-foreground outline-none placeholder:font-sans placeholder:text-muted-foreground"
              aria-label="Model"
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "ai-provider-form-error" : undefined}
            />
          </div>

          <div className="flex items-center gap-3 border-b border-border py-3">
            <KeyRound className="size-5 shrink-0 text-muted-foreground" />
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={canKeepKey && current.status === "configured" ? `Keep the current key (…${current.keyHint})` : "API key"}
              autoComplete="off"
              spellCheck={false}
              className="min-w-0 flex-1 bg-transparent font-mono text-sm text-foreground outline-none placeholder:font-sans placeholder:text-muted-foreground"
              aria-label="API key"
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "ai-provider-form-error" : undefined}
            />
          </div>

          <FormError id="ai-provider-form-error" message={error} />

          <div className="mt-2 flex flex-col-reverse gap-2 py-4 sm:flex-row sm:items-center sm:justify-end sm:gap-3">
            <Button type="button" variant="outline" size="default" className="w-full sm:w-auto" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="accent" size="default" className="w-full sm:w-auto" disabled={isPending || !model.trim()}>
              {isPending ? "Saving..." : "Save"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
