# SRLINES Multi-Market Google Maps Lead Pipeline — Production Guide

This repository contains an n8n workflow configured for the **United Kingdom, Italy, Spain, and the United Arab Emirates**, using **Amazon SES SMTP** for initial messages and follow-ups. Its six target niche groups are Real Estate; Clinics and Hospitals; Restaurants and Hotels; Ecommerce and Retail; Recruitment and Visa Manpower; and Professional Services.

## What is production-ready in the template

- A deterministic, rotating keyword strategy covers all four markets without making lead discovery depend on an AI response.
- Every lead carries `country`, `countryCode`, `locale`, and `language` through scoring, personalization, and Sheets.
- Website email extraction requires valid HTTPS/TLS, syntax validation, non-disposable domains, and DNS MX records.
- Initial and follow-up sends use the same SES SMTP credential reference and sender configuration.
- Initial messages are suppressed against `Email_History` and `Blacklist`; follow-ups are additionally suppressed by `Reply_Log`.
- A two-step follow-up sequence and conservative rate limits reduce operational and reputation risk.
- Personalized email generation is fact-grounded: invented claims, dummy values, unresolved placeholders, unapproved URLs, phone numbers, and email addresses are rejected; the workflow falls back to conservative copy and deterministically inserts `+92 328 3897926` and `contact@srlines.net`.
- No API secret is stored in the committed workflow. The ready-to-upload Excel workbook contains the seven tabs and exact headers used by the active workflow.

## Repository contents

- `SRLINES Ultimate 6-in-1 Google Maps AI Lead Pipeline.json` — the n8n workflow to import.
- `SRLINES Ultimate 6-in-1 Google Maps AI Lead Pipeline.xlsx` — the ready-to-upload Google Sheets workbook with all seven required tabs.
- `googlemaps-scraper/` — the scraper service required by the workflow. This folder contains the four deployment files `.env`, `ecosystem.config.js`, `package.json`, and `server.js`.

The scraper is not embedded in n8n. **Install and deploy `googlemaps-scraper/` on your VPS or instance before testing, using, or activating the n8n workflow.**

## Required configuration before activation

1. Deploy the required Google Maps scraper by following [Deploy the Google Maps scraper](#deploy-the-google-maps-scraper). Do not test or activate the workflow until its health check succeeds from the n8n host or container.
2. Upload `SRLINES Ultimate 6-in-1 Google Maps AI Lead Pipeline.xlsx` to Google Drive and open it with Google Sheets. Confirm that all seven tabs listed in [Excel-to-Google-Sheets contract](#excel-to-google-sheets-contract-case-sensitive) are present and keep their names and row-1 headers unchanged.
3. Import `SRLINES Ultimate 6-in-1 Google Maps AI Lead Pipeline.json` into n8n.
4. In **Runtime Config**, replace:
   - `PASTE_GOOGLE_SHEET_ID_HERE` with the ID from the Google Sheet URL.
   - `PASTE_DEEPSEEK_API_KEY_HERE` with a newly issued DeepSeek API key.
   - Company identity and product claims if any are not exact. Keep `whatsappNumber` as `+92 328 3897926` and `contactEmail`/`replyTo` as `contact@srlines.net`.
5. Attach Google Sheets OAuth credentials to every Google Sheets node.
6. Attach the n8n SMTP credential named **SES SMTP account** to both SES email nodes. Use the SES SMTP endpoint for the verified identity's AWS Region, port 465 with SSL/TLS or port 587 with STARTTLS, and SES SMTP credentials (not AWS access keys).
7. Verify `noreply@ses.srlines.net` (or its domain) in SES, ensure `contact@srlines.net` receives replies, configure SPF, DKIM, DMARC, and move the SES account out of sandbox where applicable.
8. Keep the workflow inactive until the preflight below passes.

> The previously committed DeepSeek key must be revoked and replaced. Treat it as compromised even if repository access was limited.

## Deploy the Google Maps scraper

The VPS or instance needs Node.js and npm. Playwright also needs its Chromium browser and system dependencies. From the repository root, run:

```bash
cd googlemaps-scraper
npm install
npx playwright install --with-deps chromium
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
curl http://SCRAPER_HOST:3000/api/health
```

Set `scraper.baseUrl` in the workflow's **Runtime Config** to the reachable URL, for example `http://127.0.0.1:3000` when both services share a host or `http://googlemaps-scraper:3000` when that is the scraper's container/DNS name. Do not use `localhost` when n8n runs in a separate container or machine, because it would refer to n8n itself. Keep a single scraper process—the supplied PM2 configuration intentionally uses one instance to preserve its in-memory queue.

## Excel-to-Google-Sheets contract (case-sensitive)

The repository-root Excel workbook already contains these header-only tabs. Upload the workbook once, open it as a Google Spreadsheet, and do not rename tabs or alter row 1:

| Tab | Exact headers |
|---|---|
| `Keywords` | `executionId, generatedAt, keyword, keywordCity, keywordIndustry, keywordCategory, keywordIntent, country, countryCode, locale, language, keywordStatus` |
| `Qualified_Leads` | `executionId, normalizedAt, keyword, businessName, email, phone, website, domain, city, country, countryCode, locale, language, industry, keywordCategory, rating, reviews, score, priority, qualified, emailValidationStatus, emailValidationReason, emailMxRecords, emailMxCheckedAt, aiAnalysis, signals` |
| `Email_History` | `id, executionId, timestamp, businessName, email, phone, website, domain, city, country, countryCode, industry, score, priority, emailSubject, emailBody, fromEmail, replyTo, lastSent, campaign, status, followupStage, replied, whatsappNumber, contactEmail, error, notes` |
| `Campaign_Report` | `executionId, date, businessesProcessed, qualified, emailsPrepared, emailsSent, topIndustries, status` |
| `Reply_Log` | `executionId, email, businessName, repliedAt, status, messageId, snippet, action, notes` |
| `Followup_Queue` | `executionId, email, businessName, campaign, followupStage, dueAt, emailSubject, emailBody, fromEmail, replyTo, status, lastSent, notes` |
| `Blacklist` | `type, value, reason, addedAt, addedBy, expiresAt, status, notes` |

`Raw_Leads` and `Industry_Stats` are omitted because no active workflow node reads or writes them. Gmail-only search fields and thread/label columns are also omitted because SMTP does not provide Gmail search metadata.

## Reply, bounce, complaint, and unsubscribe operations

SMTP sending cannot search the reply mailbox. Before every scheduled follow-up run, synchronize replies into `Reply_Log` and delivery failures/complaints/unsubscribes into `Blacklist` using an external inbound-mail or SES event workflow.

- `Reply_Log.email` must contain the normalized recipient address.
- In `Blacklist`, use `type=email`, the normalized address in `value`, an active `status`, and a clear `reason` such as `bounce`, `complaint`, or `unsubscribe`.
- For domain-wide suppression, the current workflow requires individual email rows; do not assume `type=domain` is enforced.
- Treat synchronization failure as a stop condition for follow-up sending.

## Compliance and deliverability gate

This automation is a technical template, not a determination that contacting any lead is lawful. Before each market launch, document the applicable lawful basis and direct-marketing rules, use only relevant business contact data, honor objection/unsubscribe immediately, publish an appropriate privacy notice, apply retention limits, and maintain evidence of suppression. Obtain qualified legal advice for the UK, EU member states (Italy and Spain), and UAE.

Start with SES sandbox/test recipients, then a reviewed pilot of no more than five messages. Monitor hard bounces, complaints, replies, and unsubscribes daily. Pause automatically or manually if suppression ingestion is stale, SPF/DKIM/DMARC fails, or complaint/bounce metrics deteriorate.

## Preflight and rollout

- [ ] All `PASTE_*` placeholders are replaced in the imported n8n copy.
- [ ] The old exposed DeepSeek key is revoked.
- [ ] Google Sheets and SES SMTP credentials are attached and tested.
- [ ] SES identity, SPF, DKIM, DMARC, and reply mailbox are verified.
- [ ] The root `.xlsx` workbook is uploaded to Google Sheets; all seven tab names and row-1 headers are unchanged.
- [ ] The four-file `googlemaps-scraper/` service is installed and running on the VPS/instance before any workflow test.
- [ ] Scraper health is reachable from n8n, `scraper.baseUrl` is correct, and one keyword from each market is verified manually.
- [ ] Reply/SES event ingestion updates `Reply_Log` and `Blacklist` before follow-ups.
- [ ] A legal/compliance owner approves each market and niche.
- [ ] A five-recipient seed-list execution has correct language, links, sender, reply-to, and suppression behavior.
- [ ] Only then activate the hourly UTC schedule and raise volume gradually.
