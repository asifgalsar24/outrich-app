'use strict';

const axios = require('axios');

/**
 * Push a single lead to a Lemlist campaign.
 * lead must have: email_address, company_name, hebrew_email_draft
 */
async function pushToLemlist(lead) {
  if (!lead.email_address) {
    console.log(`[Lemlist] Skipped ${lead.company_name} — no email address`);
    return { skipped: true, reason: 'no_email' };
  }

  const campaignId = process.env.LEMLIST_CAMPAIGN_ID;
  const apiKey = process.env.LEMLIST_API_KEY;
  const authHeader = 'Basic ' + Buffer.from(`:${apiKey}`).toString('base64');

  const url = `https://api.lemlist.com/api/campaigns/${campaignId}/leads/${encodeURIComponent(lead.email_address)}`;

  const body = {
    firstName: lead.company_name,
    companyName: lead.company_name,
    icebreaker: lead.hebrew_email_draft,
  };

  await axios.post(url, body, {
    headers: {
      Authorization: authHeader,
      'Content-Type': 'application/json',
    },
    timeout: 15_000,
  });

  console.log(`[Lemlist] Pushed: ${lead.company_name} <${lead.email_address}>`);
  return { skipped: false };
}

module.exports = { pushToLemlist };
