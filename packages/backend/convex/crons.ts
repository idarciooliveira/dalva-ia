import { cronJobs } from "convex/server";

import { internal } from "./_generated/api";

const crons = cronJobs();

// Finance API idempotency keys expire after 7 days.
crons.interval("purge finance api idempotency keys", { hours: 24 }, internal.api.v1.idempotency.purgeExpired, {});

// Channel link codes live 10 minutes; drop expired ones (used or not).
crons.interval("purge expired channel link codes", { hours: 1 }, internal.channelLinks.purgeExpiredCodes, {});

// Agent store retention (see agentStore.ts). Inbound events hold message text: gone 24h after their last update.
crons.interval("purge agent inbound events", { hours: 1 }, internal.agentStore.purgeInboundEvents, {});
crons.interval("expire agent pending actions", { minutes: 15 }, internal.agentStore.expirePendingActions, {});
// Sessions inactive for 30 days (with messages and actions), and finished actions of that age.
crons.interval("purge inactive agent history", { hours: 24 }, internal.agentStore.purgeInactiveHistory, {});

export default crons;
