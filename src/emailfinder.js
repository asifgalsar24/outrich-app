'use strict';

const axios = require('axios');

/**
 * Try to find a contact email for a lead using Hunter.io domain search.
 * Returns an email string or null if not found / API key not set.
 */
async function findEmail(lead) {
  const apiKey = process.env.HUNTER_API_KEY;
  if (!apiKey) {
    console.log(`[EmailFinder] HUNTER_API_KEY not set — skipping email lookup for ${lead.company_name}`);
    return null;
  }

  // Extract domain from website_url
  const domain = extractDomain(lead.website_url);
  if (!domain) {
    console.log(`[EmailFinder] No domain for ${lead.company_name} — skipping`);
    return null;
  }

  try {
    const response = await axios.get('https://api.hunter.io/v2/domain-search', {
      params: { domain, api_key: apiKey, limit: 5 },
      timeout: 10_000,
    });

    const emails = response.data?.data?.emails || [];
    if (emails.length === 0) {
      console.log(`[EmailFinder] No emails found for domain: ${domain}`);
      return null;
    }

    // Prefer marketing/contact/info emails, otherwise take first
    const preferred = emails.find((e) =>
      /^(marketing|contact|info|hello|hi|sales|team)@/.test(e.value)
    );
    const chosen = (preferred || emails[0]).value;
    console.log(`[EmailFinder] Found email for ${lead.company_name}: ${chosen}`);
    return chosen;
  } catch (err) {
    const status = err.response?.status;
    if (status === 429) {
      console.warn('[EmailFinder] Hunter.io rate limit reached');
    } else {
      console.error(`[EmailFinder] Error for ${domain}: ${err.message}`);
    }
    return null;
  }
}

function extractDomain(url) {
  if (!url) return null;
  try {
    const u = new URL(url.startsWith('http') ? url : `https://${url}`);
    return u.hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

module.exports = { findEmail };
