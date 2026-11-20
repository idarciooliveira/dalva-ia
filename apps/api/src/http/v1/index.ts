import type { Operations } from "../operation";
import { accountOperations } from "./accounts";
import { profileOperations } from "./profile";

/**
 * Every implemented `/api/v1` user route. Add a group here when its PR ports
 * it; the type requires every operation of the group's contract routes.
 */
export const operations = {
  accounts: accountOperations,
  profile: profileOperations,
} satisfies Operations;
