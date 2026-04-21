'use strict';

const { createClient } = require('@supabase/supabase-js');

// Service role key bypasses RLS — backend always filters by client_id manually
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
);

// ── Leads ────────────────────────────────────────────────────────────────────

async function insertLeads(leads, client_id) {
  const pages = leads.map((r) => r.facebook_page).filter(Boolean);

  // Fetch existing leads for THIS client only
  let existingMap = new Map();
  if (pages.length > 0) {
    let query = supabase
      .from('leads')
      .select('id, facebook_page, lemlist_status')
      .in('facebook_page', pages);
    if (client_id) query = query.eq('client_id', client_id);
    const { data: existing } = await query;
    for (const row of (existing || [])) existingMap.set(row.facebook_page, row);
  }

  const toInsert = [];
  const toRefresh = [];
  let skippedSent = 0;

  for (const lead of leads) {
    const existing = lead.facebook_page ? existingMap.get(lead.facebook_page) : null;
    if (!existing) {
      toInsert.push({ ...lead, client_id: client_id || null });
    } else if (existing.lemlist_status === 'sent') {
      skippedSent++;
    } else {
      toRefresh.push({ ...lead, id: existing.id, client_id: client_id || null });
    }
  }

  const results = [];

  if (toInsert.length > 0) {
    const { data, error } = await supabase
      .from('leads')
      .insert(toInsert)
      .select('id, company_name, facebook_page');
    if (error) throw new Error(`insertLeads (insert): ${error.message}`);
    results.push(...(data ?? []));
  }

  for (const lead of toRefresh) {
    const { id, ...fields } = lead;
    const { data, error } = await supabase
      .from('leads')
      .update({
        ...fields,
        business_score: null,
        lead_quality: null,
        score_reasoning: null,
        suggested_service: null,
        outreach_angle: null,
        perplexity_research: null,
        hebrew_email_draft: null,
        email_approved: null,
        email_issue: null,
      })
      .eq('id', id)
      .select('id, company_name, facebook_page');
    if (error) console.error(`insertLeads (refresh ${id}): ${error.message}`);
    else results.push(...(data ?? []));
  }

  console.log(`[DB] insertLeads: ${toInsert.length} new, ${toRefresh.length} refreshed, ${skippedSent} skipped (already sent)`);
  return results;
}

async function updateLeadScore(id, { business_score, lead_quality, score_reasoning, suggested_service, outreach_angle }) {
  const { error } = await supabase
    .from('leads')
    .update({ business_score, lead_quality, score_reasoning, suggested_service, outreach_angle })
    .eq('id', id);
  if (error) throw new Error(`updateLeadScore(${id}): ${error.message}`);
}

async function getLeadById(id) {
  const { data, error } = await supabase.from('leads').select('*').eq('id', id).single();
  if (error) throw new Error(`getLeadById(${id}): ${error.message}`);
  return data;
}

async function updateLeadResearch(id, perplexity_research) {
  const { error } = await supabase.from('leads').update({ perplexity_research }).eq('id', id);
  if (error) throw new Error(`updateLeadResearch(${id}): ${error.message}`);
}

async function updateLeadEmailAddress(id, email_address) {
  const { error } = await supabase.from('leads').update({ email_address }).eq('id', id);
  if (error) throw new Error(`updateLeadEmailAddress(${id}): ${error.message}`);
}

async function updateLeadEmail(id, { hebrew_email_draft, email_approved, email_issue }) {
  const { error } = await supabase.from('leads').update({ hebrew_email_draft, email_approved, email_issue }).eq('id', id);
  if (error) throw new Error(`updateLeadEmail(${id}): ${error.message}`);
}

async function updateLeadLemlistStatus(id) {
  const { error } = await supabase
    .from('leads')
    .update({ lemlist_status: 'sent', email_status: 'contacted' })
    .eq('id', id);
  if (error) throw new Error(`updateLeadLemlistStatus(${id}): ${error.message}`);
}

async function getHotLeads(limit = 5, client_id) {
  let query = supabase
    .from('leads')
    .select('*')
    .eq('lead_quality', 'hot')
    .order('business_score', { ascending: false })
    .limit(limit);
  if (client_id) query = query.eq('client_id', client_id);
  const { data, error } = await query;
  if (error) throw new Error(`getHotLeads: ${error.message}`);
  return data;
}

// ── Search Requests ──────────────────────────────────────────────────────────

async function createSearchRequest({ keyword, location, max_leads, client_id }) {
  const { data, error } = await supabase
    .from('search_requests')
    .insert({ keyword, location, max_leads, client_id: client_id || null, status: 'running', run_date: new Date().toISOString() })
    .select('id')
    .single();
  if (error) throw new Error(`createSearchRequest: ${error.message}`);
  return data.id;
}

async function finalizeSearchRequest(id, { leads_found, hot_count, warm_count, cold_count }) {
  const { error } = await supabase
    .from('search_requests')
    .update({ status: 'done', leads_found, hot_count, warm_count, cold_count })
    .eq('id', id);
  if (error) throw new Error(`finalizeSearchRequest(${id}): ${error.message}`);
}

async function failSearchRequest(id) {
  const { error } = await supabase.from('search_requests').update({ status: 'failed' }).eq('id', id);
  if (error) console.error(`failSearchRequest(${id}): ${error.message}`);
}

module.exports = {
  insertLeads,
  updateLeadScore,
  getLeadById,
  updateLeadResearch,
  updateLeadEmailAddress,
  updateLeadEmail,
  updateLeadLemlistStatus,
  getHotLeads,
  createSearchRequest,
  finalizeSearchRequest,
  failSearchRequest,
};
