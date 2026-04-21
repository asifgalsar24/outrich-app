'use strict';

require('dotenv').config();

// Validate required env vars before starting
const REQUIRED = [
  'TELEGRAM_BOT_TOKEN',
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'ANTHROPIC_API_KEY',
  'OPENROUTER_API_KEY',
  'LEMLIST_API_KEY',
  'LEMLIST_CAMPAIGN_ID',
];

const missing = REQUIRED.filter((key) => !process.env[key]);
if (missing.length > 0) {
  console.error('❌ Missing required environment variables:');
  missing.forEach((key) => console.error(`   - ${key}`));
  console.error('\nCopy .env.example to .env and fill in all values.');
  process.exit(1);
}

const { createBot } = require('./src/bot');
const { createServer } = require('./src/server');

console.log('🚀 Starting OutRich...');
createBot();
createServer();
