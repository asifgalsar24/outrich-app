'use strict';

const axios = require('axios');

const CLAUDE_API = 'https://api.anthropic.com/v1/messages';

const BLOCKED_IG = new Set([
  'p', 'reel', 'reels', 'stories', 'explore', 'tv', 'accounts', 'share', 'direct', 'inbox',
  'whatsapp', 'facebook', 'meta', 'instagram', 'google', 'youtube', 'tiktok',
  'snapchat', 'twitter', 'x', 'linkedin', 'pinterest', 'shopify', 'wix', 'wordpress',
  'paypal', 'apple', 'microsoft', 'amazon',
]);

function findInstagramInHtml(html) {
  const allMatches = [...html.matchAll(/https?:\/\/(?:www\.)?instagram\.com\/([\w.]+)\/?/gi)];
  const candidates = allMatches
    .map(m => ({ handle: m[1].toLowerCase(), url: `https://www.instagram.com/${m[1]}/` }))
    .filter(({ handle }) => handle.length > 1 && !BLOCKED_IG.has(handle));
  const unique = [...new Map(candidates.map(c => [c.handle, c])).values()];
  return unique[0]?.url || null;
}

/**
 * Lightweight Instagram URL extractor — just fetches the website and scans for an IG link.
 * No Claude, no content parsing. Used for the fast IG discovery pass in the pipeline.
 */
async function extractInstagramUrl(websiteUrl) {
  if (!websiteUrl) return null;
  try {
    const { data: html } = await axios.get(websiteUrl, {
      timeout: 6_000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; OutReachBot/1.0)' },
    });
    return findInstagramInHtml(html);
  } catch {
    return null;
  }
}

async function scrapeWebsite(url) {
  if (!url) return { content: null, instagram_url: null };
  try {
    const { data: html } = await axios.get(url, {
      timeout: 8_000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; OutReachBot/1.0)' },
    });

    const clean = (s) => (s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

    const title = clean(html.match(/<title[^>]*>(.*?)<\/title>/is)?.[1] || '');
    const metaDesc = clean(
      html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i)?.[1] || ''
    );
    const headings = [...html.matchAll(/<h[12][^>]*>(.*?)<\/h[12]>/gis)]
      .map(m => clean(m[1]))
      .filter(s => s.length > 2 && s.length < 120)
      .slice(0, 6)
      .join(' | ');
    const body = html
      .replace(/<(script|style|nav|footer|header)[^>]*>[\s\S]*?<\/\1>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 800);

    const parts = [
      title    ? `כותרת אתר: ${title}`  : null,
      metaDesc ? `תיאור: ${metaDesc}`   : null,
      headings ? `כותרות: ${headings}`   : null,
      body     ? `תוכן: ${body}`         : null,
    ].filter(Boolean);

    const instagram_url = findInstagramInHtml(html);

    return {
      content: parts.length ? parts.join('\n').slice(0, 2000) : null,
      instagram_url,
    };
  } catch {
    return { content: null, instagram_url: null };
  }
}

async function researchLead(lead) {
  const websiteData = await scrapeWebsite(lead.website_url);

  // Don't treat template-variable-only copy as real ad content
  const hasRealAdCopy = lead.ad_copy &&
    lead.ad_copy.length > 20 &&
    !lead.ad_copy.includes('{{');

  const contextBlock = [
    `Business: ${lead.company_name}`,
    `Industry: ${lead.niche}`,
    `Ad format (confirmed): ${lead.ad_type || 'unknown'}`,
    hasRealAdCopy           ? `\nActual ad copy from their Facebook ads:\n"${lead.ad_copy}"` : null,
    lead.website_url        ? `Website: ${lead.website_url}`                                 : null,
    lead.facebook_page      ? `Facebook: ${lead.facebook_page}`                              : null,
    websiteData.content     ? `\nWebsite content (scraped):\n${websiteData.content}`         : null,
  ].filter(Boolean).join('\n');

  const response = await axios.post(CLAUDE_API, {
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 500,
    messages: [{
      role: 'user',
      content: [
        `אתה מכין מחקר קצר על עסק ישראלי לפני כתיבת מייל קר בנושא הפקת תוכן וידאו.`,
        `התמקד רק בשיווק שלהם — מודעות, וידאו, ויזואל, נוכחות אונליין.`,
        ``,
        contextBlock,
        ``,
        `כללי ברזל:`,
        `- כתוב בעברית בלבד.`,
        `- כל נקודה חייבת להתבסס על מילים או נתונים אמיתיים מהמידע לעיל — לא על הנחות.`,
        `- אם יש טקסט מודעה אמיתי — צטט ממנו ישירות.`,
        `- אם אין מספיק נתונים לנקודה מסוימת — דלג עליה. עדיף 2 נקודות חזקות מ-3 חלשות.`,
        `- אל תמציא עובדות. אל תשתמש בניסוחים כמו "כנראה" או "ייתכן".`,
        `- אם Ad format הוא "video" — אל תציין "חסר וידאו" כפער. הם כבר מפרסמים בוידאו.`,
        ``,
        `כתוב 2–3 נקודות בפורמט הזה:`,
        `✅ חוזק — דבר אחד שהם עושים טוב בשיווק (צטט או הזכר ספציפית מהמודעה/אתר)`,
        `❌ פער — חולשה ספציפית שנראית בתוכן שלהם`,
        `👁 תצפית — פרט אחד ספציפי שמוכיח שבאמת הסתכלת (מספר, פורמט, משפט מהמודעה)`,
        ``,
        `מקסימום 120 מילים סה"כ.`,
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

  return {
    text: response.data.content?.[0]?.text || 'Research unavailable.',
    instagram_url: websiteData.instagram_url || null,
  };
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

module.exports = { researchLead, researchLeads, extractInstagramUrl };
