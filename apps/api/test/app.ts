import { randomUUID } from "node:crypto";

import { createApp } from "../src/app";
import { createAuth } from "../src/auth/auth";
import type { SignInLimiter } from "../src/auth/sign-in-limit";
import { users } from "../src/db/schema";
import { createLogger, type Logger } from "../src/log";
import { testDb } from "./db";

export const TEST_PUBLIC_URL = "http://localhost:3000";
export const TEST_AUTH_SECRET = "test-secret-test-secret-test-secret-0123";

export const silentLogger = createLogger({ level: "error", write: () => {} });

/** The app as `main.ts` builds it, on the worker's database. Rate limits off unless a client IP header is given. */
export function testApp(
  options: { publicUrl?: string; logger?: Logger; clientIpHeader?: string; signInLimiter?: SignInLimiter } = {},
) {
  const logger = options.logger ?? silentLogger;
  const publicUrl = options.publicUrl ?? TEST_PUBLIC_URL;
  const auth = createAuth({ db: testDb(), logger, publicUrl, secret: TEST_AUTH_SECRET, clientIpHeader: options.clientIpHeader });
  return { app: createApp({ db: testDb(), logger, auth, publicUrl, signInLimiter: options.signInLimiter }), auth };
}

/** A user row (no credentials), for tests that only need an owner for domain rows. */
export async function createTestUser(email = `user-${randomUUID()}@example.com`): Promise<string> {
  const [row] = await testDb().insert(users).values({ name: "Test", email }).returning({ id: users.id });
  return row!.id;
}
