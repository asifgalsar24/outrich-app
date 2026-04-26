'use strict';

const axios = require('axios');

const PERPLEXITY_API = 'https://api.perplexity.ai/chat/completions';
const MODEL = 'sonar-pro';

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
    lead.website_url   ? `Website: ${lead.website_url}`    : null,
    lead.facebook_page ? `Facebook: ${lead.facebook_page}` : null,
    websiteText ? `\nWebsite content (extracted):\n${websiteText}` : null,
  ].filter(Boolean).join('\n');

  const prompt = [
    `You are researching an Israeli business for a personalized cold email about video/content production.`,
    ``,
    contextBlock,
    ``,
    `Give me exactly 3 email hooks (be specific, not generic):`,
    `1. VALIDATION — one thing they are doing well in their marketing or content`,
    `2. GAP — one visible weakness or missed opportunity in their content/online presence`,
    `3. OBSERVATION — one specific detail from their website or ads that shows you looked`,
    ``,
    `Max 180 words total. Use Hebrew business context. If you can't find specific info, say so briefly.`,
  ].join('\n');

  const response = await axios.post(
    PERPLEXITY_API,
    {
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.PERPLEXITY_API_KEY}`,
        'Content-Type': 'application/json',
      },
      timeout: 30_000,
    }
  );

  return response.data.choices?.[0]?.message?.content || 'Research unavailable.';
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
