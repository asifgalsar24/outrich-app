'use strict';

const db = require('./db');
const { scrapeMetaAds } = require('./scraper');
const { scoreLead } = require('./scorer');
const { researchLead, extractInstagramUrl } = require('./researcher');
const { writeAndCheckEmail } = require('./writer');

const SCORE_BATCH   = 5; // concurrent Claude scoring calls
const RESEARCH_BATCH = 3; // concurrent Perplexity + email calls (slower API)

/**
 * Run the full OutRich pipeline for one search request.
 */
async function runPipeline({ keyword, location = 'Israel', max_leads = 50, user_id, voice_profile = {} }, onStatus) {
  const notify = onStatus || (() => {});

  const requestId = await db.createSearchRequest({ keyword, location, max_leads, client_id: user_id });

  try {
    // ── STEP 1: SCRAPE ────────────────────────────────────────────────────────
    await notify(`🔍 שלב 1/3: סורק מודעות Meta Ads עבור *${keyword}*...`);
    const rawLeads = await scrapeMetaAds({ keyword, location, max_leads });

    if (rawLeads.length === 0) {
      await notify(`⚠️ לא נמצאו מודעות עבור "${keyword}". נסה מילת חיפוש אחרת.`);
      await db.failSearchRequest(requestId);
      return;
    }

    // ── STEP 2: GROUP BY COMPANY + INSERT TO DB ──────────────────────────────
    const grouped = groupLeadsByCompany(rawLeads);
    const mergedLeads = Array.from(new Map(grouped.map(l => [l.facebook_page, l])).values());
    await notify(`📦 קיבצנו ${rawLeads.length} מודעות ל-*${mergedLeads.length}* עסקים ייחודיים.`);

    const mergedByPage = new Map(mergedLeads.map(l => [l.facebook_page, l]));
    const inserted = await db.insertLeads(mergedLeads, user_id);
    await notify(`נמצאו *${inserted.length}* לידים חדשים/מרועננים. מנתח...`);

    // ── STEP 3: SCORE — parallel batches ─────────────────────────────────────
    await notify(`🧠 שלב 2/3: מנתח ומדרג עסקים עם Claude (${SCORE_BATCH} במקביל)...`);
    const counts = { hot: 0, warm: 0, cold: 0 };
    const qualifiedFromThisRun = [];

    for (let i = 0; i < inserted.length; i += SCORE_BATCH) {
      const batch = inserted.slice(i, i + SCORE_BATCH);

      const batchResults = await Promise.allSettled(
        batch.map(async ({ id, facebook_page }) => {
          const lead = mergedByPage.get(facebook_page) || { id, facebook_page };
          const scoreResult = await scoreLead({ ...lead, id });
          await db.updateLeadScore(id, {
            business_score: scoreResult.score,
            lead_quality: scoreResult.tier,
            score_reasoning: scoreResult.score_reasoning,
            outreach_angle: scoreResult.outreach_angle,
          });
          return { lead: { ...lead, id }, scoreResult };
        })
      );

      for (const result of batchResults) {
        if (result.status === 'fulfilled') {
          const { lead, scoreResult } = result.value;
          counts[scoreResult.tier] = (counts[scoreResult.tier] || 0) + 1;
          if (scoreResult.score >= 5) {
            qualifiedFromThisRun.push({ ...lead, ...scoreResult });
          }
        } else {
          console.error(`[Pipeline] Score batch error: ${result.reason?.message}`);
        }
      }

      const done = Math.min(i + SCORE_BATCH, inserted.length);
      await notify(`   ניקוד: ${done}/${inserted.length} | 🔥 ${counts.hot} | 🌡 ${counts.warm} | ❄️ ${counts.cold}`);

      // Brief pause between batches to respect rate limits
      if (i + SCORE_BATCH < inserted.length) await sleep(500);
    }

    await notify(
      `✅ שלב 2 הושלם!\n\n🔥 חם: *${counts.hot}* | 🌡 ביניים: *${counts.warm}* | ❄️ קר: *${counts.cold}*\n\nמתחיל מחקר על הלידים החמים והבינוניים (ציון 5+)...`
    );

    // ── STEP 3.5: IG DISCOVERY — scan all lead websites for Instagram links ──
    const toFindIg = inserted
      .map(({ id, facebook_page }) => ({ id, ...(mergedByPage.get(facebook_page) || {}) }))
      .filter(l => l.website_url && !l.instagram_page);

    if (toFindIg.length > 0) {
      await notify(`📸 מחפש אינסטגרם ב-${toFindIg.length} אתרים...`);
      const IG_BATCH = 8;
      let igFound = 0;
      for (let i = 0; i < toFindIg.length; i += IG_BATCH) {
        const batch = toFindIg.slice(i, i + IG_BATCH);
        const results = await Promise.allSettled(
          batch.map(async (lead) => {
            const url = await extractInstagramUrl(lead.website_url, lead.company_name);
            if (url) {
              await db.updateLeadInstagram(lead.id, url);
              return true;
            }
            return false;
          })
        );
        igFound += results.filter(r => r.status === 'fulfilled' && r.value).length;
      }
      await notify(`   נמצאו ${igFound}/${toFindIg.length} לינקים לאינסטגרם מאתרי העסקים.`);
    }

    // ── STEP 4: RESEARCH + WRITE + PUSH — parallel batches ───────────────────
    if (qualifiedFromThisRun.length === 0) {
      await notify(`ℹ️ אין לידים עם ציון 7+ הפעם. אפשר לשנות מילת חיפוש ולנסות שוב.`);
      await db.finalizeSearchRequest(requestId, { leads_found: inserted.length, ...counts });
      return;
    }

    await notify(`📝 שלב 3/3: מחקר + כתיבת הודעות עבור *${qualifiedFromThisRun.length}* לידים (${RESEARCH_BATCH} במקביל)...`);

    let emailsWritten = 0;

    for (let i = 0; i < qualifiedFromThisRun.length; i += RESEARCH_BATCH) {
      const batch = qualifiedFromThisRun.slice(i, i + RESEARCH_BATCH);

      const batchResults = await Promise.allSettled(
        batch.map(async (lead) => {
          // Research — returns { text, instagram_url }
          const research = await researchLead(lead);
          await db.updateLeadResearch(lead.id, research.text);
          if (research.instagram_url && !lead.instagram_page) {
            await db.updateLeadInstagram(lead.id, research.instagram_url);
          }

          // Write + check email
          const enrichedLead = { ...lead, perplexity_research: research.text };
          const emailResult = await writeAndCheckEmail(enrichedLead, voice_profile);
          await db.updateLeadEmail(lead.id, emailResult);

          return { emailWritten: true };
        })
      );

      for (const result of batchResults) {
        if (result.status === 'fulfilled') {
          if (result.value.emailWritten) emailsWritten++;
        } else {
          console.error(`[Pipeline] Research/write batch error: ${result.reason?.message}`);
        }
      }

      const done = Math.min(i + RESEARCH_BATCH, qualifiedFromThisRun.length);
      await notify(`   מחקר + הודעות: ${done}/${qualifiedFromThisRun.length}`);

      if (i + RESEARCH_BATCH < qualifiedFromThisRun.length) await sleep(500);
    }

    // ── STEP 5: FINAL SUMMARY ─────────────────────────────────────────────────
    await db.finalizeSearchRequest(requestId, {
      leads_found: inserted.length,
      hot_count: counts.hot,
      warm_count: counts.warm,
      cold_count: counts.cold,
    });

    const hotLeads = await db.getHotLeads(3, user_id);
    const summaryLines = [
      `✅ *הפייפליין הושלם!*`,
      ``,
      `📊 *תוצאות לחיפוש: "${keyword}"*`,
      `🔍 סה"כ נסרקו: ${inserted.length} לידים`,
      `🔥 חם (8-10): ${counts.hot}`,
      `🌡 ביניים (5-7): ${counts.warm}`,
      `❄️ קר (1-4): ${counts.cold}`,
      `💬 הודעות נכתבו: ${emailsWritten}`,
    ];

    if (hotLeads.length > 0) {
      summaryLines.push(``, `🏆 *3 הלידים הכי חמים:*`);
      hotLeads.forEach((lead, i) => {
        summaryLines.push(
          ``,
          `${i + 1}. *${lead.company_name}* — ציון ${lead.business_score}/10`,
          `   📸 ${lead.instagram_page || 'אין אינסטגרם'}`,
          `   🌐 ${lead.website_url || 'אין אתר'}`,
          `   💡 ${lead.outreach_angle || ''}`
        );
      });
    }

    await notify(summaryLines.join('\n'));

  } catch (err) {
    console.error(`[Pipeline] Fatal error: ${err.message}`);
    await db.failSearchRequest(requestId);
    await notify(`❌ שגיאה בפייפליין: ${err.message}\n\nנסה שוב.`);
  }
}

/**
 * Merge multiple ads from the same company into a single lead.
 * Groups by facebook_page URL (normalized), falls back to company name.
 * - active_ads_count = SUM of collation_count across all ad groups
 * - ad_type = 'video' if any ad is video, else most common type
 * - page_followers = highest seen across all ads
 */
function groupLeadsByCompany(leads) {
  const map = new Map();

  for (const lead of leads) {
    // Strip protocol (http/https), www prefix, and trailing slash so variants group together
    const pageUrl = (lead.facebook_page || '')
      .trim().toLowerCase()
      .replace(/\/$/, '')
      .replace(/^https?:\/\/(www\.)?/, '');
    const key = pageUrl || `name:${(lead.company_name || '').toLowerCase().trim()}`;

    // Preserve original URL (not normalized) as the DB key
    const facebook_page = lead.facebook_page || `name:${(lead.company_name || '').toLowerCase().trim()}`;

    if (!map.has(key)) {
      map.set(key, {
        ...lead,
        facebook_page,
        active_ads_count:  lead.active_ads_count ?? 1,
        video_count:       lead.ad_type === 'video'    ? 1 : 0,
        image_count:       lead.ad_type === 'image'    ? 1 : 0,
        carousel_count:    lead.ad_type === 'carousel' ? 1 : 0,
        oldest_ad_url:     lead.ad_url || null,
        oldest_ad_date:    lead.ad_start_date || null,
      });
    } else {
      const g = map.get(key);
      // Use the highest known count — collation_count from Meta is the real total
      if ((lead.active_ads_count ?? 0) > (g.active_ads_count ?? 0)) {
        g.active_ads_count = lead.active_ads_count;
      }
      // Video beats carousel beats image
      const rank = { video: 3, carousel: 2, image: 1 };
      if ((rank[lead.ad_type] || 0) > (rank[g.ad_type] || 0)) g.ad_type = lead.ad_type;
      // Keep the highest follower count seen
      if ((lead.page_followers || 0) > (g.page_followers || 0)) g.page_followers = lead.page_followers;
      // Keep a website if we don't have one yet
      if (!g.website_url && lead.website_url) g.website_url = lead.website_url;
      // Collect up to 2 unique ad copy variants for richer research
      if (lead.ad_copy && lead.ad_copy !== g.ad_copy && g.ad_copy) {
        const combined = `${g.ad_copy}\n---\n${lead.ad_copy}`;
        if (combined.length <= 1400) g.ad_copy = combined;
      } else if (lead.ad_copy && !g.ad_copy) {
        g.ad_copy = lead.ad_copy;
      }
      // Accumulate ad type counts
      g.video_count    = (g.video_count    || 0) + (lead.ad_type === 'video'    ? 1 : 0);
      g.image_count    = (g.image_count    || 0) + (lead.ad_type === 'image'    ? 1 : 0);
      g.carousel_count = (g.carousel_count || 0) + (lead.ad_type === 'carousel' ? 1 : 0);
      // Track oldest ad (earliest publish date = most proven ad)
      if (lead.ad_start_date && (!g.oldest_ad_date || lead.ad_start_date < g.oldest_ad_date)) {
        g.oldest_ad_date = lead.ad_start_date;
        g.oldest_ad_url  = lead.ad_url;
      }
      // Prefer Instagram data from any ad in the group
      if (!g.instagram_page      && lead.instagram_page)      g.instagram_page      = lead.instagram_page;
      if (!g.instagram_followers  && lead.instagram_followers)  g.instagram_followers  = lead.instagram_followers;
    }
  }

  return Array.from(map.values());
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { runPipeline };
