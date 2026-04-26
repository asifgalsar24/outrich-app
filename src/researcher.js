'use strict';

const axios = require('axios');

const CLAUDE_API = 'https://api.anthropic.com/v1/messages';

async function scrapeWebsite(url) {
  if (!url) return null;
  try {
    const { data } = await axios.get(url, {
      timeout: 8_000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; OutReachBot/1.0)' },
    });
    const text = data.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000);
    return text || null;
  } catch {
    return null;
  }
}

async function researchLead(lead) {
  const websiteText = await scrapeWebsite(lead.website_url);

  const contextBlock = [
    `Business: ${lead.company_name}`,
    `Industry: ${lead.niche}`,
    `Ad format they run: ${lead.ad_type || 'unknown'}`,
    lead.active_ads_count ? `Ads found during scrape: ${lead.active_ads_count}` : null,
    lead.facebook_page    ? `Facebook: ${lead.facebook_page}`                    : null,
    lead.website_url      ? `Website: ${lead.website_url}`                       : null,
    websiteText           ? `\nWebsite content (scraped):\n${websiteText}`        : null,
  ].filter(Boolean).join('\n');

  const response = await axios.post(CLAUDE_API, {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 300,
    messages: [{
      role: 'user',
      content: [
        `You are preparing research hooks for a personalized cold email about video/content production.`,
        `Focus only on their marketing — ads, videos, visuals, website presence. Do not invent facts.`,
        ``,
        contextBlock,
        ``,
        `Give exactly 3 hooks based ONLY on what is stated above:`,
        `1. VALIDATION — one specific thing they are doing well (e.g. consistent ad format, clear CTA on site, volume of ads)`,
        `2. GAP — one concrete weakness visible in their marketing (e.g. only static images, no video, thin website copy)`,
        `3. OBSERVATION — one specific detail proving you looked (cite a number, a format, or something you read on their site)`,
        ``,
        `Max 150 words. Every statement must reference a real fact from the data above.`,
      ].join('\n'),
    }],
  }, {
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    timeout: 20_000,
  });

  return response.data.content?.[0]?.text || 'Research unavailable.';
}

async function researchLeads(leads, onProgress) {
  for (let i = 0; i < leads.length; i++) {
    const lead = leads[i];
    try {
      const research = await researchLead(lead);
      if (onProgress) await onProgress(lead.id, research, i + 1, leads.length);
      if (i < leads.length - 1) await sleep(500);
    } catch (err) {
      console.error(`[Researcher] Failed for lead ${lead.id}: ${err.message}`);
      if (onProgress) await onProgress(lead.id, 'Research failed.', i + 1, leads.length);
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { researchLead, researchLeads };
