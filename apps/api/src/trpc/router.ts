import { accountsRouter } from "./accounts";
import { router } from "./init";

export const appRouter = router({
  accounts: accountsRouter,
});

/** What clients import, type-only: `import type { AppRouter } from "@mpf/api/trpc"`. */
export type AppRouter = typeof appRouter;
export type { ApiErrorCode, ApiErrorData } from "./errors";
