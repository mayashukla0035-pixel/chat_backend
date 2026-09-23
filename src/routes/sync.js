const express = require('express');
const SyncLog = require('../models/SyncLog');
const { runSync } = require('../services/sheetsSync');
const { authRequired } = require('../middleware/auth');

const router = express.Router();

router.get('/status', authRequired, async (req, res) => {
  const last = await SyncLog.findOne({}).sort({ createdAt: -1 }).lean();
  res.json({ last });
});

// Manual trigger (protect with admin in production; open here for setup)
router.post('/run', async (req, res) => {
  try {
    const log = await runSync();
    res.json({ ok: true, log });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

module.exports = router;
