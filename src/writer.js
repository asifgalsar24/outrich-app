'use strict';

const axios = require('axios');

const CLAUDE_API = 'https://api.anthropic.com/v1/messages';

const CHECKER_SYSTEM = `You are a quality checker for Hebrew cold emails. Review the email and return ONLY valid JSON, no other text.

Check all 5 criteria:
1. Is it under the word limit?
2. Does it reference something SPECIFIC about this business (not generic boilerplate)?
3. Is the Hebrew natural and conversational, not robotic or translated-sounding?
4. Does it have exactly one clear CTA (call to action)?
5. Does it avoid generic openers like "מקווה שהכל בסדר" or similar?

If approved=false, rewrite the email to fix all issues and put the corrected version in final_email.
If approved=true, copy the original email text verbatim to final_email.

Return ONLY this JSON: { "approved": true/false, "issue": "reason if not approved or empty string", "final_email": "the approved or corrected email" }`;

/**
 * Build a dynamic writer system prompt from the client's voice profile.
 */
function buildWriterSystem(profile = {}) {
  const {
    sender_name           = '',
    company_name          = '',
    service_description   = 'הפקת תוכן וידאו ומדיה מקצועית',
    tone_description      = 'ישיר, אמיתי, לא רובוטי',
    example_writing       = '',
    phrases_to_use        = '',
    phrases_to_avoid      = '',
    email_max_words       = 80,
    cta_style             = 'question',
    portfolio_url         = '',
    portfolio_description = '',
  } = profile;

  const ctaGuide = {
    question: 'CTA: שאלה ישירה — "אפשר לדבר 15 דקות?"',
    soft:     'CTA: דחיפה רכה — "שווה שנדבר?"',
    direct:   'CTA: קריאה ישירה — "בוא נקבע שיחה."',
  }[cta_style] || 'CTA: שאלה ישירה — "אפשר לדבר 15 דקות?"';

  const lines = [];

  lines.push(`אתה כותב מיילים קרים בעברית עבור ${company_name || 'הלקוח'}.`);
  if (service_description) lines.push(`השירות שאתה מציע: ${service_description}`);
  if (sender_name)         lines.push(`שם השולח: ${sender_name}`);

  lines.push('');
  lines.push(`טון הכתיבה: ${tone_description}`);

  if (example_writing.trim()) {
    lines.push('');
    lines.push('דוגמה לסגנון כתיבה (חקה את הסגנון הזה בדיוק!):');
    lines.push(`"${example_writing.trim()}"`);
  }

  if (phrases_to_use.trim()) {
    lines.push('');
    lines.push(`ביטויים שאפשר להשתמש בהם: ${phrases_to_use}`);
  }

  if (phrases_to_avoid.trim()) {
    lines.push('');
    lines.push(`ביטויים שאסור בהחלט להשתמש: ${phrases_to_avoid}`);
  }

  lines.push('');
  lines.push('חוקים:');
  lines.push(`- כתוב בעברית טבעית, ${tone_description}, לא מתורגמת`);
  lines.push(`- אורך מקסימלי: ${email_max_words} מילים`);
  lines.push('- אסור להתחיל בפתיחה גנרית ("מקווה שהכל בסדר" וכדומה)');
  lines.push('');
  lines.push('מבנה המייל:');
  lines.push('1. פתיחה עם תצפית ספציפית על הפרסום שלהם (לא גנרי)');
  lines.push('2. נקודת כאב ספציפית שזיהית בתוכן שלהם');
  lines.push('3. שורה אחת על איך אתה פותר את זה');
  if (portfolio_url.trim()) {
    const desc = portfolio_description.trim() || 'אפשר לראות דוגמאות מעבודות שלנו:';
    lines.push(`4. שורה אחת עם הפורטפוליו — בדיוק כך: "${desc} ${portfolio_url.trim()}"`);
    lines.push(`5. ${ctaGuide}`);
  } else {
    lines.push(`4. ${ctaGuide}`);
  }
  lines.push('');
  lines.push('כתוב כאילו אתה בן אדם אמיתי שבאמת הסתכל על הפרסומות שלהם.');

  return lines.join('\n');
}

/**
 * Write a Hebrew cold email for a lead using Claude.
 */
async function writeEmail(lead, voiceProfile = {}) {
  const system = buildWriterSystem(voiceProfile);

  const userContent = [
    `כתוב מייל קר עבור העסק הזה:`,
    ``,
    `שם העסק: ${lead.company_name}`,
    `תחום: ${lead.niche}`,
    `סוג מודעות: ${lead.ad_type}`,
    `מחקר על העסק: ${lead.perplexity_research || 'אין מידע'}`,
    `זווית פנייה: ${lead.outreach_angle || 'שדרוג תוכן'}`,
    `שירות מומלץ: ${lead.suggested_service || 'הפקת וידאו'}`,
  ].join('\n');

  const response = await axios.post(
    CLAUDE_API,
    {
      model: 'claude-sonnet-4-6',
      max_tokens: 500,
      system,
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

  return response.data.content?.[0]?.text || '';
}

/**
 * Quality-check an email draft with Claude.
 * Returns { approved, issue, final_email }
 */
async function checkEmail(companyName, emailDraft) {
  const userContent = `Review this email for ${companyName}:\n\n${emailDraft}`;

  const response = await axios.post(
    CLAUDE_API,
    {
      model: 'claude-sonnet-4-6',
      max_tokens: 600,
      system: CHECKER_SYSTEM,
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

  const text = response.data.content?.[0]?.text || '{}';
  return parseJSON(text, {
    approved: false,
    issue: 'Quality check parse error',
    final_email: emailDraft,
  });
}

/**
 * Write + check email for a single lead.
 * Returns { hebrew_email_draft, email_approved, email_issue }
 */
async function writeAndCheckEmail(lead, voiceProfile = {}) {
  const draft = await writeEmail(lead, voiceProfile);
  await sleep(1000);
  const checked = await checkEmail(lead.company_name, draft);

  return {
    hebrew_email_draft: checked.final_email,
    email_approved: checked.approved,
    email_issue: checked.issue || '',
  };
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

module.exports = { writeEmail, checkEmail, writeAndCheckEmail };
