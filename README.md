# SRLINES Multi-Market Google Maps Lead Pipeline — PostgreSQL Edition

This repository contains an n8n workflow for the **United Kingdom, Italy, Spain, and the United Arab Emirates**. The workflow now stores operational data in a PostgreSQL database on the same VPS as n8n instead of Google Sheets. This removes the Google Sheets 60-read-requests-per-minute-per-user bottleneck, gives writes transaction semantics, and adds indexes for suppression and email-history lookups.

PostgreSQL is used rather than an n8n SQLite community node: PostgreSQL has a maintained core n8n node, supports concurrent workflow executions, and remains modest on a small single-VPS deployment.

## Repository contents

- `SRLINES Ultimate 6-in-1 Google Maps AI Lead Pipeline.json` — importable n8n workflow with 11 PostgreSQL nodes and no Google Sheets nodes.
- `database/init.sql` — idempotent tables, constraints, grants, and query indexes.
- `SRLINES Ultimate 6-in-1 Google Maps AI Lead Pipeline.xlsx` — legacy data template; it is no longer used by the workflow.
- `googlemaps-scraper/` — scraper service required by the workflow.

## 1. Install PostgreSQL on the n8n VPS

The following commands are for Ubuntu/Debian. Run them as a sudo-capable VPS user:

```bash
sudo apt-get update
sudo apt-get install -y postgresql postgresql-contrib
sudo systemctl enable --now postgresql
sudo systemctl status postgresql --no-pager
```

Keep PostgreSQL private. When n8n runs directly on the host, retain PostgreSQL's default loopback-only listener and do **not** open port 5432 in UFW or the cloud firewall.

Create a randomly generated password, the restricted application role, and its database. Substitute the generated password in both commands; do not commit it:

```bash
openssl rand -base64 32
sudo -u postgres psql -v ON_ERROR_STOP=1 <<'SQL'
CREATE ROLE n8n_leads LOGIN PASSWORD 'REPLACE_WITH_RANDOM_PASSWORD';
CREATE DATABASE n8n_leads OWNER n8n_leads;
SQL
```

Initialize the schema from this repository. `init.sql` is safe to run again after pulling an update:

```bash
sudo -u postgres psql --set ON_ERROR_STOP=1 --dbname=n8n_leads --file=/workspace/n8n-workflows/database/init.sql
sudo -u postgres psql --dbname=n8n_leads --command='\dt'
```

Test the application login (the prompt asks for the password):

```bash
psql 'host=127.0.0.1 port=5432 dbname=n8n_leads user=n8n_leads sslmode=prefer' -c 'SELECT current_database(), current_user;'
```

### If n8n itself runs in Docker

`127.0.0.1` inside the n8n container is the container, not the VPS. The cleanest same-instance setup is to run a PostgreSQL container on the same private Docker network and address it as `postgres`. Do not publish `5432:5432`:

```yaml
services:
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_DB: n8n_leads
      POSTGRES_USER: n8n_leads
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes:
      - postgres_data:/var/lib/postgresql/data
      - ./database/init.sql:/docker-entrypoint-initdb.d/10-leads.sql:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U n8n_leads -d n8n_leads"]
      interval: 10s
      timeout: 5s
      retries: 5
  n8n:
    image: docker.n8n.io/n8nio/n8n:2.8.4 # or keep your currently tested pin
    # keep the existing n8n volumes, ports, and environment
    depends_on:
      postgres:
        condition: service_healthy

volumes:
  postgres_data:
```

The included health check prevents n8n from starting before PostgreSQL accepts connections. Docker initialization scripts only run when the data volume is empty; on an existing volume apply upgrades with `docker compose exec -T postgres psql -U n8n_leads -d n8n_leads < database/init.sql`.

## 2. Create the n8n PostgreSQL credential

1. Open **Credentials → Add credential → Postgres** in n8n.
2. Use host `127.0.0.1` when n8n is installed directly on the VPS, or `postgres` when both services share the Docker Compose network.
3. Enter database `n8n_leads`, user `n8n_leads`, the generated password, and port `5432`.
4. Set SSL to **Disable** only for loopback/private Docker-network traffic. If the database is ever remote, require TLS and validate its CA instead.
5. Save it as **Lead Pipeline PostgreSQL** and run **Test connection**.

## 3. Import and connect the workflow

1. Back up/export the currently active workflow, then deactivate it so the old and new workflows cannot send duplicate messages.
2. Import `SRLINES Ultimate 6-in-1 Google Maps AI Lead Pipeline.json` as a new workflow.
3. Open each of its 11 Postgres nodes, select **Lead Pipeline PostgreSQL**, and save. n8n intentionally does not receive a committed credential ID or password.
4. Attach the existing **SES SMTP account** credential to both email nodes and verify the scraper configuration in **Runtime Config**.
5. There is no Google Sheet ID and no Google OAuth credential to configure. `Reply_Log` and `Blacklist` are now the `reply_log` and `blacklist` tables.
6. Run a manual seed-list execution. Inspect each Postgres node and confirm rows with the verification queries below before activation.

The history readers only retrieve the last 180 days, matching the configured cooldown and bounding n8n memory use. Database indexes make email suppression lookups independent of Google API quotas. The write nodes use positional parameters rather than interpolating lead content into SQL.

## 4. Verification, operations, and backups

```bash
sudo -u postgres psql -d n8n_leads -c 'SELECT count(*) FROM keywords;'
sudo -u postgres psql -d n8n_leads -c 'SELECT status, count(*) FROM email_history GROUP BY status;'
sudo -u postgres psql -d n8n_leads -c 'SELECT * FROM campaign_report ORDER BY date DESC LIMIT 5;'
```

Create an off-VPS encrypted backup job before production. A basic logical backup is:

```bash
sudo install -d -m 0700 /var/backups/n8n-leads
sudo -u postgres pg_dump --format=custom n8n_leads > /var/backups/n8n-leads/n8n_leads_$(date -u +%F).dump
```

Test restores periodically on a separate database. Monitor disk space, PostgreSQL logs, failed n8n executions, bounces, complaints, and suppressions. PostgreSQL fixes the Sheets 429 error, but it does not make outbound email compliance or delivery-event ingestion optional.

## 5. Optional one-time migration from Google Sheets

Do not run the old Sheets workflow while migrating. Export each populated tab as CSV, copy it to a directory readable by PostgreSQL, and import into its corresponding table with `\copy`. The table mappings are `Keywords → keywords`, `Qualified_Leads → qualified_leads`, `Email_History → email_history`, `Campaign_Report → campaign_report`, `Reply_Log → reply_log`, `Followup_Queue → followup_queue`, and `Blacklist → blacklist`.

Example from a shell whose current user can read the CSV:

```bash
psql 'host=127.0.0.1 dbname=n8n_leads user=n8n_leads' \
  -c "\copy email_history FROM '/absolute/path/Email_History.csv' WITH (FORMAT csv, HEADER true)"
```

Import parent/history data before activating the new workflow. Deduplicate `id` in `Email_History` and `email` in `Followup_Queue` first because those columns are database keys. Keep the CSV header order identical to `database/init.sql`, or provide an explicit quoted column list to `\copy`.

## Deploy the Google Maps scraper

The VPS or instance needs Node.js and npm. Playwright also needs its Chromium browser and system dependencies. From the repository root, run:

```bash
cd googlemaps-scraper
npm install
npx playwright install chromium
```

Review `.env` before starting the service, especially `PORT`, `HEADLESS`, timeouts, rate limits, and `DATA_DIR`. Ensure that the configured data and log directories exist and are writable by the service account. For a quick foreground start, run:

```bash
npm start
```

For a persistent production process, install PM2 and use the included configuration:

```bash
npm install --global pm2
pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

Run the command printed by `pm2 startup` if PM2 asks you to do so. Restrict network access to the scraper so only n8n or trusted hosts can reach it; the service does not define API authentication. Verify the deployment from the same network context as n8n:

```bash
curl http://localhost:3000/api/health
```

Set `scraper.baseUrl` in the workflow's **Runtime Config** to the reachable URL, for example `http://localhost:3000` when both services share a host or `http://localhost:3000` when that is the scraper's container/DNS name. Do not use `localhost` when n8n runs in a separate container or machine, because it would refer to n8n itself. Keep a single scraper process—the supplied PM2 configuration intentionally uses one instance to preserve its in-memory queue.

## Reply, bounce, complaint, and unsubscribe operations

SMTP sending cannot search the reply mailbox. Before every scheduled follow-up run, synchronize replies into `reply_log` and delivery failures/complaints/unsubscribes into `blacklist` using an external inbound-mail or SES event workflow.

- `reply_log.email` must contain the normalized recipient address.
- In `blacklist`, use `type=email`, the normalized address in `value`, an active `status`, and a clear `reason` such as `bounce`, `complaint`, or `unsubscribe`.
- For domain-wide suppression, the current workflow requires individual email rows; do not assume `type=domain` is enforced.
- Treat synchronization failure as a stop condition for follow-up sending.

## Compliance and deliverability gate

This automation is a technical template, not a determination that contacting any lead is lawful. Before each market launch, document the applicable lawful basis and direct-marketing rules, use only relevant business contact data, honor objection/unsubscribe immediately, publish an appropriate privacy notice, apply retention limits, and maintain evidence of suppression. Obtain qualified legal advice for the UK, EU member states (Italy and Spain), and UAE.

Start with SES sandbox/test recipients, then a reviewed pilot of no more than five messages. Monitor hard bounces, complaints, replies, and unsubscribes daily. Pause automatically or manually if suppression ingestion is stale, SPF/DKIM/DMARC fails, or complaint/bounce metrics deteriorate.

## Preflight and rollout

- [ ] All `PASTE_*` placeholders are replaced in the imported n8n copy.
- [ ] The old exposed DeepSeek key is revoked.
- [ ] PostgreSQL and SES SMTP credentials are attached and tested.
- [ ] SES identity, SPF, DKIM, DMARC, and reply mailbox are verified.
- [ ] The PostgreSQL schema is initialized and all 11 Postgres nodes use the Lead Pipeline PostgreSQL credential.
- [ ] The four-file `googlemaps-scraper/` service is installed and running on the VPS/instance before any workflow test.
- [ ] Scraper health is reachable from n8n, `scraper.baseUrl` is correct, and one keyword from each market is verified manually.
- [ ] Reply/SES event ingestion updates `reply_log` and `blacklist` before follow-ups.
- [ ] A legal/compliance owner approves each market and niche.
- [ ] A five-recipient seed-list execution has correct language, links, sender, reply-to, and suppression behavior.
- [ ] Only then activate the hourly UTC schedule and raise volume gradually.

### Initial-send branch does not continue past suppression checks

An empty `email_history` or `blacklist` table is a valid first-run state. The two PostgreSQL readers in the initial-send branch are configured to **Always Output Data**, so they still trigger `Email Cooldown Deduplication` when a table has no rows. Keep this node setting enabled after importing or editing the workflow. Without it, n8n returns zero items from an empty query and stops that execution path before the deduplication node can evaluate the personalized-email candidates.

The deduplication node also emits a result for suppressed candidates. `Initial Email Allowed` sends allowed candidates onward and returns suppressed candidates directly to `Loop Over Items2`. This return path is required: if a loop iteration produces zero output, n8n never reaches the loop's done output and `Build Campaign Report` cannot run. The report's `emailsPrepared` count includes only candidates where `shouldSend` is true.
