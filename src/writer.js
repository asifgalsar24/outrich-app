'use strict';

const axios = require('axios');

const CLAUDE_API = 'https://api.anthropic.com/v1/messages';

function buildCheckerSystem(voiceProfile = {}) {
  const forbidden = (voiceProfile.phrases_to_avoid || '').trim();
  const example   = (voiceProfile.example_writing  || '').trim();
  const lines = [
    `You are a quality checker for Hebrew cold emails. Return ONLY valid JSON, no other text.`,
    ``,
    `Check all criteria:`,
    `1. References something SPECIFIC about this business — not generic boilerplate`,
    `2. Hebrew is natural and conversational — not robotic or translated-sounding`,
    `3. Exactly one clear CTA`,
    `4. Does NOT open with "מקווה שהכל בסדר" or similar filler`,
    `5. Short — no more than 6 sentences`,
  ];
  if (forbidden) lines.push(`6. Does NOT contain banned phrases: ${forbidden}`);
  if (example) {
    lines.push(``);
    lines.push(`Voice match — the client's own example email (their style):`);
    lines.push(`---`);
    lines.push(example);
    lines.push(`---`);
    lines.push(`7. Does the email sound like the same person wrote both? Same length, directness, warmth. If not — rewrite to match.`);
  }
  lines.push(``);
  lines.push(`If approved=false, rewrite to fix all issues and put it in final_email.`);
  lines.push(`If approved=true, copy the original verbatim to final_email.`);
  lines.push(``);
  lines.push(`Return ONLY: { "approved": true/false, "issue": "reason or empty string", "final_email": "..." }`);
  return lines.join('\n');
}

function parseResearchHooks(research) {
  if (!research) return null;
  const strength    = research.match(/✅[^❌👁]*(?:\n(?![❌👁])[^\n]*)*/)?.[0]
    ?.replace(/✅\s*חוזק\s*[—–-]\s*/, '').trim() || null;
  const gap         = research.match(/❌[^✅👁]*(?:\n(?![✅👁])[^\n]*)*/)?.[0]
    ?.replace(/❌\s*פער\s*[—–-]\s*/, '').trim() || null;
  const observation = research.match(/👁[^✅❌]*(?:\n(?![✅❌])[^\n]*)*/)?.[0]
    ?.replace(/👁\s*תצפית\s*[—–-]\s*/, '').trim() || null;
  return { strength, gap, observation };
}

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

  if (phrases_to_use.trim()) {
    lines.push('');
    lines.push(`ביטויים שאפשר להשתמש בהם: ${phrases_to_use}`);
  }

  if (phrases_to_avoid.trim()) {
    lines.push('');
    lines.push(`ביטויים שאסור בהחלט להשתמש: ${phrases_to_avoid}`);
  }

  if (example_writing.trim()) {
    lines.push('');
    lines.push('כך אתה כותב. כתוב בדיוק באותו סגנון, אורך ותחושה:');
    lines.push('---');
    lines.push(example_writing.trim());
    lines.push('---');
    lines.push('');
    lines.push('הנחיות למייל החדש:');
    lines.push('- אורך זהה לדוגמה — לא יותר, לא פחות');
    lines.push('- אותה תחושה: חמה, ישירה, אנושית — לא רובוטית ולא תבניתית');
    lines.push('- פתח עם ה-OBSERVATION מהמחקר — ציין פרט ספציפי שראית (לא "ראיתי את הפרסומות שלך")');
    lines.push('- שלב את ה-GAP בטבעיות — הפער שזיהית בתוכן שלהם');
    lines.push('- שורה קצרה על מה שאתה מציע');
  } else {
    lines.push('');
    lines.push(`טון: ${tone_description || 'חם, ישיר, אנושי, לא רובוטי'}`);
    lines.push(`אורך מקסימלי: ${email_max_words} מילים`);
    lines.push('- אל תתחיל בפתיחה גנרית ("מקווה שהכל בסדר" וכדומה)');
    lines.push('- פתח עם תצפית ספציפית מהמחקר');
    lines.push('- זהה פער ספציפי, הצע פתרון');
  }

  if (portfolio_url.trim()) {
    const desc = portfolio_description.trim() || 'דוגמאות לעבודות שלנו:';
    lines.push(`- הוסף שורה עם הפורטפוליו: "${desc} ${portfolio_url.trim()}"`);
  }
  lines.push(`- ${ctaGuide}`);

  return lines.join('\n');
}

/**
 * Write a Hebrew cold email for a lead using Claude.
 */
async function writeEmail(lead, voiceProfile = {}) {
  const system = buildWriterSystem(voiceProfile);

  const hooks = parseResearchHooks(lead.perplexity_research);
  const hookSection = [
    hooks?.observation ? `👁 פתח עם זה (שורה 1): ${hooks.observation}` : null,
    hooks?.gap         ? `❌ נקודת הכאב (שורה 2): ${hooks.gap}` : null,
    hooks?.strength    ? `✅ לציין בדרך (אופציונלי): ${hooks.strength}` : null,
  ].filter(Boolean).join('\n');

  const userContent = [
    `כתוב מייל קר עבור העסק הזה:`,
    ``,
    `שם העסק: ${lead.company_name}`,
    `תחום: ${lead.niche}`,
    `סוג מודעות: ${lead.ad_type}`,
    ``,
    `תוצאות מחקר — השתמש בהם בסדר הבא:`,
    hookSection || lead.perplexity_research || 'אין מידע מחקר',
    ``,
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
async function checkEmail(companyName, emailDraft, voiceProfile = {}) {
  const userContent = `Review this email for ${companyName}:\n\n${emailDraft}`;

  const response = await axios.post(
    CLAUDE_API,
    {
      model: 'claude-sonnet-4-6',
      max_tokens: 600,
      system: buildCheckerSystem(voiceProfile),
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
  const checked = await checkEmail(lead.company_name, draft, voiceProfile);

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
