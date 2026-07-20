# SRLINES Google Sheets production setup

This workflow is designed for a **Google Sheet**, not an `.xlsx` file uploaded to n8n. Upload the supplied workbook to Google Drive, open it with Google Sheets, and use that converted Google Sheet's ID in **Runtime Config** (`sheets.documentId`). Do not use an Excel file ID.

## One-time configuration

1. In Google Drive, upload `SRLINES Ultimate 6-in-1 Google Maps AI Lead Pipeline.xlsx` and select **Open with → Google Sheets**. Confirm the converted spreadsheet has the same worksheet names listed below.
2. In n8n, configure the Google Sheets OAuth2 credential on every Google Sheets node. It must have access to this spreadsheet. Configure the Gmail OAuth2 credential on every Gmail node.
3. Paste the converted spreadsheet ID into `Runtime Config` and set the DeepSeek key using n8n credentials/environment configuration before activating the workflow.
4. Keep row 1 as a single, exact header row. Header matching is case-sensitive in the workflow's direct Sheets reads. Do not rename, reorder, merge, or leave a blank header cell in the tabs below.
5. Use plain-text formatting for `email`, `id`, `threadId`, and `messageId`; use ISO-8601 UTC strings for `timestamp`, `lastSent`, `repliedAt`, and `addedAt`. Do not use locale-specific date formats.

## Required suppression and history tabs

These tabs are required before enabling sends. The workflow is intentionally fail-closed: it should not send initial or follow-up email if it cannot read `Email_History`, `Reply_Log`, or `Blacklist`.

### `Email_History`

Use this exact header row:

```text
executionId,timestamp,businessName,email,phone,website,domain,city,industry,score,priority,emailSubject,emailBody,fromEmail,replyTo,lastSent,campaign,status,error,notes,id,threadId,labelIds
```

- `id` is the unique key. Keep it unique. Initial sends use `<lowercase-email>-0`; follow-ups use `<lowercase-email>-<stage>`.
- Never delete rows to re-send a lead. The workflow uses the most recent `lastSent`/`timestamp` per normalized email for cooldown and follow-up timing.
- Valid delivery states include `sent_initial` and `sent_followup_1`, `sent_followup_2`, `sent_followup_3`. The workflow derives the next follow-up stage from `sent_followup_N`, so no extra follow-up-stage column is required.
- To manually suppress a lead immediately, add/update the address in `Reply_Log` or `Blacklist`; do not rely only on changing a history row.

### `Reply_Log`

Use this exact header row:

```text
executionId,email,businessName,repliedAt,status,messageId,threadId,snippet,action,notes
```

- `email` must be normalized lowercase and must be the replying recipient's address.
- `threadId` is the unique key for Gmail reply-sync upserts.
- Use `status` = `replied` and `action` = `suppress_outreach` for manual suppression. The workflow treats every address in this tab as do-not-send.

### `Blacklist`

Use this exact header row:

```text
type,value,reason,addedAt,addedBy,expiresAt,status,notes
```

- Put the normalized lowercase email in `value`.
- For a hard bounce, use `type` = `email`, `reason` = `bounce_detected_stop_all_outreach`, and `status` = `active`.
- Do not set `expiresAt` for hard bounces. The workflow treats every non-empty `value` as suppressed, regardless of expiry, to avoid accidental resends.

## Operational safeguards

- Restrict editor access: operators should append rows, while workflow configuration and headers are managed by an administrator.
- Protect the header rows and the `id` column in `Email_History`; protect `threadId` in `Reply_Log` and `value` in `Blacklist`.
- Do not use formulas in the key fields above. Formulas can return an empty value during Sheets recalculation and defeat matching.
- Before production activation, add one test address to `Blacklist` and one to `Reply_Log`, execute the workflow manually, and verify neither reaches either Gmail send node.
- Monitor n8n executions. An OAuth/read failure is expected to stop outbound email rather than bypass suppression; fix the credential or tab/header issue before retrying.
