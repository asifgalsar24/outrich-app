-- ================================================================
-- OutRich SaaS Migration
-- Paste this entire file into Supabase → SQL Editor → Run
-- ================================================================

-- 1. Add client_id to leads table
ALTER TABLE leads
  ADD COLUMN IF NOT EXISTS client_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS leads_client_id_idx ON leads(client_id);

-- 2. Add client_id to search_requests table
ALTER TABLE search_requests
  ADD COLUMN IF NOT EXISTS client_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;

-- 3. Create settings table (voice profile per user)
CREATE TABLE IF NOT EXISTS settings (
  user_id             UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  sender_name         TEXT NOT NULL DEFAULT '',
  company_name        TEXT NOT NULL DEFAULT '',
  service_description TEXT NOT NULL DEFAULT '',
  tone_description    TEXT NOT NULL DEFAULT '',
  example_writing     TEXT NOT NULL DEFAULT '',
  phrases_to_use      TEXT NOT NULL DEFAULT '',
  phrases_to_avoid    TEXT NOT NULL DEFAULT '',
  email_max_words     INTEGER NOT NULL DEFAULT 80,
  cta_style           TEXT NOT NULL DEFAULT 'question',
  portfolio_url       TEXT NOT NULL DEFAULT '',
  portfolio_description TEXT NOT NULL DEFAULT '',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. Enable Row Level Security
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE search_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE settings ENABLE ROW LEVEL SECURITY;

-- 5. RLS policies for leads (users see only their own)
DROP POLICY IF EXISTS "leads_select" ON leads;
DROP POLICY IF EXISTS "leads_insert" ON leads;
DROP POLICY IF EXISTS "leads_update" ON leads;
DROP POLICY IF EXISTS "leads_delete" ON leads;

CREATE POLICY "leads_select" ON leads FOR SELECT USING (auth.uid() = client_id);
CREATE POLICY "leads_insert" ON leads FOR INSERT WITH CHECK (auth.uid() = client_id);
CREATE POLICY "leads_update" ON leads FOR UPDATE USING (auth.uid() = client_id);
CREATE POLICY "leads_delete" ON leads FOR DELETE USING (auth.uid() = client_id);

-- 6. RLS policies for search_requests
DROP POLICY IF EXISTS "sr_select" ON search_requests;
DROP POLICY IF EXISTS "sr_insert" ON search_requests;

CREATE POLICY "sr_select" ON search_requests FOR SELECT USING (auth.uid() = client_id);
CREATE POLICY "sr_insert" ON search_requests FOR INSERT WITH CHECK (auth.uid() = client_id);

-- 7. RLS policies for settings
DROP POLICY IF EXISTS "settings_all" ON settings;
CREATE POLICY "settings_all" ON settings FOR ALL USING (auth.uid() = user_id);
