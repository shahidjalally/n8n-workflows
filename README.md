# SRLINES Multi-Market Google Maps Lead Pipeline — PostgreSQL Edition

This repository contains an n8n workflow for the **United Kingdom, Italy, Spain, and the United Arab Emirates**. The workflow now stores operational data in a PostgreSQL database on the same VPS as n8n instead of Google Sheets. This removes the Google Sheets 60-read-requests-per-minute-per-user bottleneck, gives writes transaction semantics, and adds indexes for suppression and email-history lookups.

PostgreSQL is used rather than an n8n SQLite community node: PostgreSQL has a maintained core n8n node, supports concurrent workflow executions, and remains modest on a small single-VPS deployment.

## Repository contents

- `SRLINES Ultimate 6-in-1 Google Maps AI Lead Pipeline.json` — importable n8n workflow with 11 PostgreSQL nodes and no Google Sheets nodes.
- `database/init.sql` — idempotent tables, constraints, grants, and query indexes.
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
sudo cp /home/admin/init.sql /tmp/init.sql
sudo chmod 644 /tmp/init.sql

sudo -u postgres psql \
  --set ON_ERROR_STOP=1 \
  --dbname=n8n_leads \
  --file=/tmp/init.sql
```

Test the application login (the prompt asks for the password):

```bash
psql 'host=127.0.0.1 port=5432 dbname=n8n_leads user=n8n_leads sslmode=prefer' -c 'SELECT current_database(), current_user;'
```

The included health check prevents n8n from starting before PostgreSQL accepts connections. Docker initialization scripts only run when the data volume is empty; on an existing volume apply upgrades with `docker compose exec -T postgres psql -U n8n_leads -d n8n_leads < database/init.sql`.

## 2. Create the n8n PostgreSQL credential

1. Open **Credentials → Add credential → Postgres** in n8n.
2. Use host `localhost` when n8n is installed directly on the VPS, or `postgres` when both services share the Docker Compose network.
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


