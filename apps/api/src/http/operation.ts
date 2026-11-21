import type { RouteDef, RouteParsedInput, ServiceRoutes, UserRoutes } from "@mpf/finance-contract";
import type { z } from "zod";

import type { UserTokens } from "../auth/tokens";
import type { Tx } from "../db/tx";
import type { DomainError } from "../domain/errors";
import type { UserPrincipal } from "./principal";

/** What a handler returns: the response schema's input side (plain-string ids). */
export type RouteResponse<R extends RouteDef> = z.input<R["response"]>;

/**
 * One contract operation. The router has already authenticated the caller,
 * checked the scope, the `Idempotency-Key` and the channel identity, and
 * validated `input` with the route's request schema. `tx` is the request's
 * transaction: a read-only snapshot for GET, the write's SERIALIZABLE
 * transaction otherwise (it may run more than once, see `withTx`).
 *
 * Filter every query by `user.userId`; never take a user id from `input`.
 *
 * Throwing rolls the transaction back. To keep the writes and still answer
 * with an error (an action marked `expired` on confirm), return
 * `commitThenFail(error)`: agent-store routes only, since a finance write
 * would store it as its idempotent replay.
 */
export type OperationHandler<R extends RouteDef> = (
  tx: Tx,
  user: UserPrincipal,
  input: RouteParsedInput<R>,
) => Promise<RouteResponse<R> | CommittedFailure>;

/** An error answered after the transaction commits (Convex's `handlerFailure`). */
export class CommittedFailure {
  constructor(readonly error: DomainError) {}
}

export const commitThenFail = (error: DomainError) => new CommittedFailure(error);

export interface Operation<R extends RouteDef = RouteDef> {
  route: R;
  handler: OperationHandler<R>;
}

/** Bind a handler to its contract route: `operation(routes.accounts.get, async (tx, user, input) => ...)`. */
export function operation<R extends RouteDef>(route: R, handler: OperationHandler<R>): Operation<R> {
  return { route, handler };
}

/**
 * User-route implementations, by contract group and operation. A group is
 * optional until its PR ports it (the router answers `not_found` meanwhile);
 * a group that is there must implement every operation of the contract.
 */
export type Operations = {
  [G in keyof UserRoutes]?: { [O in keyof UserRoutes[G]]: UserRoutes[G][O] extends RouteDef ? Operation<UserRoutes[G][O]> : never };
};

export function operationFor(operations: Operations, group: string, op: string): Operation | null {
  const ops = (operations as Record<string, Record<string, Operation> | undefined>)[group];
  return ops?.[op] ?? null;
}

/* Service routes (the agent's service key) ----------------------------------- */

/** What a service handler gets besides its transaction: no user, only server capabilities. */
export interface ServiceContext {
  /** Mints the user tokens `channelIdentities.resolve` hands out. */
  tokens: UserTokens;
}

/**
 * One service operation. Same contract as `OperationHandler` minus the user:
 * service routes act for no one, so each handler finds the user from server
 * state (the code row on redeem, the linked identity on resolve and unlink).
 */
export type ServiceHandler<R extends RouteDef> = (tx: Tx, ctx: ServiceContext, input: RouteParsedInput<R>) => Promise<RouteResponse<R>>;

export interface ServiceOperation<R extends RouteDef = RouteDef> {
  route: R;
  handler: ServiceHandler<R>;
}

export function serviceOperation<R extends RouteDef>(route: R, handler: ServiceHandler<R>): ServiceOperation<R> {
  return { route, handler };
}

export type ServiceOperations = {
  [G in keyof ServiceRoutes]?: {
    [O in keyof ServiceRoutes[G]]: ServiceRoutes[G][O] extends RouteDef ? ServiceOperation<ServiceRoutes[G][O]> : never;
  };
};

export function serviceOperationFor(operations: ServiceOperations, group: string, op: string): ServiceOperation | null {
  const ops = (operations as Record<string, Record<string, ServiceOperation> | undefined>)[group];
  return ops?.[op] ?? null;
}
