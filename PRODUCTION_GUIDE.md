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
13. Provides a ready follow-up sequence builder for staged drip emails.

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

For production safety, update suppression tabs daily:

1. Search Gmail for replies using the query from `gmailSearch.replyQuery` and append matching contacts to `Reply_Log`.
2. Search Gmail for bounces using `gmailSearch.bounceQuery` and append bounced recipient emails to `Blacklist` with `type=email`.
3. Add manual unsubscribes or complaints to `Blacklist` immediately.
4. Never remove hard bounces from `Blacklist`.

The sending branch checks `Email_History`, `Reply_Log`, and `Blacklist` before sending. If a lead appears in any suppression source, it is skipped.

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

The **Follow-up Sequence Builder (manual/cron branch)** node is included as a ready production component. Wire it from a Google Sheets read of `Email_History`, then into the same rate-limit, Gmail send, and append-history pattern after you verify your suppression logs are accurate.

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
