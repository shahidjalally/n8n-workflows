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
- No API secret is stored in the committed workflow. The supplied CSV import set contains one header-only CSV for each of the seven tabs the active workflow uses.

## Required configuration before activation

1. Import `SRLINES Ultimate 6-in-1 Google Maps AI Lead Pipeline.json` into n8n.
2. Create one Google Spreadsheet, then import each CSV from `SRLINES Google Sheets CSV Import/` as a separate sheet using **File → Import → Upload → Insert new sheet(s)**. Rename each imported sheet exactly to the CSV filename without `.csv`; do not alter row 1.
3. In **Runtime Config**, replace:
   - `PASTE_GOOGLE_SHEET_ID_HERE` with the ID from the Google Sheet URL.
   - `PASTE_DEEPSEEK_API_KEY_HERE` with a newly issued DeepSeek API key.
   - Company identity and product claims if any are not exact. Keep `whatsappNumber` as `+92 328 3897926` and `contactEmail`/`replyTo` as `contact@srlines.net`.
4. Attach Google Sheets OAuth credentials to every Google Sheets node.
5. Attach the n8n SMTP credential named **SES SMTP account** to both SES email nodes. Use the SES SMTP endpoint for the verified identity's AWS Region, port 465 with SSL/TLS or port 587 with STARTTLS, and SES SMTP credentials (not AWS access keys).
6. Verify `noreply@ses.srlines.net` (or its domain) in SES, ensure `contact@srlines.net` receives replies, configure SPF, DKIM, DMARC, and move the SES account out of sandbox where applicable.
7. Run `googlemaps-scraper`, confirm `http://localhost:3000/api/health`, and adjust `scraper.baseUrl` if n8n runs in another container/host.
8. Keep the workflow inactive until the preflight below passes.

> The previously committed DeepSeek key must be revoked and replaced. Treat it as compromised even if repository access was limited.

## CSV-to-Google-Sheets contract (case-sensitive)

The repository contains these UTF-8, header-only CSV files. Import every file as its own tab in the same Google Spreadsheet:

| Tab | Exact headers |
|---|---|
| `Keywords` | `executionId, generatedAt, keyword, keywordCity, keywordIndustry, keywordCategory, keywordIntent, country, countryCode, locale, language, keywordStatus` |
| `Qualified_Leads` | `executionId, normalizedAt, keyword, businessName, email, phone, website, domain, city, country, countryCode, locale, language, industry, keywordCategory, rating, reviews, score, priority, qualified, emailValidationStatus, emailValidationReason, emailMxRecords, emailMxCheckedAt, aiAnalysis, signals` |
| `Email_History` | `id, executionId, timestamp, businessName, email, phone, website, domain, city, country, countryCode, industry, score, priority, emailSubject, emailBody, fromEmail, replyTo, lastSent, campaign, status, followupStage, replied, whatsappNumber, contactEmail, error, notes` |
| `Campaign_Report` | `executionId, date, businessesProcessed, qualified, emailsPrepared, emailsSent, topIndustries, status` |
| `Reply_Log` | `executionId, email, businessName, repliedAt, status, messageId, snippet, action, notes` |
| `Followup_Queue` | `executionId, email, businessName, campaign, followupStage, dueAt, emailSubject, emailBody, fromEmail, replyTo, status, lastSent, notes` |
| `Blacklist` | `type, value, reason, addedAt, addedBy, expiresAt, status, notes` |

`Raw_Leads` and `Industry_Stats` were removed because no active workflow node reads or writes them. Gmail-only search fields and thread/label columns were also removed because SMTP does not provide Gmail search metadata.

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
- [ ] All seven CSV files are imported into one Google Spreadsheet; tab names equal filenames without `.csv`, and row-1 headers are unchanged.
- [ ] Scraper health and one keyword from each market are verified manually.
- [ ] Reply/SES event ingestion updates `Reply_Log` and `Blacklist` before follow-ups.
- [ ] A legal/compliance owner approves each market and niche.
- [ ] A five-recipient seed-list execution has correct language, links, sender, reply-to, and suppression behavior.
- [ ] Only then activate the hourly UTC schedule and raise volume gradually.
