import { randomUUID } from "node:crypto";

import { createApp } from "../src/app";
import { createAuth } from "../src/auth/auth";
import type { SignInLimiter } from "../src/auth/sign-in-limit";
import { createUserTokens } from "../src/auth/tokens";
import { users } from "../src/db/schema";
import { agentRead, financeRead, router, serviceRead, webWriteNoKey } from "../src/trpc/init";
import { createSecretBox, type SecretBox } from "../src/auth/secret-box";
import type { TelegramBotApi } from "../src/telegram/bot-api";
import { fakeTelegram } from "./telegram";
import type { AnyTRPCRouter } from "@trpc/server";
import { createLogger, type Logger } from "../src/log";
import { testDb } from "./db";

export const TEST_PUBLIC_URL = "http://localhost:3000";
export const TEST_AUTH_SECRET = "test-secret-test-secret-test-secret-0123";
export const TEST_TOKEN_SECRET = "finance-api-test-secret-0123456789abcdef";
export const testTokens = createUserTokens(TEST_TOKEN_SECRET);
export const testSecretBox = createSecretBox(TEST_AUTH_SECRET);
export const TEST_SERVICE_KEY = "finance-api-test-service-key-fedcba9876543210";

export const silentLogger = createLogger({ level: "error", write: () => {} });

export function testApp(
  options: {
    publicUrl?: string;
    logger?: Logger;
    clientIpHeader?: string;
    signInLimiter?: SignInLimiter;
    /** A router in place of the API's (procedures built with the builders of `src/trpc/init.ts`). */
    router?: AnyTRPCRouter;
    serviceKey?: string | null;
    /** Default: a fresh `fakeTelegram()`. */
    telegram?: TelegramBotApi;
    secretBox?: SecretBox;
    onSecret?: (value: string) => void;
  } = {},
) {
  const logger = options.logger ?? silentLogger;
  const publicUrl = options.publicUrl ?? TEST_PUBLIC_URL;
  const auth = createAuth({ db: testDb(), logger, publicUrl, secret: TEST_AUTH_SECRET, clientIpHeader: options.clientIpHeader });
  const app = createApp({
    db: testDb(),
    logger,
    auth,
    tokens: testTokens,
    publicUrl,
    signInLimiter: options.signInLimiter,
    trpcRouter: options.router,
    serviceKey: options.serviceKey === null ? undefined : (options.serviceKey ?? TEST_SERVICE_KEY),
    secretBox: options.secretBox ?? testSecretBox,
    telegram: options.telegram ?? fakeTelegram(),
    onSecret: options.onSecret,
  });
  return { app, auth };
}

export async function createTestUser(email = `user-${randomUUID()}@example.com`): Promise<string> {
  const [row] = await testDb().insert(users).values({ name: "Test", email }).returning({ id: users.id });
  return row!.id;
}

/**
 * Procedures that answer who called, for credential tests: `probe.me`
 * (`finance:read`), `probe.write` (`finance:write`, web, no key),
 * `probe.agentOnly` (`agent:state`) and `probe.service` (the service key).
 */
export const probeRouter = router({
  probe: router({
    me: financeRead.query(({ ctx }) => ctx.user),
    write: webWriteNoKey.mutation(() => null),
    agentOnly: agentRead.query(() => null),
    service: serviceRead.query(() => ({ kind: "service" as const })),
  }),
});

/** The API error code of a response (`error.data.apiCode`). */
export async function apiCodeOf(response: Response): Promise<string | undefined> {
  return ((await response.json()) as { error?: { data?: { apiCode?: string } } }).error?.data?.apiCode;
}
