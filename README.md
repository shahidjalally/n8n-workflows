# SRLINES Pakistan Healthcare AI Lead Intelligence — WhatsApp/Meta CRM

This n8n workflow discovers **doctors, clinics and hospitals** in Pakistan's
major cities, enriches their public business websites, evaluates their fit for
SRLINES WhatsApp/Meta CRM, and stores company and decision-maker intelligence
in the existing PostgreSQL database.

Import `SRLINES Pakistan Healthcare AI Lead Intelligence - WhatsApp-Meta CRM.json`.
It is exported **inactive** and includes **Manual Healthcare Run**. Disable the
previous real-estate workflow before switching niches.

## Scope and discovery

The default top-tier allowlist is **Karachi, Lahore, Islamabad, Rawalpindi,
Faisalabad, Multan, Peshawar and Quetta**. This is an explicit operational list,
not an official city-tier classification. Review it in **Pakistan Runtime Config**.

Search categories: doctor, general physician, specialist doctor, medical clinic,
dental clinic, hospital, private hospital and medical center. The workflow rotates
**4 city/category searches per run**, requests up to **12 results per search**,
and schedules runs every 20 minutes when enabled.

```text
Manual run / schedule → Runtime Config → Rotate City and Keywords → Loop Searches
  → Google Maps Pakistan Scraper → Public Website Contact Enrichment
  → AI Qualify, Score and Nurture → Validate Emails + MX
  → Prepare Healthcare Persistence → Upsert Lead and Decision Makers
  → Continue Search Loop → next search
```

Listings require a usable name, website/domain, healthcare category or name
evidence, and a Maps address component matching the requested city. A city-qualified
query alone is insufficient. An out-of-city listing, a road named after a city,
or a missing/unverifiable city address is rejected. Accepted address components
include the city name, a `City`/`District` suffix, and a postal code. Addresses
without these English city components require manual review and are not stored
automatically. An actual Maps category overrides the query category when deciding
whether a listing represents a doctor, clinic or hospital.

The website requirement is retained: doctors without a website or a public social
page supplied as their Maps website are not stored. Maps URLs, coordinates,
rating/reviews, category and retrieval time are preserved.

## Enrichment and qualification

Enrichment attempts up to **4 pages per site**: the exact Maps website, contact,
doctors and about pages. A social-page website is fetched directly. Failed website
requests preserve an otherwise valid Maps lead. Public emails, phone/WhatsApp
numbers and social profiles are normalized. Email MX validation calls
`https://dns.google/resolve`.

The existing `website_signals` JSON stores healthcare provider type, city
verification, appointment/OPD, teleconsultation and emergency evidence. No new
columns are introduced.

AI qualification evaluates administrative CRM needs: appointment enquiries,
booking/reminders, reception coordination, OPD enquiries, teleconsultation and
follow-up administration. Ratings/reviews indicate visibility, not clinical
quality. It targets publicly evidenced clinic owners, practice managers, hospital
administrators, medical directors and doctors shown to make business decisions.
It must not invent people or contact details. Patient records are not needed.

**All valid in-scope healthcare leads are persisted**, including lower-scoring
providers, landline-only hospitals and providers without social profiles.
WhatsApp presence, CRM fit, grade and conversion tier remain prioritization fields.
Missing AI configuration or failed AI requests produce marked heuristic results.
Skipped searches still reach loop continuation so empty/rejected batches do not
stop later searches.

## Database compatibility — no schema changes

Keep database **`n8n_leads`** and its original table names:

```text
public.pakistan_real_estate_leads
public.pakistan_real_estate_contacts
```

The legacy names are retained even though new records describe healthcare
providers. The included `database/n8n_leads_full_backup.dump`, columns, indexes,
foreign keys, generated `business_key` and `contact_key`, and lead/contact upsert
SQL remain unchanged. Healthcare details use existing category, website-signals
and AI-analysis fields. Contact deduplication still uses
`ON CONFLICT (lead_id, contact_key)` with email, LinkedIn, phone, then name/title.

For a new empty deployment, create your role/database securely, then inspect and
restore the existing custom-format dump using your normal database connection:

```bash
pg_restore --list database/n8n_leads_full_backup.dump
pg_restore --exit-on-error --no-owner --no-privileges \
  --dbname=n8n_leads database/n8n_leads_full_backup.dump
```

Attach your existing PostgreSQL credential to **Upsert Lead and Decision Makers**
and **Read Presentable Lead Dataset**. For same-host services use loopback,
port 5432, database `n8n_leads`, and your existing application role/password.

## Empty the tables before switching niches

These commands are for you to run; importing/refactoring the workflow **does not
execute them**. They delete all leads/contacts and reset identity counters while
preserving the schema.

1. Disable the old real-estate workflow and the new healthcare schedule. Wait for
   active executions to finish so writers cannot immediately refill the tables.
2. Back up the current database and confirm the backup is readable:

   ```bash
   backup_path="n8n_leads-before-healthcare-$(date +%Y%m%d-%H%M%S).dump"
   pg_dump --format=custom --dbname=n8n_leads --file="$backup_path"
   pg_restore --list "$backup_path"
   ```

3. Run as the table owner or an authorized role using your normal connection
   configuration (`PGHOST`, `PGUSER`, `.pgpass`, etc.):

   ```bash
   psql --dbname=n8n_leads --set=ON_ERROR_STOP=1 <<'SQL'
   BEGIN;
   TRUNCATE TABLE
     public.pakistan_real_estate_contacts,
     public.pakistan_real_estate_leads
   RESTART IDENTITY;
   COMMIT;
   SELECT count(*) AS leads FROM public.pakistan_real_estate_leads;
   SELECT count(*) AS contacts FROM public.pakistan_real_estate_contacts;
   SQL
   ```

   On a same-host VPS, you can replace `psql` with `sudo -u postgres psql`,
   keeping the same arguments and SQL. Both related tables are named explicitly;
   no `CASCADE`, table drop, migration or schema alteration is used. If another
   table references these tables, PostgreSQL refuses the truncate rather than
   deleting unrelated data.
4. Expect both counts to be zero. Configure the healthcare workflow, validate a
   small manual run, and only then enable its schedule.

## Scraper startup

The scraper is niche-neutral; its API and production PM2 configuration are unchanged.
Requirements: Node.js/npm, Playwright Chromium and its Linux dependencies.

```bash
cd googlemaps-scraper
npm install
npx playwright install chromium
npm start
```

For production PM2, create writable logs under `/var/log/googlemaps-scraper`, then
run `pm2 start ecosystem.config.js` and `pm2 save`. Use one instance because the
scraper has a single-instance queue. Check `curl http://127.0.0.1:3000/api/health`
from the n8n host. The workflow uses `http://localhost:3000`; for containerized or
remote n8n, configure a reachable private scraper address instead.

## n8n configuration and rollout

1. Import the healthcare JSON and keep it inactive.
2. Review cities, search categories, limits and scraper URL in Runtime Config.
3. Set `DEEPSEEK_API_KEY` securely in the n8n server environment. The workflow
   reads `$env.DEEPSEEK_API_KEY`. For trusted self-hosted n8n deployments that block
   Code-node environment access, permit it with
   `N8N_BLOCK_ENV_ACCESS_IN_NODE=false` and restart n8n. Never paste a key into
   the workflow export. Without accessible credentials, heuristic qualification
   continues and `ai_analysis` records the limitation.
4. Attach the existing PostgreSQL credential to both database nodes.
5. Allow access to the scraper, Google Maps/static resources, selected provider
   websites, `api.deepseek.com` and `dns.google`.
6. Execute **Manual Healthcare Run**. Verify cities/categories, enrichment,
   AI/heuristic output, email validation, and lead/contact upserts. Check that
   landline-only and lower-scoring providers remain in the dataset and that
   rejected/empty searches still advance to the next search.
7. Enable the schedule only after a successful manual run.

The export webhook path and filename are **`pakistan-healthcare-leads.csv`**.
Its query reads the same legacy tables. Empty old records first if the exported
dataset should contain only healthcare leads. Only one niche workflow should
write to this dataset at a time.

## Validation

Run the workflow regression suite without n8n, credentials or external services:

```bash
node --test tests/healthcare-workflow.test.cjs
```

It executes embedded Code nodes against fixture HTTP responses; it does not prove
live Google Maps/DeepSeek access. The scraper's separate existing `npm test`
references a missing `test.js`.

After a manual run, inspect the existing tables:

```sql
SELECT city, count(*) AS leads, round(avg(ai_score), 1) AS average_score
FROM public.pakistan_real_estate_leads GROUP BY city ORDER BY leads DESC;

SELECT id, business_name, city, category, ai_score, ai_grade, ai_qualification
FROM public.pakistan_real_estate_leads ORDER BY ai_score DESC LIMIT 50;

SELECT lead_id, contact_key, count(*)
FROM public.pakistan_real_estate_contacts
GROUP BY lead_id, contact_key HAVING count(*) > 1;
```
