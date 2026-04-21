'use strict';

const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const FormData = require('form-data');
const { runPipeline } = require('./pipeline');
const db = require('./db');

// Track which chats are currently running a search (prevent double-runs)
const activeSessions = new Set();

function createBot() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set in .env');

  const bot = new TelegramBot(token, { polling: true });

  bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;

    try {
      // ── Voice message ──────────────────────────────────────────────────────
      if (msg.voice) {
        await bot.sendMessage(chatId, '🎙 שומע אותך... מתמלל הודעה קולית.');
        const text = await transcribeVoice(bot, msg.voice.file_id);
        if (!text) {
          await bot.sendMessage(chatId, '❌ לא הצלחתי לתמלל את ההודעה. נסה להקליד.');
          return;
        }
        await handleUserInput(bot, chatId, text);
        return;
      }

      // ── Text message ───────────────────────────────────────────────────────
      if (msg.text) {
        await handleUserInput(bot, chatId, msg.text);
      }
    } catch (err) {
      console.error(`[Bot] Unhandled error for chat ${chatId}: ${err.message}`);
      await bot.sendMessage(chatId, `❌ אירעה שגיאה: ${err.message}`).catch(() => {});
    }
  });

  bot.on('polling_error', (err) => {
    console.error('[Bot] Polling error:', err.message);
  });

  console.log('[Bot] OutRich bot is running. Waiting for messages...');
  return bot;
}

async function handleUserInput(bot, chatId, text) {
  const trimmed = text.trim();

  // ── Built-in commands ──────────────────────────────────────────────────────
  if (trimmed.startsWith('/start') || trimmed.startsWith('/help')) {
    await sendHelp(bot, chatId);
    return;
  }

  if (trimmed.startsWith('/status')) {
    await sendStatus(bot, chatId);
    return;
  }

  if (trimmed.startsWith('/hot')) {
    await sendHotLeads(bot, chatId);
    return;
  }

  if (trimmed.startsWith('/leads')) {
    await sendRecentLeads(bot, chatId);
    return;
  }

  // ── Block concurrent runs ──────────────────────────────────────────────────
  if (activeSessions.has(chatId)) {
    await bot.sendMessage(chatId, '⏳ כבר רץ חיפוש. סבלנות — אעדכן אותך כשיסתיים.', { parse_mode: 'Markdown' });
    return;
  }

  // ── Parse search intent with Claude ───────────────────────────────────────
  const params = await parseSearchIntent(trimmed);

  if (!params) {
    await bot.sendMessage(
      chatId,
      `לא הבנתי את הבקשה 🤷\n\nנסה:\n• _"מסעדות תל אביב 20 לידים"_\n• _"חדרי כושר"_\n• _"קליניקות שיניים ירושלים"_\n\nאו שלח /help לרשימת פקודות.`,
      { parse_mode: 'Markdown' }
    );
    return;
  }

  // ── Start pipeline ─────────────────────────────────────────────────────────
  activeSessions.add(chatId);

  await bot.sendMessage(
    chatId,
    `🚀 *מתחיל חיפוש OutRich*\n\n🔑 מילת חיפוש: *${params.keyword}*\n📍 מיקום: ${params.location}\n📦 מקסימום לידים: ${params.max_leads}\n\nזה ייקח כמה דקות. אעדכן אותך בכל שלב.`,
    { parse_mode: 'Markdown' }
  );

  const onStatus = async (message) => {
    try {
      await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    } catch (err) {
      console.error(`[Bot] Failed to send status update: ${err.message}`);
    }
  };

  try {
    await runPipeline(params, onStatus);
  } finally {
    activeSessions.delete(chatId);
  }
}

// ── Command handlers ──────────────────────────────────────────────────────────

async function sendHelp(bot, chatId) {
  const msg = [
    `👋 *OutRich Agent — Legacy Media*`,
    ``,
    `שלח לי מה לחפש, ואני אמצא לך לידים חמים מ-Meta Ads.`,
    ``,
    `*דוגמאות:*`,
    `• \`מסעדות תל אביב\``,
    `• \`חדרי כושר 30 לידים\``,
    `• \`קליניקות שיניים ירושלים\``,
    `• \`נדל"ן השקעות 50\``,
    ``,
    `*פקודות:*`,
    `/hot — 5 הלידים הכי חמים שנמצאו`,
    `/leads — דוח מלא על 10 הלידים האחרונים`,
    `/status — סטטיסטיקות מערכת`,
    `/help — הודעה זו`,
    ``,
    `_אפשר גם להקליט הודעה קולית_ 🎙`,
  ].join('\n');

  await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
}

async function sendStatus(bot, chatId) {
  const hotLeads = await db.getHotLeads(100);
  const msg = [
    `📊 *סטטוס OutRich*`,
    ``,
    `🔥 לידים חמים בסיסטם: ${hotLeads.length}`,
    `📤 נשלחו ל-Lemlist: ${hotLeads.filter((l) => l.lemlist_status === 'sent').length}`,
    `💬 ענו: ${hotLeads.filter((l) => l.email_status === 'replied').length}`,
  ].join('\n');

  await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
}

async function sendHotLeads(bot, chatId) {
  const leads = await db.getHotLeads(5);

  if (leads.length === 0) {
    await bot.sendMessage(chatId, 'אין לידים חמים עדיין. שלח חיפוש כדי להתחיל.');
    return;
  }

  for (const lead of leads) {
    const msg = [
      `🔥 *${lead.company_name}* — ציון ${lead.business_score}/10`,
      ``,
      `📧 ${lead.email_address || 'אין מייל'}`,
      `🌐 ${lead.website_url || 'אין אתר'}`,
      `📱 ${lead.facebook_page || ''}`,
      ``,
      `💡 *ניתוח:* ${lead.score_reasoning || ''}`,
      `🎯 *שירות:* ${lead.suggested_service || ''}`,
      `📣 *זווית:* ${lead.outreach_angle || ''}`,
      ``,
      `📬 *סטטוס Lemlist:* ${lead.lemlist_status || 'לא נשלח'}`,
      lead.hebrew_email_draft
        ? `\n✉️ *טיוטת מייל:*\n${lead.hebrew_email_draft}`
        : '',
    ]
      .filter(Boolean)
      .join('\n');

    await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
    await sleep(300);
  }
}

async function sendRecentLeads(bot, chatId) {
  const leads = await db.getRecentLeads(10);

  if (leads.length === 0) {
    await bot.sendMessage(chatId, 'אין לידים עדיין. שלח חיפוש כדי להתחיל.');
    return;
  }

  await bot.sendMessage(chatId, `📋 *10 הלידים האחרונים:*`, { parse_mode: 'Markdown' });

  for (const lead of leads) {
    const tierEmoji = lead.lead_quality === 'hot' ? '🔥' : lead.lead_quality === 'warm' ? '🌡' : '❄️';
    const lines = [
      `${tierEmoji} *${lead.company_name}* — ציון *${lead.business_score || '?'}/10*`,
      ``,
    ];

    if (lead.website_url) lines.push(`🌐 ${lead.website_url}`);
    if (lead.facebook_page) lines.push(`📱 ${lead.facebook_page}`);
    if (lead.email_address) lines.push(`📧 ${lead.email_address}`);
    if (lead.ad_type) lines.push(`📺 סוג מודעה: ${lead.ad_type}`);

    if (lead.score_reasoning) {
      lines.push(``, `💡 *ניתוח:* ${lead.score_reasoning}`);
    }
    if (lead.suggested_service) {
      lines.push(`🎯 *שירות מוצע:* ${lead.suggested_service}`);
    }
    if (lead.outreach_angle) {
      lines.push(`📣 *זווית:* ${lead.outreach_angle}`);
    }
    if (lead.perplexity_research) {
      const short = lead.perplexity_research.slice(0, 200);
      lines.push(``, `🔬 *מחקר:* ${short}${lead.perplexity_research.length > 200 ? '...' : ''}`);
    }
    if (lead.hebrew_email_draft) {
      lines.push(``, `✉️ *טיוטת מייל:*\n${lead.hebrew_email_draft}`);
    }

    const lemStatus = lead.lemlist_status === 'sent' ? '✅ נשלח ל-Lemlist' : '⏳ לא נשלח';
    lines.push(``, `📤 ${lemStatus}`);

    await bot.sendMessage(chatId, lines.filter(Boolean).join('\n'), { parse_mode: 'Markdown' });
    await sleep(400);
  }
}

// ── Parse search intent with Claude ──────────────────────────────────────────

async function parseSearchIntent(text) {
  try {
    const response = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-sonnet-4-6',
        max_tokens: 200,
        system: `Parse Hebrew or English search requests for an Israeli lead generation tool.
Extract: keyword (business type/industry), location (default: "Israel"), max_leads (default: 50, max: 100).
If this is NOT a search request (greeting, command, question), return null.
Return ONLY valid JSON: { "keyword": "string", "location": "string", "max_leads": number } or null.`,
        messages: [{ role: 'user', content: text }],
      },
      {
        headers: {
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        timeout: 15_000,
      }
    );

    const raw = response.data.content?.[0]?.text || '';
    if (raw.trim().toLowerCase() === 'null') return null;

    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;

    const parsed = JSON.parse(match[0]);
    if (!parsed.keyword) return null;

    return {
      keyword: parsed.keyword,
      location: parsed.location || 'Israel',
      max_leads: Math.min(parsed.max_leads || 50, 100),
    };
  } catch (err) {
    console.error(`[Bot] parseSearchIntent error: ${err.message}`);
    return null;
  }
}

// ── Voice transcription via OpenAI Whisper ────────────────────────────────────

async function transcribeVoice(bot, fileId) {
  if (!process.env.OPENAI_API_KEY) {
    console.warn('[Bot] OPENAI_API_KEY not set — voice transcription skipped');
    return null;
  }

  try {
    // Get file download link from Telegram
    const fileInfo = await bot.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${fileInfo.file_path}`;

    // Download the voice file
    const fileResponse = await axios.get(fileUrl, { responseType: 'arraybuffer', timeout: 30_000 });

    // Send to Whisper
    const form = new FormData();
    form.append('file', Buffer.from(fileResponse.data), {
      filename: 'voice.ogg',
      contentType: 'audio/ogg',
    });
    form.append('model', 'whisper-1');
    form.append('language', 'he');

    const whisperResponse = await axios.post(
      'https://api.openai.com/v1/audio/transcriptions',
      form,
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          ...form.getHeaders(),
        },
        timeout: 30_000,
      }
    );

    return whisperResponse.data.text || null;
  } catch (err) {
    console.error(`[Bot] Voice transcription error: ${err.message}`);
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { createBot };
