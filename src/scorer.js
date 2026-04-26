'use strict';

const axios = require('axios');

const CLAUDE_API = 'https://api.anthropic.com/v1/messages';

const SYSTEM_PROMPT = `אתה סוכן ניקוד לידים עבור OutRich — שירות הפקת תוכן וידאו ומדיה של Legacy Media (חברה ישראלית).
דרג כל עסק מ-1 עד 10 לפי הסבירות שהוא יזדקק לתוכן וידאו מקצועי וישלם עליו.

אותות ניקוד — מספר מודעות שנמצאו בסריקה (סימן לתקציב פרסום, לא בהכרח המספר הכולל):
+1 נקודה: 2–3 מודעות שנמצאו (מתחיל להשקיע בפרסום)
+2 נקודות: 4–7 מודעות שנמצאו (מפרסם רציני עם תקציב ברור)
+3 נקודות: 8+ מודעות שנמצאו (תקציב מדיה גבוה — לקוח פרימיום)

אותות ניקוד נוספים:
+3 נקודות: סוג המודעה הוא וידאו (כבר משקיע בוידאו — צריך שדרוג איכות)
+2 נקודות: נישה בעלת ערך גבוה: נדל"ן, אירועים, כושר, אירוח, ספורט, מסעדות, קליניקות/שיניים, עורכי דין
+2 נקודות: פחות מ-5,000 עוקבים בדף (יש לאן לצמוח — צריך עזרה במדיה)
+1 נקודה: אין עקביות ויזואלית ברורה במודעות

רמות: hot=8–10, warm=5–7, cold=1–4

חשוב מאוד: כל הטקסט בתגובה חייב להיות בעברית בלבד — score_reasoning, suggested_service, outreach_angle. אסור להשתמש באנגלית.
אסור להשתמש ב-Markdown. אסור לעטוף את ה-JSON בסימני \`\`\` או בטקסט כלשהו לפני או אחרי ה-JSON.
החזר JSON תקין בלבד, ללא שום טקסט נוסף לפני או אחריו:
{ "score": number, "tier": "hot" | "warm" | "cold", "score_reasoning": "string", "suggested_service": "string", "outreach_angle": "string" }`;

/**
 * Score a single lead with Claude.
 * Returns { score, tier, score_reasoning, suggested_service, outreach_angle }
 */
async function scoreLead(lead) {
  const userContent = [
    `Score this Israeli business:`,
    `Name: ${lead.company_name || 'Unknown'}`,
    `Ad type: ${lead.ad_type}`,
    `Ads found during scrape: ${lead.active_ads_count} (minimum count — actual may be higher)`,
    `Page followers: ${lead.page_followers ?? 'unknown'}`,
    `Website: ${lead.website_url || 'none'}`,
    `Niche: ${lead.niche}`,
  ].join('\n');

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
    score_reasoning: 'Parse error — manual review needed',
    suggested_service: 'Video production',
    outreach_angle: 'General content upgrade',
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
