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
    `Ad format: ${lead.ad_type || 'unknown'}`,
    lead.ad_copy       ? `\nActual ad copy from their Facebook ads:\n"${lead.ad_copy}"`  : null,
    lead.website_url   ? `Website: ${lead.website_url}`                                  : null,
    lead.facebook_page ? `Facebook: ${lead.facebook_page}`                               : null,
    websiteText        ? `\nWebsite content (scraped):\n${websiteText}`                  : null,
  ].filter(Boolean).join('\n');

  const response = await axios.post(CLAUDE_API, {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 300,
    messages: [{
      role: 'user',
      content: [
        `אתה מכין מחקר קצר על עסק ישראלי לפני כתיבת מייל קר בנושא הפקת תוכן וידאו.`,
        `התמקד רק בשיווק שלהם — מודעות, וידאו, ויזואל, נוכחות אונליין. אל תמציא עובדות.`,
        ``,
        contextBlock,
        ``,
        `כתוב בעברית. תן בדיוק 3 נקודות. אם יש טקסט מודעה — כל נקודה חייבת להתבסס על מילים אמיתיות מהמודעה.`,
        ``,
        `✅ חוזק — דבר אחד שהם עושים טוב בשיווק (צטט או הזכר מהמודעה/אתר)`,
        `❌ פער — חולשה ספציפית שנראית בתוכן שלהם`,
        `👁 תצפית — פרט אחד ספציפי שמוכיח שבאמת הסתכלת (מספר, פורמט, משפט מהמודעה)`,
        ``,
        `מקסימום 120 מילים. כל משפט חייב להתבסס על נתון אמיתי מהמידע לעיל.`,
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
