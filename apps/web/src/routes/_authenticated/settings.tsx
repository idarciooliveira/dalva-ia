import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";

import { AssistantSection } from "@/components/settings/assistant-section";
import { TelegramSection } from "@/components/settings/telegram-section";
import { instanceQuery } from "@/lib/api/queries";

export const Route = createFileRoute("/_authenticated/settings")({
  component: SettingsPage,
});

function SettingsPage() {
  // Only the instance owner gets the assistant setup; everyone else (and a failed read) sees nothing of it.
  const instance = useQuery(instanceQuery());
  const owner = instance.data?.owner ? instance.data : null;

  return (
    <div className="flex-1 overflow-auto">
      <div className="mx-auto max-w-200 px-3 py-4 sm:px-4 sm:py-6 lg:px-8">
        <div className="mb-4 sm:mb-6">
          <h2 className="font-heading text-xl font-semibold text-foreground sm:text-2xl">Settings</h2>
          <p className="mt-1 text-sm text-muted-foreground">Manage connected apps and how they use your data.</p>
        </div>
        {owner && <AssistantSection settings={owner} />}
        <TelegramSection />
      </div>
    </div>
  );
}
