-- Pakistan real-estate intelligence schema for PostgreSQL 14+.
-- Idempotent: safe to apply after every repository update.

CREATE TABLE IF NOT EXISTS pakistan_real_estate_leads (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  business_key text GENERATED ALWAYS AS
    (lower(coalesce(NULLIF(domain, ''), NULLIF(phone, ''), business_name || '|' || city))) STORED,
  business_name text NOT NULL,
  city text NOT NULL,
  province text,
  address text,
  phone text,
  website text,
  domain text,
  google_maps_url text,
  latitude numeric,
  longitude numeric,
  rating numeric,
  review_count integer,
  category text,
  search_keyword text NOT NULL,
  emails text[] NOT NULL DEFAULT '{}',
  social_profiles jsonb NOT NULL DEFAULT '{}'::jsonb,
  website_signals jsonb NOT NULL DEFAULT '{}'::jsonb,
  ai_score smallint NOT NULL DEFAULT 0 CHECK (ai_score BETWEEN 0 AND 100),
  ai_grade text NOT NULL DEFAULT 'unrated',
  ai_qualification text,
  ai_nurture_strategy text,
  ai_analysis jsonb NOT NULL DEFAULT '{}'::jsonb,
  source text NOT NULL DEFAULT 'Google Maps',
  source_retrieved_at timestamptz NOT NULL DEFAULT now(),
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pakistan_real_estate_leads_business_key_key UNIQUE (business_key)
);

CREATE TABLE IF NOT EXISTS pakistan_real_estate_contacts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  lead_id bigint NOT NULL REFERENCES pakistan_real_estate_leads(id) ON DELETE CASCADE,
  full_name text,
  job_title text,
  authority_level text NOT NULL DEFAULT 'unknown',
  email text,
  phone text,
  linkedin_url text,
  source_url text,
  confidence smallint NOT NULL DEFAULT 0 CHECK (confidence BETWEEN 0 AND 100),
  is_decision_maker boolean NOT NULL DEFAULT false,
  discovered_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pakistan_real_estate_contacts_identity_key
    UNIQUE (lead_id, full_name, email, linkedin_url)
);

CREATE INDEX IF NOT EXISTS pakistan_real_estate_leads_city_score_idx
  ON pakistan_real_estate_leads (city, ai_score DESC);
CREATE INDEX IF NOT EXISTS pakistan_real_estate_leads_grade_idx
  ON pakistan_real_estate_leads (ai_grade, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS pakistan_real_estate_contacts_lead_idx
  ON pakistan_real_estate_contacts (lead_id);
CREATE INDEX IF NOT EXISTS pakistan_real_estate_contacts_decision_maker_idx
  ON pakistan_real_estate_contacts (is_decision_maker, authority_level);

GRANT SELECT, INSERT, UPDATE, DELETE ON pakistan_real_estate_leads,
  pakistan_real_estate_contacts TO n8n_leads;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO n8n_leads;
