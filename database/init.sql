-- SRLINES lead-pipeline database schema (PostgreSQL 14+).
-- Safe to run repeatedly.

CREATE TABLE IF NOT EXISTS keywords (
  "executionId" text, "generatedAt" text, keyword text,
  "keywordCity" text, "keywordIndustry" text, "keywordCategory" text,
  "keywordIntent" text, country text, "countryCode" text, locale text,
  language text, "keywordStatus" text
);

CREATE TABLE IF NOT EXISTS qualified_leads (
  "executionId" text, "normalizedAt" text, keyword text,
  "businessName" text, email text, phone text, website text, domain text,
  city text, country text, "countryCode" text, locale text, language text,
  industry text, "keywordCategory" text, rating text, reviews text, score text,
  priority text, qualified text, "emailValidationStatus" text,
  "emailValidationReason" text, "emailMxRecords" text,
  "emailMxCheckedAt" text, "aiAnalysis" text, signals text
);

CREATE TABLE IF NOT EXISTS email_history (
  id text PRIMARY KEY, "executionId" text, "timestamp" text,
  "businessName" text, email text, phone text, website text, domain text,
  city text, country text, "countryCode" text, industry text, score text,
  priority text, "emailSubject" text, "emailBody" text, "fromEmail" text,
  "replyTo" text, "lastSent" text, campaign text, status text,
  "followupStage" text, replied text, "whatsappNumber" text,
  "contactEmail" text, error text, notes text
);

CREATE TABLE IF NOT EXISTS campaign_report (
  "executionId" text PRIMARY KEY, date text, "businessesProcessed" text,
  qualified text, "emailsPrepared" text, "emailsSent" text,
  "topIndustries" text, status text
);

CREATE TABLE IF NOT EXISTS reply_log (
  "executionId" text, email text, "businessName" text, "repliedAt" text,
  status text, "messageId" text, snippet text, action text, notes text
);

CREATE TABLE IF NOT EXISTS followup_queue (
  "executionId" text, email text PRIMARY KEY, "businessName" text,
  campaign text, "followupStage" text, "dueAt" text,
  "emailSubject" text, "emailBody" text, "fromEmail" text, "replyTo" text,
  status text, "lastSent" text, notes text
);

CREATE TABLE IF NOT EXISTS blacklist (
  type text, value text, reason text, "addedAt" text,
  "addedBy" text, "expiresAt" text, status text, notes text
);

CREATE INDEX IF NOT EXISTS email_history_email_lastsent_idx
  ON email_history (lower(email), "lastSent" DESC);
CREATE INDEX IF NOT EXISTS email_history_status_idx ON email_history (status);
CREATE INDEX IF NOT EXISTS qualified_leads_email_idx ON qualified_leads (lower(email));
CREATE INDEX IF NOT EXISTS reply_log_email_idx ON reply_log (lower(email));
CREATE INDEX IF NOT EXISTS blacklist_value_idx ON blacklist (lower(value));
CREATE INDEX IF NOT EXISTS followup_queue_due_idx ON followup_queue ("dueAt", status);

-- Restrict the n8n login to this application database rather than making it a
-- PostgreSQL superuser. Run these grants as the database owner after replacing
-- n8n_leads if a different role name was chosen.
GRANT USAGE ON SCHEMA public TO n8n_leads;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO n8n_leads;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO n8n_leads;
