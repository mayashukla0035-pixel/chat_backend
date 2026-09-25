const express = require('express');
const SyncLog = require('../models/SyncLog');
const { maybeRunSync } = require('../services/sheetsSync');
const { authRequired } = require('../middleware/auth');

const router = express.Router();

router.get('/status', authRequired, async (req, res) => {
  const last = await SyncLog.findOne({}).sort({ createdAt: -1 }).lean();
  res.json({ last });
});

// Manual trigger — auth + admin only. This endpoint was previously open to
// the internet, which let anyone trigger a full multi-tab sheet sync (a
// heavy external-API + DB operation) as often as they liked.
router.post('/run', authRequired, async (req, res) => {
  if (String(req.user && req.user.role) !== 'supportAdmin') {
    return res.status(403).json({ ok: false, error: 'Admin only.' });
  }
  try {
    const log = await maybeRunSync(0);
    res.json({ ok: true, log });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

module.exports = router;
