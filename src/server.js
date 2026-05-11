'use strict';

const http = require('http');
const { runPipeline } = require('./pipeline');
const { writeAndCheckEmail, writeDm } = require('./writer');
const { researchLead } = require('./researcher');
const db = require('./db');

function createServer() {
  const server = http.createServer(async (req, res) => {

    // CORS headers — allow any localhost port (dev) or configured production origin
    const origin = req.headers.origin || '';
    const allowed = process.env.ALLOWED_ORIGIN
      ? [process.env.ALLOWED_ORIGIN]
      : [origin]; // in dev, echo back whatever localhost origin called us
    res.setHeader('Access-Control-Allow-Origin', allowed[0] || '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }

    if (req.method === 'POST' && req.url === '/pipeline') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', async () => {
        let keyword, max_leads, user_id, voice_profile;
        try {
          ({ keyword, max_leads = 20, user_id, voice_profile = {} } = JSON.parse(body));
        } catch {
          res.writeHead(400);
          res.end('Invalid JSON');
          return;
        }

        if (!keyword) {
          res.writeHead(400);
          res.end('keyword is required');
          return;
        }

        // Stream SSE
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
        });

        const send = (payload) => {
          res.write(`data: ${JSON.stringify(payload)}\n\n`);
        };

        const onStatus = (message) => send({ type: 'status', message });

        try {
          await runPipeline({ keyword, location: 'Israel', max_leads, user_id, voice_profile }, onStatus);
          send({ type: 'done' });
        } catch (err) {
          console.error('[Server] Pipeline error:', err.message);
          send({ type: 'error', message: err.message });
        }

        res.end();
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/write-email') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', async () => {
        let lead_id, voice_profile;
        try {
          ({ lead_id, voice_profile = {} } = JSON.parse(body));
        } catch {
          res.writeHead(400); res.end('Invalid JSON'); return;
        }
        if (!lead_id) { res.writeHead(400); res.end('lead_id is required'); return; }

        try {
          const lead = await db.getLeadById(lead_id);
          if (!lead) { res.writeHead(404); res.end('Lead not found'); return; }

          // Research if not already done — skip gracefully if it fails
          let enriched = lead;
          if (!lead.perplexity_research) {
            try {
              const research = await researchLead(lead);
              await db.updateLeadResearch(lead_id, research.text);
              if (research.instagram_url && !lead.instagram_page) {
                await db.updateLeadInstagram(lead_id, research.instagram_url);
              }
              enriched = { ...lead, perplexity_research: research.text };
            } catch (researchErr) {
              console.warn('[write-email] Research failed, continuing without:', researchErr.message);
            }
          }

          const emailResult = await writeAndCheckEmail(enriched, voice_profile);
          await db.updateLeadEmail(lead_id, emailResult);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(emailResult));
        } catch (err) {
          console.error('[Server] write-email error:', err.message);
          res.writeHead(500); res.end(err.message);
        }
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/write-dm') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', async () => {
        let lead_id, voice_profile;
        try {
          ({ lead_id, voice_profile = {} } = JSON.parse(body));
        } catch {
          res.writeHead(400); res.end('Invalid JSON'); return;
        }
        if (!lead_id) { res.writeHead(400); res.end('lead_id is required'); return; }

        try {
          const lead = await db.getLeadById(lead_id);
          if (!lead) { res.writeHead(404); res.end('Lead not found'); return; }

          const dmText = await writeDm(lead, voice_profile);

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ dm_draft: dmText }));
        } catch (err) {
          console.error('[Server] write-dm error:', err.message);
          res.writeHead(500); res.end(err.message);
        }
      });
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  server.listen(3001, () => {
    console.log('[Server] Pipeline API running on http://localhost:3001');
  });

  return server;
}

module.exports = { createServer };
