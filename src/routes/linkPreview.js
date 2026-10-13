const express = require('express');
const rateLimit = require('express-rate-limit');
const LinkPreview = require('../models/LinkPreview');
const { authRequired } = require('../middleware/auth');
const {
  extractFirstUrl,
  fetchPreview,
  cacheKey,
} = require('../services/linkPreview');

const router = express.Router();

// Previewing is a server-side outbound fetch, so it is the most expensive call
// in the API, and it is capped — but the cap is per ACCOUNT, not per IP.
//
// The first version keyed on IP, which is wrong for a mobile app: carrier NAT
// puts hundreds of students behind one address, so a single chatty user could
// spend the whole 30/minute budget for everyone else. Opening a conversation
// with a dozen links was enough to start returning 429, and a 429 means "no
// thumbnail" — which is exactly how this feature looked broken.
//
// 60/minute per account is far above what one person generates (results are
// cached for 7 days, so repeat views cost nothing) while still capping a
// runaway client.
const previewLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => String(req.user && req.user._id ? req.user._id : req.ip),
  // Being limited is not an error the bubble should show or retry into. Answer
  // 200 with no preview and the bubble falls back to a plain underlined link,
  // which is a graceful outcome instead of a blank space.
  handler: (req, res) => res.json({ ok: true, preview: null, limited: true }),
});

// GET /api/link-preview?url=<address>
//
// Returns `{ ok: true, preview }` where preview is either
//   { kind:'youtube', videoId, embedUrl, title, author, thumbnail, siteName }
// or
//   { kind:'link', title, description, image, siteName }
// or `{ ok: true, preview: null }` when the page has nothing worth showing.
//
// `preview: null` is a SUCCESS, not a 404: most links genuinely have no
// preview, and the bubble then renders as an ordinary underlined link.
// Auth BEFORE the limiter: keying per account needs the resolved user.
router.get('/', authRequired, previewLimiter, async (req, res) => {
  const raw = String(req.query.url || '');
  if (!raw) return res.status(400).json({ error: 'url is required' });

  const url = extractFirstUrl(raw) || (/^https?:\/\//i.test(raw) ? raw : null);
  if (!url) return res.status(400).json({ error: 'Not a valid http(s) link' });

  const key = cacheKey(url);
  try {
    const hit = await LinkPreview.findOne({ url: key }).lean();
    if (hit) return res.json({ ok: true, preview: hit.payload || null });

    const preview = await enqueue(() => fetchPreview(url));

    // Cache failures too. A page that 403s the scraper today will 403 it on
    // every later scroll-back, and re-fetching it each time is pure waste.
    await LinkPreview.updateOne(
      { url: key },
      { $set: { payload: preview, expires: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) } },
      { upsert: true }
    ).catch((e) => console.warn('link-preview cache write failed:', e.message));

    return res.json({ ok: true, preview });
  } catch (e) {
    // A bad URL is the caller's problem and gets a real status; anything else
    // (DNS blip, site down, timeout) degrades to "no preview" so the chat is
    // never blocked on a third-party page.
    const status = e && e.status ? e.status : 0;
    if (status === 400) return res.status(400).json({ error: e.message });
    console.warn('link preview failed:', e.message);
    return res.json({ ok: true, preview: null });
  }
});

// ---------------------------------------------------------------------------
// Concurrency gate
// ---------------------------------------------------------------------------

const MAX_INFLIGHT = 6;
let inflight = 0;
const waiting = [];

/**
 * Runs [fn] with at most MAX_INFLIGHT previews in flight, queueing the rest.
 * Without this, a chat opened on a 4G connection asks for every visible link
 * at once and the server opens one socket per message.
 */
function enqueue(fn) {
  if (inflight >= MAX_INFLIGHT) {
    return new Promise((resolve, reject) => {
      waiting.push(() => {
        run(fn).then(resolve, reject);
      });
    });
  }
  return run(fn);
}

async function run(fn) {
  inflight++;
  try {
    return await fn();
  } finally {
    inflight--;
    const next = waiting.shift();
    if (next) next();
  }
}

module.exports = router;