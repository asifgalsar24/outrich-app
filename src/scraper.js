'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-chromium');

/**
 * Scrape Meta Ads Library by intercepting the internal GraphQL calls
 * the page makes when loading search results.
 */
async function scrapeMetaAds({ keyword, location = 'Israel', max_leads = 50 }) {
  console.log(`[Scraper] Launching browser: keyword="${keyword}", max=${max_leads}`);

  const launchOptions = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process',
    ],
  };
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
    launchOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  }
  // Residential proxy required when running on cloud servers (Meta blocks datacenter IPs)
  if (process.env.PROXY_URL) {
    launchOptions.proxy = { server: process.env.PROXY_URL };
    console.log('[Scraper] Using proxy:', process.env.PROXY_URL.replace(/:\/\/.*@/, '://***@'));
  }
  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    locale: 'he-IL',
    extraHTTPHeaders: { 'Accept-Language': 'he-IL,he;q=0.9,en-US;q=0.8' },
  });

  const page = await context.newPage();
  const collectedAds = [];
  let _gqlCount = 0, _gqlMatched = 0;

  // Intercept GraphQL responses that contain ad data
  page.on('response', async (response) => {
    const url = response.url();
    if (url.includes('graphql')) {
      _gqlCount++;
      console.log('[Scraper] GraphQL URL:', url.slice(0, 120));
    }
    if (!url.includes('facebook.com') && !url.includes('fb.com')) return;
    if (!url.includes('graphql') && !url.includes('api/graphql')) return;

    try {
      const text = await response.text();
      if (!text.includes('page_name') && !text.includes('ad_archive_id')) return;
      _gqlMatched++;
      console.log('[Scraper] Matched response (first 200):', text.slice(0, 200));

      // Facebook often returns multiple JSON objects per line (JSONP-like)
      const lines = text.split('\n').filter(l => l.trim().startsWith('{'));
      for (const line of lines) {
        try {
          const json = JSON.parse(line);
          extractAdsFromGraphQL(json, collectedAds, keyword);
        } catch { /* skip malformed lines */ }
      }
    } catch { /* skip unreadable responses */ }
  });

  try {
    const url = buildAdsLibraryUrl(keyword);
    console.log(`[Scraper] Opening: ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });

    const title = await page.title();
    console.log('[Scraper] Page title:', title);
    if (title.toLowerCase().includes('log in') || title.toLowerCase().includes('sign up')) {
      console.log('[Scraper] WARNING: Login wall detected — proxy may not be bypassing auth');
    }

    // Dismiss cookie consent
    await dismissConsent(page);

    // Wait for initial load
    await page.waitForTimeout(4000);

    // Scroll to trigger more loads
    let scrollRounds = 0;
    const maxScrolls = Math.ceil(max_leads / 10);

    while (collectedAds.length < max_leads && scrollRounds < maxScrolls) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(2500);
      scrollRounds++;
      console.log(`[Scraper] Scroll ${scrollRounds}: ${collectedAds.length} ads collected`);
    }

    console.log(`[Scraper] GraphQL total=${_gqlCount} matched=${_gqlMatched}`);
  } finally {
    await browser.close();
  }

  // Deduplicate and limit
  const seen = new Set();
  const deduped = collectedAds.filter(l => {
    const key = l.ad_id || l.company_name;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, max_leads);

  console.log(`[Scraper] Done. Returning ${deduped.length} unique leads.`);
  return deduped;
}

function buildAdsLibraryUrl(keyword) {
  const u = new URL('https://www.facebook.com/ads/library/');
  u.searchParams.set('active_status', 'active');
  u.searchParams.set('ad_type', 'all');
  u.searchParams.set('country', 'IL');
  u.searchParams.set('q', keyword);
  u.searchParams.set('search_type', 'keyword_unordered');
  u.searchParams.set('media_type', 'all');
  return u.toString();
}

async function dismissConsent(page) {
  try {
    const selectors = [
      '[data-cookiebanner="accept_button"]',
      'button[title="Allow all cookies"]',
      'button:has-text("Allow all cookies")',
      '[aria-label="Allow all cookies"]',
    ];
    for (const sel of selectors) {
      const btn = page.locator(sel);
      if (await btn.isVisible({ timeout: 2000 })) {
        await btn.click();
        await page.waitForTimeout(800);
        return;
      }
    }
  } catch { /* no consent dialog */ }
}

function extractAdsFromGraphQL(obj, results, keyword) {
  // Recursively walk JSON to find ad objects
  if (!obj || typeof obj !== 'object') return;

  // Detect an ad node by presence of page_name + ad_archive_id
  if (obj.page_name && (obj.ad_archive_id || obj.id)) {
    // Dump first 3 ad nodes to file so we can identify the real total-ad-count field
    if (results.length < 3) {
      const dumpPath = path.join(__dirname, `../ad_node_dump_${results.length}.json`);
      try {
        // Truncate huge arrays (snapshot etc) so the file stays readable
        const safe = JSON.parse(JSON.stringify(obj, (k, v) =>
          Array.isArray(v) && v.length > 5 ? `[Array(${v.length})]` : v
        ));
        fs.writeFileSync(dumpPath, JSON.stringify(safe, null, 2));
        console.log(`[Scraper] Ad node ${results.length} dumped to ${dumpPath}`);
      } catch (e) { /* ignore write errors */ }
      console.log(`[Scraper] Ad node ${results.length} keys:`, Object.keys(obj).join(', '));
      // Log any numeric fields that might hold total ad count
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === 'number') console.log(`  [Scraper]   ${k} = ${v}`);
      }
    }

    // Resolve total ad count.
    // collation_count = how many collated versions of this ad are running (Meta's own count field).
    // Sum these across all ads from the same company in groupLeadsByCompany.
    const nestedAds = Array.isArray(obj.collated_results) ? obj.collated_results : [];
    const resolvedCount =
      typeof obj.collation_count === 'number' && obj.collation_count > 0 ? obj.collation_count :
      typeof obj.total_active_ads_count === 'number' ? obj.total_active_ads_count :
      typeof obj.ad_count === 'number' ? obj.ad_count :
      nestedAds.length > 0 ? nestedAds.length :
      1;

    const ad = buildLead({ ...obj, _resolved_count: resolvedCount }, keyword);
    if (ad) results.push(ad);

    // If there are nested ads (individual entries within this page node),
    // also walk them so their unique ad_ids get counted in groupLeadsByCompany.
    // We skip items that already have a page_name (they'd be handled as full nodes above).
    for (const nested of nestedAds) {
      if (nested.ad_archive_id && !nested.page_name) {
        extractAdsFromGraphQL({ ...nested, page_name: obj.page_name, page_id: obj.page_id, page_profile_uri: obj.page_profile_uri, page_like_count: obj.page_like_count }, results, keyword);
      }
    }
    return;
  }

  // Also handle collated_results arrays at the top level
  if (Array.isArray(obj.collated_results)) {
    for (const item of obj.collated_results) {
      extractAdsFromGraphQL(item, results, keyword);
    }
    return;
  }

  // Keep walking
  if (Array.isArray(obj)) {
    for (const item of obj) extractAdsFromGraphQL(item, results, keyword);
  } else {
    for (const val of Object.values(obj)) extractAdsFromGraphQL(val, results, keyword);
  }
}

function buildLead(ad, keyword) {
  const name = (ad.page_name || '').trim();
  if (!name || name.length < 2) return null;

  const adId = String(ad.ad_archive_id || ad.id || '');

  // Detect ad type from creative
  const creative = ad.snapshot || ad.ad_creative || {};
  const hasVideo = !!(creative.videos?.length || creative.video_sd_url);
  const hasCarousel = !!(creative.cards?.length > 1);
  const adType = hasVideo ? 'video' : hasCarousel ? 'carousel' : 'image';

  return {
    company_name: name,
    ad_url: adId ? `https://www.facebook.com/ads/library/?id=${adId}` : '',
    ad_type: adType,
    ad_id: adId,
    website_url: creative.link_url || creative.linkUrl || '',
    facebook_page: ad.page_profile_uri || (ad.page_id ? `https://www.facebook.com/${ad.page_id}` : ''),
    niche: keyword,
    location: 'Israel',
    active_ads_count:
      typeof ad._resolved_count === 'number' ? ad._resolved_count :
      typeof ad.total_active_ads_count === 'number' ? ad.total_active_ads_count :
      typeof ad.active_ads_count === 'number' ? ad.active_ads_count :
      Array.isArray(ad.collated_results) ? ad.collated_results.length :
      typeof ad.ad_count === 'number' ? ad.ad_count :
      1,
    page_followers: ad.page_like_count || null,
    source: 'meta_ads',
  };
}

module.exports = { scrapeMetaAds };
