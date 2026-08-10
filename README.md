# SRLINES Multi-Market Google Maps Lead Pipeline — PostgreSQL Edition

This repository contains two n8n lead-generation workflows for the **United Kingdom, Italy, Spain, and the United Arab Emirates**. Both target the same six business-niche groups and store operational data in a PostgreSQL database on the same VPS as n8n instead of Google Sheets. This removes the Google Sheets 60-read-requests-per-minute-per-user bottleneck, gives writes transaction semantics, and adds indexes for suppression and email-history lookups.

PostgreSQL is used rather than an n8n SQLite community node: PostgreSQL has a maintained core n8n node, supports concurrent workflow executions, and remains modest on a small single-VPS deployment.

## Repository contents

- `SRLINES Ultimate 6-in-1 Google Maps AI Lead Pipeline.json` — the original importable workflow for wCRM/WhatsApp CRM outreach, with 11 PostgreSQL nodes and no Google Sheets nodes.
- `SRLINES 2nd Workflow - Website and Web Application Client Hunt.json` — the duplicated client-hunting workflow for website, ecommerce, portal, dashboard, integration, and custom web application development. It keeps the original countries and niche groups, uses a distinct set of search phrases and web-development scoring/personalization, and contains no YouTube video, thumbnail, or call to action.
- `database/init.sql` — idempotent tables, constraints, grants, and query indexes.
- `googlemaps-scraper/` — scraper service required by the workflow.

## Recommended VPS prerequisites and technology stack

We currently run and recommend the following single-VPS configuration for this workflow:

| Resource | Recommended configuration |
| --- | --- |
| vCPU | 2 vCPUs |
| Memory | 2 GB RAM |
| Swap | 3 GB |
| Disk | 30 GB HDD or better |
| Operating system | Debian 12 or Debian 13 |

The technology stack used on the VPS is:

- **n8n** for workflow automation.
- **PM2** for keeping the Google Maps scraper process running.
- **Node.js** for n8n and the scraper runtime.
- **PostgreSQL** for workflow data storage.
- **Nginx** as the reverse proxy.

This is our tested and recommended baseline, not a universal sizing guarantee. Monitor CPU, memory, swap, and disk usage, and increase the VPS resources when workflow concurrency, database size, or scraping volume grows.

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

## 3. Choose a workflow

Use the workflow whose offer matches the campaign you intend to send:

| Workflow | Use it for | Important behavior |
| --- | --- | --- |
| **Original — Google Maps AI Lead Pipeline** | Introducing the SRLINES wCRM/WhatsApp CRM product | Generates Google Maps searches across the four configured countries and six niche groups, scores product fit, then creates localized initial and follow-up email. |
| **2nd Workflow — Website and Web Application Client Hunt** | Finding clients for websites, redesigns, ecommerce, portals, dashboards, booking/enquiry systems, integrations, and custom web applications | Uses the same countries and niche groups with changed search phrases, evidence-grounded web-development scoring, and dynamic localized emails. It deliberately has no YouTube content. |

The workflows share the PostgreSQL tables. Their campaign names differ, but the email cooldown and blacklist apply across the shared history, which helps prevent contacting the same address twice. If you want completely isolated data, create a separate database/schema and update every Postgres credential accordingly.

## 4. Configure Runtime Config before publishing

**Do this separately in every imported workflow.** Open the **Runtime Config** node and replace or review all operator-specific values before testing or publishing:

1. Replace `PASTE_DEEPSEEK_API_KEY_HERE`; preferably move the secret to an n8n credential or protected environment variable if your deployment supports it.
2. Change the company name, legal name, sender name/title, sender email, reply-to address, contact email, phone/WhatsApp number, WhatsApp CTA URL, website, branding, signature, product/service description, and trust statements to your own accurate details.
3. Review countries, cities, niches, keyword categories, languages/locales, campaign name, sending limits, cooldown, delays, follow-up timing, scraper URL, result limits, validation rules, and timezone.
4. Verify that the selected SES identity belongs to you and that every link and contact value in a seed email is correct.
5. Do not publish or activate the schedule until the Runtime Config has been updated, credentials are connected, suppression ingestion works, and a manual low-volume test passes.

The JSON files contain template operator details for illustration; importing a file does **not** make those details appropriate for your deployment.

## 5. Import and connect a workflow

1. Back up/export the currently active workflow, then deactivate it so the old and new workflows cannot send duplicate messages.
2. Import either workflow JSON listed above as a new workflow. To run both offers, import both files and configure/test each one independently.
3. Open each of its 11 Postgres nodes, select **Lead Pipeline PostgreSQL**, and save. n8n intentionally does not receive a committed credential ID or password.
4. Attach your **SES SMTP account** credential to both email nodes and verify all operator details and the scraper configuration in **Runtime Config**. Repeat this for the second workflow if both are imported.
5. There is no Google Sheet ID and no Google OAuth credential to configure. `Reply_Log` and `Blacklist` are now the `reply_log` and `blacklist` tables.
6. Run a manual seed-list execution for the chosen workflow. Inspect each Postgres node, generated subject, plain-text body, rendered HTML, links, localization, and suppression result before activation. When using both workflows, test them one at a time while both schedules remain inactive.

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
