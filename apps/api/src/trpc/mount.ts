import { trpcServer } from "@hono/trpc-server";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";

import type { Database } from "../db/client";
import { type AppEnv, INVALID_CREDENTIALS, type PrincipalSource, principalFrom } from "../http/principal";
import { MAX_BODY_BYTES } from "../http/router";
import { errorFields, type Logger } from "../log";
import { IDEMPOTENCY_KEY_HEADER, type TrpcContext } from "./init";
import { appRouter } from "./router";

export const TRPC_BASE_PATH = "/api/trpc";

/** tRPC at `/api/trpc`, next to the `/api/v1` contract routes, with the same credentials. */
export function mountTrpc(app: Hono<AppEnv>, options: { db: Database; logger: Logger; sources: readonly PrincipalSource[] }): void {
  const path = `${TRPC_BASE_PATH}/*`;

  app.use(path, async (c, next) => {
    c.header("Cache-Control", "no-store");
    // @hono/trpc-server answers with its own Response. With `c.res` created first, Hono merges the
    // headers set on the context (this one, a renewed session cookie) into that Response.
    void c.res;
    await next();
  });

  app.use(
    path,
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) =>
        c.json(
          { error: { message: "Request body too large", code: -32600, data: { code: "PAYLOAD_TOO_LARGE", httpStatus: 413, apiCode: "validation_failed" } } },
          413,
        ),
    }),
  );

  app.use(
    path,
    trpcServer({
      endpoint: TRPC_BASE_PATH,
      router: appRouter,
      createContext: async (opts, c): Promise<TrpcContext> => {
        const result = await principalFrom(c, options.sources);
        return {
          db: options.db,
          logger: options.logger,
          principal: result.status === "ok" ? result.principal : null,
          credentialError: result.status === "invalid" ? (result.message ?? INVALID_CREDENTIALS) : null,
          idempotencyKey: c.req.header(IDEMPOTENCY_KEY_HEADER),
          batchSize: opts.info.calls.length,
          resHeaders: opts.resHeaders,
        };
      },
      responseMeta: ({ errors }) =>
        errors.some((error) => error.code === "UNAUTHORIZED") ? { headers: { "WWW-Authenticate": 'Bearer realm="finance-api"' } } : {},
      onError: ({ error, path: procedure, type }) => {
        if (error.code !== "INTERNAL_SERVER_ERROR") return;
        options.logger.error("request_failed", { procedure, type, ...errorFields(error.cause ?? error) });
      },
    }),
  );
}
