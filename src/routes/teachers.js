const express = require('express');
const User = require('../models/User');
const Group = require('../models/Group');
const { authRequired } = require('../middleware/auth');
const { sharesBatchGroup } = require('../services/access');

const router = express.Router();
router.use(authRequired);

// GET /api/teachers/search?username=ravi_linux — exact username search only. No public directory.
router.get('/search', async (req, res) => {
  try {
    const me = req.user;
    if (me.role !== 'student') return res.status(403).json({ error: 'Only students can search teachers.' });
    if (!me.teacherChatAccess) return res.status(403).json({ error: 'Teacher messaging is currently unavailable for your account.' });
    const q = String(req.query.username || '').trim().toLowerCase();
    if (!q) return res.json({ teachers: [] });
    const teacher = await User.findOne({ usernameNorm: q, role: 'teacher', status: 'Active' }).lean();
    if (!teacher) return res.json({ teachers: [] });
    const groups = await Group.find({}).lean();
    const m = new Map(groups.map((g) => [g.groupId, g]));
    const shared = await sharesBatchGroup(me.emailNorm, teacher.emailNorm, m);
    if (!shared) return res.json({ teachers: [] }); // hide teachers with no shared authorized group
    return res.json({ teachers: [{ id: teacher._id, name: teacher.name, username: teacher.username, subject: teacher.subject, avatarUrl: teacher.avatarUrl, isVerified: teacher.isVerified }] });
  } catch (e) {
    return res.status(500).json({ error: 'Search failed' });
  }
});

module.exports = router;
