'use strict';

const axios = require('axios');

const OPENROUTER_API = 'https://openrouter.ai/api/v1/chat/completions';
const PERPLEXITY_MODEL = 'perplexity/sonar';

/**
 * Research a single lead using Perplexity via OpenRouter.
 * Returns a research string (150 words max).
 */
async function researchLead(lead) {
  const prompt = [
    `Research this Israeli business for cold outreach purposes.`,
    `Business name: ${lead.company_name}`,
    `Website: ${lead.website_url || 'not available'}`,
    `Facebook page: ${lead.facebook_page || 'not available'}`,
    `Industry: ${lead.niche}`,
    ``,
    `Find and summarize (150 words max, be specific and factual):`,
    `1) What they do and who their target customers are`,
    `2) Recent campaigns, promotions, or news`,
    `3) What they are known for / their main value proposition`,
    `4) Potential pain points with their current content or media quality`,
    `5) One specific observation from their ads or online presence`,
    ``,
    `If you cannot find information about this specific business, say so briefly and describe what businesses in this niche typically need.`,
  ].join('\n');

  const response = await axios.post(
    OPENROUTER_API,
    {
      model: PERPLEXITY_MODEL,
      messages: [{ role: 'user', content: prompt }],
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://legacymedia.co.il',
        'X-Title': 'OutRich Lead Research',
      },
      timeout: 30_000,
    }
  );

  return response.data.choices?.[0]?.message?.content || 'Research unavailable.';
}

/**
 * Research all qualified leads in sequence.
 */
async function researchLeads(leads, onProgress) {
  for (let i = 0; i < leads.length; i++) {
    const lead = leads[i];
    try {
      const research = await researchLead(lead);

      if (onProgress) {
        await onProgress(lead.id, research, i + 1, leads.length);
      }

      // Brief pause between Perplexity calls
      if (i < leads.length - 1) await sleep(500);
    } catch (err) {
      console.error(`[Researcher] Failed for lead ${lead.id}: ${err.message}`);
      if (onProgress) {
        await onProgress(lead.id, 'Research failed.', i + 1, leads.length);
      }
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { researchLead, researchLeads };
