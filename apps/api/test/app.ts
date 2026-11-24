import { randomUUID } from "node:crypto";

import { createApp } from "../src/app";
import { createAuth } from "../src/auth/auth";
import type { SignInLimiter } from "../src/auth/sign-in-limit";
import { createUserTokens } from "../src/auth/tokens";
import { users } from "../src/db/schema";
import type { Operations, ServiceOperations } from "../src/http/operation";
import type { OperationSettings } from "../src/http/v1";
import { createLogger, type Logger } from "../src/log";
import { testDb } from "./db";

export const TEST_PUBLIC_URL = "http://localhost:3000";
export const TEST_AUTH_SECRET = "test-secret-test-secret-test-secret-0123";
export const TEST_TOKEN_SECRET = "finance-api-test-secret-0123456789abcdef";
export const testTokens = createUserTokens(TEST_TOKEN_SECRET);
export const TEST_SERVICE_KEY = "finance-api-test-service-key-fedcba9876543210";

export const silentLogger = createLogger({ level: "error", write: () => {} });

export function testApp(
  options: {
    publicUrl?: string;
    logger?: Logger;
    clientIpHeader?: string;
    signInLimiter?: SignInLimiter;
    operations?: Operations;
    serviceOperations?: ServiceOperations;
    serviceKey?: string | null;
    operationSettings?: OperationSettings;
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
    operations: options.operations,
    serviceOperations: options.serviceOperations,
    serviceKey: options.serviceKey === null ? undefined : (options.serviceKey ?? TEST_SERVICE_KEY),
    operationSettings: options.operationSettings,
  });
  return { app, auth };
}

export async function createTestUser(email = `user-${randomUUID()}@example.com`): Promise<string> {
  const [row] = await testDb().insert(users).values({ name: "Test", email }).returning({ id: users.id });
  return row!.id;
}
