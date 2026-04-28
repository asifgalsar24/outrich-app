'use strict';

const db = require('./db');
const { scrapeMetaAds } = require('./scraper');
const { scoreLead } = require('./scorer');
const { researchLead } = require('./researcher');
const { writeAndCheckEmail } = require('./writer');
const { pushToLemlist } = require('./lemlist');
const { findEmail } = require('./emailfinder');

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
    await notify(`🔍 שלב 1/5: מחפש מודעות ל-*${keyword}* דרך Meta Ads...`);
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
    await notify(`✅ שלב 1 הושלם! *${inserted.length}* לידים חדשים/מרועננים. מתחיל ניקוד...`);

    // ── STEP 3: SCORE — parallel batches ─────────────────────────────────────
    await notify(`🧠 שלב 2/5: מנתח ומדרג כל עסק עם Claude (${SCORE_BATCH} במקביל)...`);
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
            suggested_service: scoreResult.suggested_service,
            outreach_angle: scoreResult.outreach_angle,
          });
          return { lead: { ...lead, id }, scoreResult };
        })
      );

      for (const result of batchResults) {
        if (result.status === 'fulfilled') {
          const { lead, scoreResult } = result.value;
          counts[scoreResult.tier] = (counts[scoreResult.tier] || 0) + 1;
          if (scoreResult.score >= 1) {
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
      `✅ שלב 2 הושלם!\n\n🔥 חם: *${counts.hot}* | 🌡 ביניים: *${counts.warm}* | ❄️ קר: *${counts.cold}*\n\nמתחיל מחקר על הלידים הכשירים (ציון 7+)...`
    );

    // ── STEP 4: RESEARCH + WRITE + PUSH — parallel batches ───────────────────
    if (qualifiedFromThisRun.length === 0) {
      await notify(`ℹ️ אין לידים עם ציון 7+ הפעם. אפשר לשנות מילת חיפוש ולנסות שוב.`);
      await db.finalizeSearchRequest(requestId, { leads_found: inserted.length, ...counts });
      return;
    }

    await notify(`📋 יש *${qualifiedFromThisRun.length}* לידים כשירים. מחקר + כתיבת מיילים (${RESEARCH_BATCH} במקביל)...`);

    let emailsWritten = 0;
    let lemlistPushed = 0;

    for (let i = 0; i < qualifiedFromThisRun.length; i += RESEARCH_BATCH) {
      const batch = qualifiedFromThisRun.slice(i, i + RESEARCH_BATCH);

      const batchResults = await Promise.allSettled(
        batch.map(async (lead) => {
          // Research
          const research = await researchLead(lead);
          await db.updateLeadResearch(lead.id, research);

          // Write + check email
          const enrichedLead = { ...lead, perplexity_research: research };
          const emailResult = await writeAndCheckEmail(enrichedLead, voice_profile);
          await db.updateLeadEmail(lead.id, emailResult);

          // Push hot leads (8+) to Lemlist
          let pushed = false;
          if (lead.business_score >= 8 && emailResult.email_approved) {
            let emailAddress = lead.email_address;
            if (!emailAddress) {
              emailAddress = await findEmail(lead);
              if (emailAddress) await db.updateLeadEmailAddress(lead.id, emailAddress);
            }
            const leadWithEmail = { ...lead, ...emailResult, email_address: emailAddress };
            const pushResult = await pushToLemlist(leadWithEmail);
            if (!pushResult.skipped) {
              await db.updateLeadLemlistStatus(lead.id);
              pushed = true;
            }
          }

          return { emailWritten: true, pushed };
        })
      );

      for (const result of batchResults) {
        if (result.status === 'fulfilled') {
          if (result.value.emailWritten) emailsWritten++;
          if (result.value.pushed) lemlistPushed++;
        } else {
          console.error(`[Pipeline] Research/write batch error: ${result.reason?.message}`);
        }
      }

      const done = Math.min(i + RESEARCH_BATCH, qualifiedFromThisRun.length);
      await notify(`   מחקר + מיילים: ${done}/${qualifiedFromThisRun.length} | נשלחו ל-Lemlist: ${lemlistPushed}`);

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
      `📧 מיילים נכתבו: ${emailsWritten}`,
      `📤 נשלחו ל-Lemlist: ${lemlistPushed}`,
    ];

    if (hotLeads.length > 0) {
      summaryLines.push(``, `🏆 *3 הלידים הכי חמים:*`);
      hotLeads.forEach((lead, i) => {
        summaryLines.push(
          ``,
          `${i + 1}. *${lead.company_name}* — ציון ${lead.business_score}/10`,
          `   📧 ${lead.email_address || 'אין מייל'}`,
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
      map.set(key, { ...lead, facebook_page, active_ads_count: lead.active_ads_count ?? 1 });
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
    }
  }

  return Array.from(map.values());
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { runPipeline };
