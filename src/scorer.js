'use strict';

const axios = require('axios');

const CLAUDE_API = 'https://api.anthropic.com/v1/messages';

const SYSTEM_PROMPT = `אתה סוכן ניקוד לידים עבור OutRich — שירות הפקת תוכן וידאו ומדיה של Legacy Media (חברה ישראלית).
דרג כל עסק מ-1 עד 10 לפי הסבירות שהוא יזדקק לתוכן וידאו מקצועי וישלם עליו.

חשוב: שדה "Search keyword" הוא מילת החיפוש שבה נמצא הליד — לא תיאור של העסק עצמו.
כתוב את outreach_angle לפי מה שהעסק עושה באמת (על פי שם העסק וטקסט המודעה), לא לפי מילת החיפוש.

אותות ניקוד — מספר מודעות שנמצאו:
+1 נקודה: 2–3 מודעות
+2 נקודות: 4–7 מודעות
+3 נקודות: 8+ מודעות

מודעות וידאו — video_count:
+1 נקודה: 1 מודעת וידאו
+2 נקודות: 2 מודעות וידאו
+3 נקודות: 3+ מודעות וידאו (השקעה אמיתית בוידאו)

טקסט המודעה (ad copy):
+2 נקודות: יש טקסט מודעה אמיתי (לא URL בלבד, לא ריק)
+3 נקודות: הטקסט מדגיש הצעה, מחיר או יתרון ספציפי

עוקבי אינסטגרם:
+1 נקודה: 1,000–10,000 עוקבים
+2 נקודות: 10,000–50,000 עוקבים
+3 נקודות: 50,000+ עוקבים
(אם אין נתוני אינסטגרם — השתמש בעוקבי פייסבוק כאומדן)

רמות: hot=8–10, warm=5–7, cold=1–4

חשוב מאוד: כל הטקסט בתגובה חייב להיות בעברית בלבד — score_reasoning, outreach_angle. אסור להשתמש באנגלית.
אסור להשתמש ב-Markdown. אסור לעטוף את ה-JSON בסימני \`\`\` או בטקסט כלשהו לפני או אחרי ה-JSON.
החזר JSON תקין בלבד, ללא שום טקסט נוסף לפני או אחריו:
{ "score": number, "tier": "hot" | "warm" | "cold", "score_reasoning": "string", "outreach_angle": "string" }`;

/**
 * Score a single lead with Claude.
 * Returns { score, tier, score_reasoning, suggested_service, outreach_angle }
 */
async function scoreLead(lead) {
  const userContent = [
    `Score this Israeli business:`,
    `Name: ${lead.company_name || 'Unknown'}`,
    `Search keyword: ${lead.niche}`,
    `Total ads found: ${lead.active_ads_count} (minimum)`,
    `Ad type breakdown: ${lead.video_count || 0} video / ${lead.image_count || 0} image / ${lead.carousel_count || 0} carousel`,
    `Instagram followers: ${lead.instagram_followers ?? 'unknown'}`,
    `Facebook followers: ${lead.page_followers ?? 'unknown'}`,
    `Website: ${lead.website_url || 'none'}`,
    lead.ad_copy ? `Ad copy: ${lead.ad_copy}` : null,
  ].filter(Boolean).join('\n');

  let response;
  try {
    response = await axios.post(
      CLAUDE_API,
      {
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userContent }],
      },
      {
        headers: {
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        timeout: 30_000,
      }
    );
  } catch (err) {
    const status = err.response?.status;
    const body = err.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.error(`[Scorer] HTTP error for "${lead.company_name}": status=${status} body=${body}`);
    throw err;
  }

  const text = response.data.content?.[0]?.text || '{}';
  console.log(`[Scorer] Raw Claude response for "${lead.company_name}":`, JSON.stringify(text));

  const fallback = {
    score: 5,
    tier: 'warm',
    score_reasoning: 'שגיאת עיבוד — נדרשת בדיקה ידנית',
    outreach_angle: 'שדרוג תוכן כללי',
  };

  const result = parseJSON(cleanJSON(text), fallback);

  if (result === fallback) {
    console.warn(`[Scorer] parseJSON fallback triggered for "${lead.company_name}". Cleaned text: ${JSON.stringify(cleanJSON(text))}`);
  }

  return result;
}

/**
 * Score all leads in sequence (respects rate limits).
 * Returns { hot, warm, cold } counts.
 */
async function scoreLeads(leads, onProgress) {
  const counts = { hot: 0, warm: 0, cold: 0 };

  for (let i = 0; i < leads.length; i++) {
    const lead = leads[i];
    try {
      const result = await scoreLead(lead);
      counts[result.tier] = (counts[result.tier] || 0) + 1;

      if (onProgress) {
        await onProgress(lead.id, result, i + 1, leads.length);
      }

      // Respect Claude API rate limits
      if (i < leads.length - 1) await sleep(1000);
    } catch (err) {
      console.error(`[Scorer] Failed to score lead ${lead.id}: ${err.message}`);
    }
  }

  return counts;
}

/**
 * Strip markdown code fences and surrounding whitespace before JSON extraction.
 * Handles: ```json ... ```, ``` ... ```, and any leading/trailing text.
 */
function cleanJSON(text) {
  return text
    .replace(/```(?:json)?\s*/gi, '')
    .replace(/```/g, '')
    .replace(/[""„]/g, '"')
    .replace(/['']/g, "'")
    .trim();
}

function parseJSON(text, fallback) {
  try {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return fallback;
    return JSON.parse(match[0]);
  } catch {
    return fallback;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { scoreLead, scoreLeads };
