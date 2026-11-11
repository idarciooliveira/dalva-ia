import { cronJobs } from "convex/server";

import { internal } from "./_generated/api";

const crons = cronJobs();

// Finance API idempotency keys expire after 7 days.
crons.interval("purge finance api idempotency keys", { hours: 24 }, internal.api.v1.idempotency.purgeExpired, {});

export default crons;
