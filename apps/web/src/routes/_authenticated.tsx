import { createFileRoute, Outlet } from "@tanstack/react-router";
import { useState } from "react";

import { useDarkMode } from "@/hooks/use-dark-mode";
import { useAuthGuard } from "@/hooks/use-auth-guard";
import { useSignOut } from "@/hooks/use-session";
import { FullPageError } from "@/components/error-state";
import { AuthProfileContext } from "@/hooks/use-auth-profile";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  SidebarProvider,
  SidebarInset,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { DashboardSkeleton } from "@/components/skeleton/dashboard-skeleton";
import { AppSidebar } from "@/components/dashboard/app-sidebar";
import { FloatingActionMenu } from "@/components/dashboard/floating-action-menu";
import { TransactionFormDialog } from "@/components/transactions/transaction-form-dialog";
import { TransferFormDialog } from "@/components/transactions/transfer-form-dialog";

export const Route = createFileRoute("/_authenticated")({
  component: AuthenticatedLayout,
});

/**
 * Persistent layout route for all authenticated pages.
 *
 * Renders the sidebar, header bar, and auth guard ONCE. Child routes
 * (dashboard, accounts, transactions, categories) render inside <Outlet />
 * without remounting the layout on navigation.
 */
function AuthenticatedLayout() {
  const auth = useAuthGuard({ requireOnboarding: true });
  const signOut = useSignOut();
  const [signOutFailed, setSignOutFailed] = useState(false);
  const { isDark, toggle: toggleDark } = useDarkMode();

  // FAB quick-action dialog state
  const [fabDialogOpen, setFabDialogOpen] = useState(false);
  const [fabDialogType, setFabDialogType] = useState<"income" | "expense">(
    "expense",
  );
  const [transferDialogOpen, setTransferDialogOpen] = useState(false);

  if (auth.status === "error") {
    return <FullPageError error={auth.error} onRetry={auth.retry} />;
  }
  if (auth.status !== "ready") {
    return <DashboardSkeleton />;
  }

  function handleFabAction(type: "income" | "expense" | "transfer") {
    if (type === "transfer") {
      setTransferDialogOpen(true);
    } else {
      setFabDialogType(type);
      setFabDialogOpen(true);
    }
  }

  return (
    <AuthProfileContext.Provider value={auth.profile}>
      <TooltipProvider>
        <SidebarProvider>
          <AppSidebar
            onSignOut={() => {
              setSignOutFailed(false);
              void signOut().then((ok) => setSignOutFailed(!ok));
            }}
            onToggleDark={toggleDark}
            isDark={isDark}
            userName={auth.profile.name}
          />
          <SidebarInset>
            {/* Top bar */}
            <header className="sticky top-0 z-30 flex h-12 items-center gap-2.5 border-b border-border bg-background/80 px-3 backdrop-blur-md sm:h-14 sm:gap-3 sm:px-4 lg:px-8">
              <SidebarTrigger />
              {signOutFailed && (
                <p role="alert" className="text-sm text-destructive">
                  Couldn&apos;t sign out. Check your connection and try again.
                </p>
              )}
            </header>

            <Outlet />
          </SidebarInset>
        </SidebarProvider>

        {/* Floating quick-action pill -- visible on all authenticated pages */}
        <FloatingActionMenu onAction={handleFabAction} />

        {/* FAB Transaction Dialog */}
        <TransactionFormDialog
          open={fabDialogOpen}
          onOpenChange={setFabDialogOpen}
          transaction={null}
          defaultType={fabDialogType}
        />

        {/* FAB Transfer Dialog */}
        <TransferFormDialog
          open={transferDialogOpen}
          onOpenChange={setTransferDialogOpen}
          transfer={null}
        />
      </TooltipProvider>
    </AuthProfileContext.Provider>
  );
}
