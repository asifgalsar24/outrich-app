# OutRich — Setup Guide

## Prerequisites
- Node.js 18+ installed
- A Supabase project
- API keys for: Telegram, Apify, Anthropic, OpenRouter, Lemlist

---

## Step 1: Create your .env file

Copy the example file and fill in all values:
```
cp .env.example .env
```

Open `.env` and fill in:

| Variable | Where to get it |
|---|---|
| `TELEGRAM_BOT_TOKEN` | @BotFather → /newbot → copy token |
| `SUPABASE_URL` | Supabase Dashboard → Settings → API → Project URL |
| `SUPABASE_ANON_KEY` | Supabase Dashboard → Settings → API → anon public |
| `ANTHROPIC_API_KEY` | console.anthropic.com → API Keys |
| `APIFY_API_TOKEN` | apify.com → Settings → Integrations |
| `OPENROUTER_API_KEY` | openrouter.ai → Keys |
| `LEMLIST_API_KEY` | lemlist.com → Settings → Integrations → API |
| `LEMLIST_CAMPAIGN_ID` | Your campaign URL: `app.lemlist.com/campaigns/cam_XXXXXXX` |
| `OPENAI_API_KEY` | platform.openai.com → API Keys (optional, for voice messages) |

---

## Step 2: Create Supabase tables

1. Open your Supabase project → SQL Editor → New Query
2. Paste and run the contents of `../outrich/supabase_schema.sql`
3. Confirm 3 tables exist: `leads`, `search_requests`, `clients`

---

## Step 3: Set up Lemlist campaign

1. In Lemlist, open your campaign → Email step
2. Add a custom variable `{{icebreaker}}` in your email template
3. This is where the Hebrew cold email gets injected for each lead

---

## Step 4: Run the app

```bash
npm start
```

You should see:
```
🚀 Starting OutRich...
[Bot] OutRich bot is running. Waiting for messages...
```

---

## Step 5: Test it

Open Telegram and message your bot:

```
מסעדות תל אביב 5 לידים
```

You should get:
1. Confirmation message with search params
2. Progress updates as each pipeline step completes
3. Final summary with hot/warm/cold counts
4. Individual hot lead notifications

---

## Commands

| Command | What it does |
|---|---|
| `/start` or `/help` | Shows help and examples |
| `/hot` | Shows your 5 hottest leads with full details |
| `/status` | Shows system stats (total hot leads, sent, replied) |
| Any text | Parsed as a search request |
| Voice message | Transcribed by Whisper then parsed as text |

---

## How the pipeline works

```
1. Telegram message
      ↓
2. Claude parses intent → keyword, location, max_leads
      ↓
3. Apify scrapes Meta Ads Library (Israel)
      ↓
4. Data cleaned → inserted into Supabase leads table
      ↓
5. Claude scores each lead 1–10
   • 8–10 = HOT → goes to research + email + Lemlist
   • 5–7  = WARM → saved in Supabase, no outreach
   • 1–4  = COLD → logged only
      ↓
6. Perplexity (via OpenRouter) researches each qualified lead
      ↓
7. Claude writes personalized Hebrew cold email
      ↓
8. Claude quality checker approves or rewrites email
      ↓
9. Hot leads (8+) with approved emails → pushed to Lemlist campaign
      ↓
10. Summary sent to Telegram
```

---

## File structure

```
outrich-app/
├── index.js          ← Entry point, starts bot
├── .env              ← Your API keys (create from .env.example)
├── package.json
└── src/
    ├── bot.js        ← Telegram bot, message handler, voice support
    ├── pipeline.js   ← Orchestrates the full 5-step pipeline
    ├── scraper.js    ← Apify Meta Ads scraping
    ├── scorer.js     ← Claude lead scoring (1–10)
    ├── researcher.js ← Perplexity business research
    ├── writer.js     ← Claude Hebrew email writer + quality checker
    ├── lemlist.js    ← Lemlist campaign push
    └── db.js         ← All Supabase operations
```

---

## Troubleshooting

**Bot doesn't respond**
- Check `TELEGRAM_BOT_TOKEN` is correct
- Make sure you messaged YOUR bot (not @BotFather)

**"supabaseUrl is required" on start**
- You haven't created `.env` yet — copy from `.env.example`

**Apify returns 0 leads**
- Try a broader keyword (e.g. `מסעדות` instead of `פיצה מרכז תל אביב`)
- Check your Apify token has credits remaining

**Leads not going to Lemlist**
- Leads need an `email_address` to be pushed
- Most Meta Ads leads have no email — add Hunter.io enrichment (Post-MVP Feature 2)
- Check `LEMLIST_CAMPAIGN_ID` is correct

**Pipeline times out**
- Reduce `max_leads` to 10–20 for testing
- The full pipeline for 50 leads takes ~10–15 minutes
