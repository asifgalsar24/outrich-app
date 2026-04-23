'use strict';

const { chromium } = require('playwright-chromium');

/**
 * Scrape Meta Ads Library by intercepting the internal GraphQL calls.
 * Retries up to 3 times with a different proxy IP each attempt.
 */
async function scrapeMetaAds({ keyword, location = 'Israel', max_leads = 50 }) {
  console.log(`[Scraper] Launching browser: keyword="${keyword}", max=${max_leads}`);

  const proxyUrls = process.env.PROXY_URL
    ? process.env.PROXY_URL.split(',').map(s => s.trim()).filter(Boolean)
    : [];

  const maxAttempts = proxyUrls.length > 0 ? Math.min(3, proxyUrls.length) : 1;
  const usedIndexes = new Set();

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let proxyConfig = null;

    if (proxyUrls.length > 0) {
      let idx;
      // Pick a random index not yet used this run
      do { idx = Math.floor(Math.random() * proxyUrls.length); }
      while (usedIndexes.has(idx) && usedIndexes.size < proxyUrls.length);
      usedIndexes.add(idx);

      const _p = new URL(proxyUrls[idx]);
      proxyConfig = {
        server: `${_p.protocol}//${_p.hostname}:${_p.port}`,
        username: _p.username,
        password: _p.password,
      };
      console.log(`[Scraper] Attempt ${attempt}/${maxAttempts} — proxy: ${_p.hostname}:${_p.port}`);
    }

    const leads = await scrapeOnce({ keyword, max_leads, proxyConfig });

    if (leads.length > 0) {
      console.log(`[Scraper] Done. Returning ${leads.length} unique leads (attempt ${attempt}).`);
      return leads;
    }

    console.log(`[Scraper] Attempt ${attempt} returned 0 real ads — ${attempt < maxAttempts ? 'retrying with different proxy...' : 'giving up.'}`);
  }

  return [];
}

async function scrapeOnce({ keyword, max_leads, proxyConfig }) {
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
  if (proxyConfig) {
    launchOptions.proxy = proxyConfig;
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

  // Intercept GraphQL responses that contain real ad data (search_results_connection)
  page.on('response', async (response) => {
    const url = response.url();
    if (url.includes('graphql')) _gqlCount++;
    if (!url.includes('facebook.com') && !url.includes('fb.com')) return;
    if (!url.includes('graphql') && !url.includes('api/graphql')) return;

    try {
      const text = await response.text();
      // Only process responses with real ad nodes (not filter options)
      if (!text.includes('page_name') && !text.includes('ad_archive_id')) return;
      _gqlMatched++;
      console.log('[Scraper] Matched response (first 200):', text.slice(0, 200));

      const lines = text.split('\n').filter(l => l.trim().startsWith('{'));
      for (const line of lines) {
        try {
          const json = JSON.parse(line);
          extractFromSearchResults(json, collectedAds, keyword);
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
      console.log('[Scraper] WARNING: Login wall detected');
    }

    await dismissConsent(page);

    // Wait for search_results_connection to arrive (it's slower than filter options)
    await page.waitForTimeout(10000);

    // At least 3 scrolls to trigger lazy-load
    let scrollRounds = 0;
    const maxScrolls = Math.max(3, Math.ceil(max_leads / 10));

    while (collectedAds.length < max_leads && scrollRounds < maxScrolls) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(4000);
      scrollRounds++;
      console.log(`[Scraper] Scroll ${scrollRounds}: ${collectedAds.length} ads collected`);
    }

    console.log(`[Scraper] GraphQL total=${_gqlCount} matched=${_gqlMatched}`);
  } finally {
    await browser.close();
  }

  // Deduplicate and limit
  const seen = new Set();
  return collectedAds.filter(l => {
    const key = l.ad_id || l.company_name;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, max_leads);
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

// Navigate directly to search_results_connection.edges — the only path that contains
// keyword-filtered active ads. Avoids picking up sidebar/featured/related ad nodes.
function extractFromSearchResults(json, results, keyword) {
  const edges = json?.data?.ad_library_main?.search_results_connection?.edges;
  if (!Array.isArray(edges)) return;

  for (const edge of edges) {
    const node = edge?.node;
    if (!node) continue;

    // collated_results holds individual ad variants for this page; fall back to node itself
    const items = Array.isArray(node.collated_results) && node.collated_results.length > 0
      ? node.collated_results
      : [node];

    const resolvedCount =
      typeof node.collation_count === 'number' && node.collation_count > 0 ? node.collation_count :
      Array.isArray(node.collated_results) ? node.collated_results.length :
      1;

    for (const item of items) {
      const merged = {
        ...item,
        page_name: item.page_name || node.page_name,
        page_id: item.page_id || node.page_id,
        page_profile_uri: item.page_profile_uri || node.page_profile_uri,
        page_like_count: item.page_like_count || node.page_like_count,
        _resolved_count: resolvedCount,
      };
      const ad = buildLead(merged, keyword);
      if (ad) results.push(ad);
    }
  }
}

function buildLead(ad, keyword) {
  const name = (ad.page_name || '').trim();
  if (!name || name.length < 2) return null;

  const adId = ad.ad_archive_id || ad.id || null;

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
