# SRLINES Pakistan Real Estate AI Lead Intelligence --- Google Maps + AI + PostgreSQL

This repository contains the current **SRLINES Pakistan Real Estate AI
Lead Intelligence** pipeline for discovering Pakistani real-estate
businesses from Google Maps, enriching their public web presence,
scoring their suitability for **WhatsApp/Meta CRM (wCRM)**, generating
nurture guidance, and storing both company and decision-maker/contact
intelligence in PostgreSQL.

The current repository is intentionally focused on the **Pakistan
real-estate intelligence workflow**. Older multi-market email-outreach
documentation is no longer representative of the repository.

> **Important:** This is a lead-intelligence and qualification pipeline.
> It does not require Gmail, SES, Google Sheets, or an email-sending
> workflow.

## Current repository structure

``` text
n8n-workflows/
├── database/
│   └── n8n_leads_full_backup.dump
├── googlemaps-scraper/
│   ├── .env
│   ├── ecosystem.config.js
│   ├── package.json
│   └── server.js
├── .gitignore
├── README.md
└── SRLINES Pakistan Real Estate AI Lead Intelligence - WhatsApp-Meta CRM.json
```

### Main files

  ------------------------------------------------------------------------------------------------------------------
  Path                                                                           Purpose
  ------------------------------------------------------------------------------ -----------------------------------
  `SRLINES Pakistan Real Estate AI Lead Intelligence - WhatsApp-Meta CRM.json`   Importable n8n workflow for
                                                                                 Pakistan real-estate discovery,
                                                                                 enrichment, AI scoring/nurturing,
                                                                                 and PostgreSQL persistence.

  `database/n8n_leads_full_backup.dump`                                          PostgreSQL custom-format backup
                                                                                 containing the current `n8n_leads`
                                                                                 database schema/data snapshot used
                                                                                 by this project.

  `googlemaps-scraper/server.js`                                                 Google Maps scraper API used by the
                                                                                 n8n workflow.

  `googlemaps-scraper/package.json`                                              Node.js dependencies and npm
                                                                                 scripts for the scraper.

  `googlemaps-scraper/ecosystem.config.js`                                       PM2 configuration. The process name
                                                                                 is `googlemaps-scraper`, one forked
                                                                                 instance, port `3000`.

  `googlemaps-scraper/.env`                                                      Scraper runtime environment values.
                                                                                 **Do not store credentials or
                                                                                 private secrets in this tracked
                                                                                 file.**
  ------------------------------------------------------------------------------------------------------------------

## What the workflow does

The pipeline is designed around this flow:

``` text
Schedule / Manual Run
        ↓
Pakistan Runtime Config
        ↓
Rotate City and Keywords
        ↓
Process search combinations one-by-one
        ↓
Google Maps Pakistan Scraper
        ↓
Website / Contact Enrichment
        ↓
AI Lead Intelligence
        ↓
Qualification + Nurture Guidance
        ↓
PostgreSQL Upsert
        ↓
Continue search rotation
```

The workflow deliberately processes rotating search combinations rather
than trying to scrape every city/category combination in one execution.
This keeps individual executions manageable and reduces pressure on the
scraper, n8n Code nodes, target websites, and the AI API.

## Current Pakistan search coverage

The Runtime Config currently targets real-estate businesses in:

-   Karachi
-   Lahore
-   Islamabad
-   Rawalpindi
-   Faisalabad
-   Multan
-   Peshawar
-   Quetta
-   Gujranwala
-   Sialkot
-   Hyderabad
-   Bahawalpur
-   Abbottabad

Configured real-estate search categories include:

-   real estate agency
-   property dealer
-   property developer
-   real estate developer
-   commercial real estate
-   property management company
-   housing society
-   real estate investment company
-   estate agent
-   property consultant

The workflow currently rotates **4 search combinations per run** and
requests up to **12 Google Maps results per keyword**.

## Google Maps collection rules

The Google Maps stage calls:

``` text
POST /api/scrape/search
```

against the scraper URL configured in **Pakistan Runtime Config**.

Current behavior includes:

-   business name normalization;
-   business phone normalization;
-   website normalization;
-   Google Maps URL retention;
-   latitude/longitude retention when available;
-   rating and review-count retention;
-   Maps-provided email retention when available;
-   category/city/province context;
-   source retrieval timestamp;
-   rejection of records with no usable business name;
-   rejection of businesses without a usable website.

A website is currently required because the next enrichment stage
depends on the business domain and public website evidence.

## Website and contact enrichment

For every accepted Maps business, the workflow attempts to enrich the
lead from its public website and related public links.

The current enrichment logic was hardened so that it does **not** depend
on JavaScript's `new URL()` constructor inside n8n Code nodes.
URL/domain parsing is handled explicitly to avoid runtime compatibility
problems.

Enrichment can collect and normalize signals such as:

-   public business emails;
-   phone numbers;
-   WhatsApp links and numbers;
-   `wa.me` / WhatsApp click-to-chat evidence;
-   Facebook profiles/pages;
-   Instagram profiles;
-   LinkedIn URLs where found;
-   website/contact/about/team/leadership evidence;
-   website text/signals used for downstream AI analysis.

Unreachable or partially crawlable websites should not automatically
destroy an otherwise valid Maps lead. The workflow preserves the
business and carries available evidence forward.

## AI scoring and nurture intelligence

The AI stage evaluates the collected business evidence for likely
relevance to **SRLINES wCRM / WhatsApp-Meta CRM** rather than merely
checking whether a company exists.

The output can include:

-   `ai_score` on a 0--100 scale;
-   lead grade;
-   qualification summary;
-   conversion/qualification tier;
-   WhatsApp-related signals;
-   Facebook/Instagram or broader Meta presence;
-   social activity evidence;
-   CRM/lead-management fit;
-   business/contact evidence;
-   recommended nurture strategy;
-   decision-maker/contact intelligence when supported by public
    evidence.

The AI prompt is intended to remain **evidence-grounded**. It must not
invent a person, job title, email address, phone number, social profile,
or other contact detail that was not supported by collected evidence.

### Important scoring behavior

Scoring and qualification are intelligence fields, not a reason to
discard the entire lead dataset. Lower-scoring businesses can still be
useful for later nurturing, re-scoring, segmentation, or manual review.

Do not use an unnecessarily strict downstream filter that requires every
signal (for example a particular conversion tier **and** active social
presence **and** WhatsApp evidence) before a lead can be stored. The
database should remain the durable source of collected intelligence.

## PostgreSQL database

The workflow uses PostgreSQL database:

``` text
n8n_leads
```

The two important tables are:

``` text
public.pakistan_real_estate_leads
public.pakistan_real_estate_contacts
```

The lead table stores the company-level Google Maps, website,
enrichment, AI-score, qualification, and nurture information.

The contacts table stores decision-maker/contact evidence linked back to
the lead.

### Contact deduplication fix

The current contact schema uses a generated `contact_key` and the
workflow upserts contacts using:

``` text
ON CONFLICT (lead_id, contact_key)
```

Contact identity is derived in this priority order:

``` text
email
→ LinkedIn URL
→ phone
→ full_name|job_title
```

This allows the workflow to repeatedly enrich the same company without
creating duplicate copies of the same known contact.

The generated key is normalized to lowercase, and the database has a
unique constraint/index compatible with the workflow's
`(lead_id, contact_key)` conflict target.

## Restore the included PostgreSQL backup

The repository currently contains a PostgreSQL **custom-format** dump
rather than standalone schema `.sql` files.

Before restoring, copy the dump to the server and inspect it:

``` bash
pg_restore --list database/n8n_leads_full_backup.dump | less
```

For a new/empty deployment, create the application role/database first
if required:

``` bash
sudo -u postgres psql
```

Then, for example:

``` sql
CREATE ROLE n8n_leads LOGIN PASSWORD 'REPLACE_WITH_A_STRONG_PASSWORD';
CREATE DATABASE n8n_leads OWNER n8n_leads;
\q
```

Restore the backup:

``` bash
sudo -u postgres pg_restore \
  --dbname=n8n_leads \
  --no-owner \
  --no-privileges \
  database/n8n_leads_full_backup.dump
```

Verify that both core tables exist:

``` bash
sudo -u postgres psql -d n8n_leads -c "\dt public.pakistan_real_estate_*"
```

Check the contacts table definition and indexes:

``` bash
sudo -u postgres psql -d n8n_leads -c "\d+ public.pakistan_real_estate_contacts"
```

You should confirm that the schema supports the workflow's current
contact conflict target:

``` text
(lead_id, contact_key)
```

## Create a fresh database backup

After schema or workflow-related database changes, create a fresh full
custom-format backup:

``` bash
sudo rm -f /home/admin/n8n_leads_full_backup.dump

sudo -u postgres pg_dump \
  -F c \
  -d n8n_leads \
  -f /home/admin/n8n_leads_full_backup.dump

sudo chown admin:admin /home/admin/n8n_leads_full_backup.dump
```

Verify the dump before replacing the repository copy:

``` bash
pg_restore --list /home/admin/n8n_leads_full_backup.dump | \
grep -E "pakistan_real_estate_leads|pakistan_real_estate_contacts"
```

## n8n PostgreSQL credential

Create a Postgres credential in n8n using the deployment-specific
values.

Typical same-VPS settings:

``` text
Host:     127.0.0.1
Port:     5432
Database: n8n_leads
User:     n8n_leads
SSL:      Disable for loopback-only traffic
```

Keep PostgreSQL private. Do not expose port `5432` publicly when n8n and
PostgreSQL are on the same VPS.

Attach the PostgreSQL credential to the workflow's Postgres node(s),
especially the node responsible for the lead/contact upsert.

## Deploy the Google Maps scraper

Requirements:

-   Node.js
-   npm
-   Playwright Chromium
-   PM2 for production process management

From the repository:

``` bash
cd googlemaps-scraper
npm install
npx playwright install chromium
```

If Playwright reports missing Linux libraries, install the required
browser dependencies for the VPS before starting the service.

### Run in foreground

``` bash
npm start
```

### Run with PM2

The included `ecosystem.config.js` defines the process as:

``` text
googlemaps-scraper
```

Start and persist it:

``` bash
sudo mkdir -p /var/log/googlemaps-scraper
sudo chown "$USER":"$USER" /var/log/googlemaps-scraper

pm2 start ecosystem.config.js
pm2 save
pm2 startup
```

Run the additional command printed by `pm2 startup` when required.

Useful checks:

``` bash
pm2 status
pm2 describe googlemaps-scraper
pm2 logs googlemaps-scraper
```

If you only know the PM2 process ID:

``` bash
pm2 describe 3
```

The `script path` and `exec cwd` fields show where that PM2 process is
actually running from.

## Scraper health check

The scraper defaults to port `3000`.

Check it from the same server/network context used by n8n:

``` bash
curl http://127.0.0.1:3000/api/health
```

The workflow's **Pakistan Runtime Config** currently expects:

``` text
http://localhost:3000
```

This is correct when n8n and the scraper run directly on the same host.
If n8n runs inside a separate Docker container or on another machine,
`localhost` points to that container/machine instead, so use a reachable
private hostname/IP for the scraper.

Keep the scraper as a **single PM2 instance** because the service is
designed around a single-instance queue.

## Import and configure the n8n workflow

1.  In n8n, import:

    ``` text
    SRLINES Pakistan Real Estate AI Lead Intelligence - WhatsApp-Meta CRM.json
    ```

2.  Keep the imported workflow inactive while configuring and testing
    it.

3.  Open **Pakistan Runtime Config** and review:

    -   cities;
    -   real-estate keywords;
    -   `keywordsPerRun`;
    -   `maxResultsPerKeyword`;
    -   website crawl limits;
    -   concurrency values;
    -   request delay;
    -   scraper base URL;
    -   DeepSeek API URL/model/key.

4.  Replace the placeholder DeepSeek key with a valid secret. Prefer an
    n8n credential or protected server environment variable rather than
    committing an API key into the workflow JSON.

5.  Attach the **Lead Pipeline PostgreSQL** credential to the Postgres
    node(s).

6.  Run a manual execution before enabling the schedule.

7.  Inspect the output of each major stage:

    -   city/keyword rotation;
    -   Maps scraper;
    -   contact enrichment;
    -   AI intelligence;
    -   database upsert.

8.  Confirm both company and contact rows are being written without
    conflict errors.

## Validation queries

### Lead count by city

``` sql
SELECT
  city,
  count(*) AS leads,
  round(avg(ai_score), 1) AS avg_ai_score
FROM public.pakistan_real_estate_leads
GROUP BY city
ORDER BY leads DESC;
```

### Inspect highest-scoring leads

``` sql
SELECT
  id,
  business_name,
  city,
  website,
  ai_score,
  grade
FROM public.pakistan_real_estate_leads
ORDER BY ai_score DESC NULLS LAST
LIMIT 50;
```

Column names can evolve with the workflow/schema; use
`\d+ public.pakistan_real_estate_leads` if a query needs adjustment.

### Verify contact deduplication

``` sql
SELECT
  lead_id,
  contact_key,
  count(*)
FROM public.pakistan_real_estate_contacts
GROUP BY lead_id, contact_key
HAVING count(*) > 1;
```

A healthy unique constraint should prevent duplicate rows for the same
`(lead_id, contact_key)` identity.

## Troubleshooting

### Workflow stops after Contact Enrichment

First inspect the execution data rather than assuming the scraper
failed. A valid enrichment result should continue downstream even when
some websites cannot be crawled.

Check:

-   whether items are actually emitted from the enrichment node;
-   whether `_skipUpsert` is unexpectedly `true`;
-   the connection between enrichment and the AI node;
-   any downstream filter conditions;
-   whether the execution was a partial/manual node execution rather
    than a full workflow execution.

### All leads disappear after scoring

Do not require every "high conversion" signal simultaneously unless that
is intentional. A strict filter combining tier, social activity, and
WhatsApp evidence can reduce a valid batch to zero.

Persist the intelligence first; use score/grade/tier fields later for
segmentation and nurture priority.

### `ON CONFLICT` error in Postgres

If the upsert uses:

``` sql
ON CONFLICT (lead_id, contact_key)
```

PostgreSQL must have a matching unique/exclusion constraint.

Inspect:

``` bash
sudo -u postgres psql -d n8n_leads -c \
"\d+ public.pakistan_real_estate_contacts"
```

Confirm `contact_key` exists and `(lead_id, contact_key)` is unique.

### Website extraction fails because `URL` is unavailable

The current workflow avoids `new URL()` in n8n Code nodes. Keep
URL/domain parsing compatible with the n8n Code-node runtime rather than
reintroducing a dependency on that constructor.

### Check scraper logs

``` bash
pm2 logs googlemaps-scraper --lines 200
```

For process details:

``` bash
pm2 describe googlemaps-scraper
```

## Security notes

-   Never commit a real DeepSeek/API key into the workflow JSON.
-   Never commit database passwords.
-   Treat `googlemaps-scraper/.env` as public because this repository is
    public; keep only non-secret defaults there or replace it with an
    `.env.example`.
-   Keep PostgreSQL bound to loopback/private networking.
-   Restrict scraper access to n8n/trusted hosts where practical.
-   Back up PostgreSQL before schema migrations.
-   Public website/contact data should still be handled under an
    appropriate retention and privacy policy.

## Preflight checklist

-   [ ] `googlemaps-scraper` is online in PM2.
-   [ ] `curl http://127.0.0.1:3000/api/health` succeeds.
-   [ ] Pakistan Runtime Config contains the intended cities, keywords,
    limits, and scraper URL.
-   [ ] No real API key or database password is committed to GitHub.
-   [ ] PostgreSQL database `n8n_leads` is reachable from n8n.
-   [ ] `pakistan_real_estate_leads` exists.
-   [ ] `pakistan_real_estate_contacts` exists.
-   [ ] `contact_key` exists and `(lead_id, contact_key)` supports the
    current upsert conflict target.
-   [ ] A manual run produces Maps leads with valid websites.
-   [ ] Contact enrichment preserves valid leads even when some crawl
    attempts fail.
-   [ ] AI scoring/nurture output is generated.
-   [ ] Leads are stored regardless of whether they qualify as immediate
    high-conversion prospects.
-   [ ] Decision-maker/contact records upsert without duplicates.
-   [ ] A fresh PostgreSQL backup is created after confirmed schema
    changes.
-   [ ] Only after manual validation is the scheduled workflow enabled.

## Scope

This repository is currently optimized for **Pakistan real-estate lead
intelligence for WhatsApp/Meta CRM prospecting**. The architecture can
later be extended to other niches or markets, but the committed
workflow, database backup, scraper configuration, and this README should
be treated as one synchronized deployment set.
