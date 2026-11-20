import type { RouteDef, RouteParsedInput, UserRoutes } from "@mpf/finance-contract";
import type { z } from "zod";

import type { Tx } from "../db/tx";
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
 */
export type OperationHandler<R extends RouteDef> = (
  tx: Tx,
  user: UserPrincipal,
  input: RouteParsedInput<R>,
) => Promise<RouteResponse<R>>;

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
