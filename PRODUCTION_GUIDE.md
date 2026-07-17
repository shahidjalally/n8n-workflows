# SRLINES Google Maps AI Lead Pipeline — Production Guide

This guide explains how to configure and operate the `SRLINES Ultimate 6-in-1 Google Maps AI Lead Pipeline.json` n8n workflow for Google Maps lead discovery, email validation, DeepSeek personalization, Gmail outreach, reply/bounce suppression, and drip follow-ups.

> Important: your n8n plan does not support environment variables, so all API keys and IDs are configured in the **Runtime Config** node. Keep exported workflow files private and never publish real keys.

## What the workflow does

1. Runs on a schedule from **Cron - 1 x Hour PKT**.
2. Builds randomized city/industry keywords.
3. Sends each keyword to your local Google Maps scraper.
4. Normalizes leads and requires a valid email.
5. Checks email syntax, blocked local parts, disposable domains, and DNS MX records.
6. Enriches each lead from the business website.
7. Scores leads with DeepSeek and rule-based signals.
8. Appends qualified leads to Google Sheets.
9. Generates a custom cold email with a strong WhatsApp CTA.
10. Suppresses addresses already sent, replied, bounced, blacklisted, or inside cooldown.
11. Sends Gmail messages with randomized throttling.
12. Appends send history and campaign reporting.
13. Syncs replied emails into `Reply_Log` and bounced recipients into `Blacklist`.
14. Runs a wired follow-up branch from `Email_History` through suppression, rate limiting, Gmail send, and history append.

## Required services

- n8n on your Debian VPS.
- Local Google Maps scraper reachable from n8n, default: `http://localhost:3000`.
- Google account with Gmail and Google Sheets OAuth credentials connected in n8n.
- DeepSeek API key.
- A Google Sheet with the tabs listed below.
- A verified sender mailbox with correct SPF, DKIM, and DMARC records.

## Google Sheet tabs and recommended headers

Create one spreadsheet and add these exact tab names:

### `Keywords`

`executionId, now, keyword, keywordCity, keywordIndustry, keywordIntent, keywordStatus, firstSeen`

### `Raw_Leads`

Optional archive tab if you wire raw scraper output later.

`executionId, keyword, businessName, email, phone, website, city, industry, rating, reviews, scrapedAt`

### `Qualified_Leads`

`executionId, normalizedAt, keyword, businessName, email, phone, website, domain, city, industry, rating, reviews, score, priority, qualified, aiAnalysis`

### `Email_History`

`id, executionId, timestamp, businessName, email, phone, website, domain, city, industry, score, priority, emailSubject, emailBody, fromEmail, replyTo, lastSent, campaign, status, error, notes, followupStage, replied, whatsappCtaUrl`

### `Reply_Log`

`timestamp, email, businessName, threadId, subject, snippet, status, notes`

Use this tab to record any prospect that replied. Once an email is present here, the workflow suppresses future outreach to that address.

### `Blacklist`

`timestamp, type, value, source, reason, notes`

Use `type=email` and `value=person@example.com` for bounced, complained, unsubscribed, or invalid addresses. Add domains with `type=domain` if you want to manually block an entire domain in your own filtering logic.

### `Followup_Queue`

`timestamp, email, businessName, followupStage, nextDueAt, status, notes`

This is optional because follow-up timing can be calculated from `Email_History`, but it is useful for manual review.

### `Campaign_Report`

`executionId, date, keywordCount, businessesProcessed, emailsFound, duplicatesSkipped, qualified, emailsPrepared, emailsSent, topIndustries, status`

### `Industry_Stats`

Optional analytics tab.

`date, city, industry, leads, qualified, sent, replies, bounces`

## Configure the Runtime Config node

Open **Runtime Config** and replace all placeholders:

- `company.senderEmail`: your Gmail sender address.
- `company.replyTo`: the mailbox where replies should arrive.
- `company.whatsappCtaUrl`: your WhatsApp click-to-chat URL. Use E.164 format without `+`, for example `https://wa.me/923001234567?...`.
- `sheets.documentId`: the Google Sheet ID from the sheet URL.
- `deepseek.apiKey`: your DeepSeek API key.
- `scraper.baseUrl`: your local scraper API URL.
- `gmailSearch.replyQuery`: Gmail query for replies.
- `gmailSearch.bounceQuery`: Gmail query for bounces.

Recommended starting limits:

- `maxEmailsPerRun`: 20–50 while warming up.
- `minDelaySeconds`: 25 or higher.
- `maxDelaySeconds`: 90 or higher.
- `emailCooldownDays`: 180.
- `minScoreToEmail`: 60 initially; increase to 70 if quality is low.

## Local scraper expectation

The **Google Maps Scraper** code node expects your scraper to accept a keyword and return business results that include as many of these fields as possible:

- `name` or `businessName`
- `email` or `emails[0]`
- `phone`
- `website` or `url`
- `rating`
- `reviews` or `reviewCount`
- `city`
- `industry`

If your scraper endpoint path or payload differs, update the **Google Maps Scraper** node only. Keep the output field names above for downstream compatibility.

## Reply, bounce, and reputation process

For production safety, the workflow now includes two wired Gmail search branches:

1. **Gmail Search Replied Emails** uses `gmailSearch.replyQuery`, extracts sender addresses, and appends them to `Reply_Log`.
2. **Gmail Search Bounced Emails** uses `gmailSearch.bounceQuery`, extracts failed recipient addresses, and appends them to `Blacklist` with `type=email`.
3. Add manual unsubscribes or complaints to `Blacklist` immediately.
4. Never remove hard bounces from `Blacklist`.

The initial sending branch and the follow-up branch both check suppression data before sending. If a lead appears in any suppression source, it is skipped.

## Drip follow-up sequence

Follow-up templates are defined in `Runtime Config > followup.sequence`:

- Stage 1: after 3 days.
- Stage 2: after 7 days.
- Stage 3: after 14 days.

Each follow-up includes the WhatsApp CTA and is automatically personalized with:

- `{{businessName}}`
- `{{city}}`
- `{{signature}}`
- `{{whatsappCtaUrl}}`

The follow-up branch is fully wired: **Get Emails History → Follow-up Sequence Builder → Follow-up Suppression Check → Follow-up Rate Limit → Send Follow-up Gmail → Append Follow-up Email History**. It sends only the latest due stage per email and skips replied, bounced, complained, unsubscribed, duplicate, and blacklisted contacts.

## Production activation checklist

- [ ] Replace all placeholders in **Runtime Config**.
- [ ] Create every Google Sheet tab with the exact names above.
- [ ] Connect Google Sheets OAuth credentials to all Google Sheets nodes.
- [ ] Connect Gmail OAuth credentials to Gmail send/search nodes.
- [ ] Confirm the local scraper works from inside the n8n runtime.
- [ ] Run the workflow manually with `maxEmailsPerRun: 1`.
- [ ] Verify `Email_History` receives one correct row.
- [ ] Send test replies and bounce samples, then add them to `Reply_Log` and `Blacklist`.
- [ ] Confirm repeated runs skip replied/bounced/history emails.
- [ ] Increase volume slowly only after SPF, DKIM, DMARC, bounce rate, and reply handling are stable.

## Compliance and deliverability notes

- Only contact relevant business addresses.
- Do not email role addresses such as `noreply`, `abuse`, `privacy`, or unrelated support inboxes.
- Stop immediately on reply, unsubscribe, complaint, or bounce.
- Keep daily volume low during warm-up.
- Make emails truthful: the prompt forbids fake claims and uses only provided lead data.
- Monitor bounce rate; pause the workflow if hard bounces exceed safe thresholds.

## Google Maps scraper timeout troubleshooting

The **Google Maps Scraper** node is intentionally kept byte-for-byte aligned with the originally provided working scraper code. If you see `Search failed: timeout of 60000ms exceeded`, the timeout is coming from the local scraper request to `/api/scrape/search`, not from the reply/bounce/follow-up additions. Check that the scraper service is running, reachable from the n8n container/VPS network namespace, and able to finish one keyword within 60 seconds.

Quick checks on the VPS:

```bash
curl -sS http://localhost:3000/health || true
curl -sS -X POST http://localhost:3000/api/scrape/search \
  -H 'Content-Type: application/json' \
  -d '{"query":"real estate agent in karachi","maxResults":5}'
```

If the second command takes more than 60 seconds, reduce `scraper.maxResultsPerKeyword` in **Runtime Config**, increase scraper server capacity, or test the scraper directly outside n8n before activating the full campaign.
