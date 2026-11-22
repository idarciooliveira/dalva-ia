# Deploy

<!-- The compose stack, images, secrets, backup and restore are documented by the deploy PR. This file holds only the
     Cutover section until then; keep it as its own section when merging. -->

## Cutover

Moves production from Convex + Vercel + the legacy agent to the compose stack, once. Users keep their passwords but sign in once. Linked Telegram chats stay linked; chat history is not migrated.

The data moves with `apps/api/scripts/migrate-from-convex.ts`. It reads a `npx convex export` zip (or its unzipped directory), maps every Convex id to a UUIDv7 built from `_creationTime` (a re-run gives the same ids), and writes users, password hashes, profiles, every finance table and channel identities in one transaction. It refuses a database that is not fully migrated or not empty. After the write it checks row counts, recomputes each account balance from its transactions, counts orphans and lone transfer legs, and verifies a sample of password hashes with Better Auth's verifier; any hard failure rolls everything back.

```bash
cd apps/api
DATABASE_URL=postgres://... bun run migrate:convex <export.zip> [--dry-run] [--drop-invalid] [--accept-lone-legs] [--report report.json]
```

- `--dry-run`: full validation. With `DATABASE_URL` it also writes, verifies and rolls back; without it, only the export is checked.
- `--drop-invalid`: drop rows whose NOT NULL reference is dangling or another user's (`subcategories.category_id`, `goal_contributions.goal_id`, `debt_payments.debt_id`) instead of failing.
- `--accept-lone-legs`: import lone outgoing transfer legs whose destination is gone (see below) with a warning instead of failing.
- Summary on stderr, JSON report (Convex ids and counts, no emails or names) on stdout or `--report`. Exit `0` ok, `1` errors, refused or verification failed, `2` usage.

What the import does with legacy data:

| Case | Result |
| --- | --- |
| Emails that differ only by case | One user, lowercase email. The one that signed in last keeps its password, profile and active Telegram link; all finance rows of both move to it. `email_case_merge` |
| User with no name | Profile name, else the email's local part. |
| Password hash not `<32 hex>:<128 hex>` | Error. |
| User with no password account | Imported without a credential (cannot sign in). `user_without_password` |
| Amount not a safe integer, date not a real `YYYY-MM-DD`, unknown enum value, NUL in text | Error. |
| Nullable reference to a missing row or another user's row | Null. `nulled_dangling_ref`, `nulled_cross_user_ref` |
| Same on a NOT NULL reference | Error, or the row is dropped with `--drop-invalid`. |
| Row whose user no longer exists | Skipped. `orphan_owner` |
| Lone transfer leg | Kept. `lone_transfer_leg` |
| Lone outgoing leg whose destination account is gone too | Error: it would read as incoming, so deleting it reverses the wrong sign. Delete it in Convex before the export, or accept it with `--accept-lone-legs`. `lone_outgoing_leg_without_destination` |
| Two active Telegram links for one user after a merge | The survivor's stays; the other is unlinked. `identity_unlinked` |
| Sessions, link codes, idempotency keys, agent chat state | Not migrated. |

Balance check: Convex never stored an opening balance as a transaction, so most accounts differ from the sum of their transactions. Those are listed under `balances.mismatches` and never fixed. The list to read is `balances.changedByImport`: accounts whose transactions add up differently than in Convex (a transaction lost its account, or a lone leg changed direction).

### 1. Rehearse

Days before, on a dev machine, never on a shared server. The export is production data: keep it on an encrypted disk and delete it, the reports and the scratch database when done.

Production is the Convex deployment Vercel production's `VITE_CONVEX_URL` points at. It is a `dev:` deployment, so `--prod` exports the wrong one, and a bare `convex export` uses whatever `packages/backend/.env.local` names (after `bun run setup`, the local one). Always name it:

```bash
git checkout <release sha>                       # the SHA the stack will run (API_IMAGE_TAG)
bun install --frozen-lockfile
export CONVEX_PROD=dev:<production deployment>   # Convex dashboard → production deployment → its name
(cd packages/backend && CONVEX_DEPLOYMENT=$CONVEX_PROD bunx convex export --path ~/dalva-cutover/rehearsal.zip)

docker run -d --rm --name dalva-import -e POSTGRES_USER=dalva -e POSTGRES_PASSWORD=dalva -e POSTGRES_DB=dalva \
  -p 127.0.0.1:55432:5432 postgres:18.7-alpine
export DATABASE_URL=postgres://dalva:dalva@127.0.0.1:55432/dalva
(cd apps/api && bun run db:migrate && bun run migrate:convex ~/dalva-cutover/rehearsal.zip --dry-run --report ~/dalva-cutover/rehearsal.json)
```

Check that `source.users` in the report matches the user count in the dashboard: a wrong deployment still passes every check. Every error must be fixed in Convex, or accepted with `--drop-invalid` / `--accept-lone-legs`, before the real run. Read `changedByImport`. Also check that `convex export` works while the deployment is paused (step 2); if it doesn't, plan to export right after unpausing with web and agent still down. Then `docker stop dalva-import`.

Bring up the production stack beforehand (the deploy steps in this file; the `backup restore` command and `dalva_backups` volume used below come from them) with an empty database (deploy steps, production hostname and bot) but without routing traffic to it.

### 2. Freeze

1. Web in maintenance: promote a maintenance page on Vercel production (`legacy-convex`).
2. Stop the legacy agent stack. The production webhook stays registered to it; Telegram queues updates for up to 24h.
3. Convex dashboard → the deployment in `$CONVEX_PROD` → Settings → Pause deployment. Open browser tabs can no longer write.

### 3. Export, migrate, verify

Same as the rehearsal from the repo root, with a fresh scratch database and no `--dry-run`:

```bash
(cd packages/backend && CONVEX_DEPLOYMENT=$CONVEX_PROD bunx convex export --path ~/dalva-cutover/cutover.zip)
# fresh dalva-import container, as in step 1
(cd apps/api && bun run db:migrate && bun run migrate:convex ~/dalva-cutover/cutover.zip --report ~/dalva-cutover/cutover.json)   # exit 0, "committed"
docker exec dalva-import pg_dump -U dalva -d dalva --format=custom --no-owner > ~/dalva-cutover/cutover.dump
```

Compare `cutover.json` with the rehearsal: same issue codes, counts grown only by what users did since. Then load the dump on the VPS:

```bash
scp ~/dalva-cutover/cutover.dump vps:/tmp/ && ssh vps
cd dalva/deploy
docker run --rm -v dalva_backups:/b -v /tmp:/in alpine cp /in/cutover.dump /b/ && rm /tmp/cutover.dump
docker compose stop api agent web
docker compose exec postgres psql -U dalva -d postgres -c 'drop database dalva with (force)'
docker compose run --rm backup restore cutover.dump dalva
docker compose up -d                              # migrate: Exited (0), nothing to apply
docker compose exec postgres psql -U dalva -d dalva -c \
  "select (select count(*) from users) users, (select count(*) from accounts) accounts, (select count(*) from transactions) transactions"
```

The counts must equal `verification.rowCounts` in `cutover.json`.

### 4. Switch

1. Point the production hostname at the tunnel (`web:8080`) instead of Vercel.
2. Re-register the production bot's webhook on the new URL, from the repo root on a dev machine, with the production values in the shell:
   ```bash
   set -a; . deploy/.env; set +a                  # a copy of the VPS's deploy/.env
   export AGENT_PUBLIC_URL="$PUBLIC_URL"
   cd apps/agent && bun run telegram:webhook:set && bun run telegram:webhook:info
   ```

### 5. Smoke test

Sign in as a real user with their existing password, check accounts and balances against Convex, add and delete a transaction, add and delete a transfer, send the bot a message from a linked chat and confirm a write. `docker compose logs api agent` shows no errors. Then announce that everyone signs in once.

### 6. Rollback window

Keep Convex (paused), the Vercel project, the legacy agent stack and `legacy-convex` untouched for two weeks. Delete the export, dumps and reports from the dev machine.

Rollback: web in maintenance on the new stack, unpause Convex, point the hostname back to Vercel and take the maintenance page down, start the legacy agent and re-register the webhook on its URL. Anything written on the new stack since cutover is lost; there is no sync back.
