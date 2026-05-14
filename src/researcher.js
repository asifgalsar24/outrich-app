'use strict';

const axios = require('axios');

const CLAUDE_API = 'https://api.anthropic.com/v1/messages';

const BLOCKED_IG = new Set([
  'p', 'reel', 'reels', 'stories', 'explore', 'tv', 'accounts', 'share', 'direct', 'inbox',
  'whatsapp', 'facebook', 'meta', 'instagram', 'google', 'youtube', 'tiktok',
  'snapchat', 'twitter', 'x', 'linkedin', 'pinterest', 'shopify', 'wix', 'wordpress',
  'paypal', 'apple', 'microsoft', 'amazon',
]);

// Hosts that are not real business websites — scraping them for social links is pointless
const SKIP_HOSTS = [
  'wa.me', 'api.whatsapp.com', 'linktr.ee', 'linktree.com',
  't.me', 'telegram.me', 'bit.ly', 'goo.gl', 'tinyurl.com',
];

function toHomepageUrl(url) {
  if (!url) return null;
  try {
    const { protocol, hostname } = new URL(url);
    if (!protocol.startsWith('http')) return null;
    if (SKIP_HOSTS.some(h => hostname.endsWith(h))) return null;
    return `${protocol}//${hostname}`;
  } catch {
    return null;
  }
}

function findInstagramInHtml(html) {
  const handles = new Map();

  // Pattern 1: full or protocol-relative Instagram profile URLs
  for (const m of html.matchAll(/(?:https?:)?\/\/(?:www\.)?instagram\.com\/([\w.]+)\/?/gi)) {
    const h = m[1].toLowerCase();
    if (h.length > 1 && !BLOCKED_IG.has(h)) handles.set(h, `https://www.instagram.com/${m[1]}/`);
  }

  // Pattern 2: JSON/JS config — "instagram":"handle" or "instagramUrl":"handle"
  // Catches Wix/Next.js __INITIAL_STATE__ and schema.org sameAs handle strings
  if (handles.size === 0) {
    for (const m of html.matchAll(/["']instagram(?:_?(?:url|handle|link|page|name|username))?["']\s*[:=]\s*["']([\w.]{2,40})["']/gi)) {
      const h = m[1].toLowerCase();
      if (!h.includes('/') && !h.includes('http') && !BLOCKED_IG.has(h))
        handles.set(h, `https://www.instagram.com/${m[1]}/`);
    }
  }

  return handles.size > 0 ? [...handles.values()][0] : null;
}

// Cached guest session cookies — fetched once per process, reused for all IG searches
let _igCookies = null;

async function getInstagramCookies() {
  if (_igCookies) return _igCookies;
  try {
    const resp = await axios.get('https://www.instagram.com/', {
      timeout: 10_000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept-Language': 'he-IL,he;q=0.9,en-US;q=0.8',
      },
    });
    const setCookies = resp.headers['set-cookie'] || [];
    _igCookies = setCookies.map(c => c.split(';')[0]).join('; ');
    console.log('[IG] Session initialized, cookies:', _igCookies.slice(0, 80));
    return _igCookies;
  } catch (err) {
    console.warn('[IG] Could not init session:', err.message);
    return '';
  }
}

/**
 * Search Instagram by business name and return the best-matching profile URL.
 * Initializes a guest session first so the search endpoint accepts the request.
 */
async function findInstagramByName(companyName) {
  if (!companyName) return null;
  try {
    const cookies = await getInstagramCookies();
    const csrfMatch = cookies.match(/csrftoken=([^;]+)/);
    const csrf = csrfMatch?.[1] || '';

    const { data } = await axios.get(
      `https://www.instagram.com/web/search/topsearch/?query=${encodeURIComponent(companyName)}&context=blended&include_reel=false`,
      {
        timeout: 8_000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Accept': '*/*',
          'X-IG-App-ID': '936619743392459',
          'X-Requested-With': 'XMLHttpRequest',
          'X-CSRFToken': csrf,
          'Referer': 'https://www.instagram.com/',
          'Cookie': cookies,
        },
      }
    );

    const users = data?.users || [];
    console.log(`[IG Search] "${companyName}" → ${users.length} results`);
    if (users.length === 0) return null;

    // Score each candidate against the company name
    const norm = s => s.toLowerCase().replace(/[^a-z0-9א-ת\s]/g, '').trim();
    const nameWords = norm(companyName).split(/\s+/).filter(w => w.length > 2);

    let best = null;
    let bestScore = 0;

    for (const { user } of users.slice(0, 5)) {
      const fullName = norm(user.full_name || '');
      const handle   = norm(user.username  || '');
      let score = 0;

      for (const word of nameWords) {
        if (fullName.includes(word)) score += 2;
        if (handle.includes(word))   score += 1;
      }
      if (user.is_business) score += 1;

      if (score > bestScore) { bestScore = score; best = user; }
    }

    console.log(`[IG Search] best match: @${best?.username} score=${bestScore}`);
    if (bestScore >= 2 && best) return `https://www.instagram.com/${best.username}/`;
    return null;
  } catch (err) {
    console.warn(`[IG Search] failed for "${companyName}": ${err.response?.status ?? err.message}`);
    return null;
  }
}

/**
 * Lightweight Instagram URL extractor.
 * 1. Tries the homepage (social links live there, not on ad landing pages)
 * 2. Falls back to Instagram search by company name
 */
async function extractInstagramUrl(websiteUrl, companyName) {
  // Step 1 — website homepage scraping
  if (websiteUrl) {
    const homepageUrl = toHomepageUrl(websiteUrl);
    const urlsToTry = homepageUrl
      ? [homepageUrl, ...(homepageUrl !== websiteUrl ? [websiteUrl] : [])]
      : [websiteUrl];

    for (const url of urlsToTry) {
      try {
        const { data: html } = await axios.get(url, {
          timeout: 6_000,
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; OutReachBot/1.0)' },
        });
        const ig = findInstagramInHtml(html);
        if (ig) return ig;
      } catch { /* try next */ }
    }
  }

  // Step 2 — Instagram search by business name
  return findInstagramByName(companyName);
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
