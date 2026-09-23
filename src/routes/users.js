const express = require('express');
const User = require('../models/User');
const Group = require('../models/Group');
const { authRequired } = require('../middleware/auth');
const { sharesBatchGroup, studentBatchGroups, teacherBatchGroups } = require('../services/access');
const { isSupportAccount } = require('../services/support');

const router = express.Router();
router.use(authRequired);

const escapeRx = (s) => String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// PATCH /api/users/me/settings — per-user toggles from the profile screen
// (e.g. the Notifications switch). Only whitelisted scalar flags are accepted.
router.patch('/me/settings', async (req, res) => {
  try {
    const allowed = ['notificationsEnabled'];
    const update = {};
    for (const k of allowed) {
      if (typeof req.body[k] === 'boolean') update[k] = req.body[k];
    }
    if (Object.keys(update).length === 0) {
      return res.status(400).json({ error: 'No valid settings provided' });
    }
    await User.findByIdAndUpdate(req.user._id, update);
    const user = await User.findById(req.user._id).lean();
    return res.json({ ok: true, user });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Could not save settings' });
  }
});

// GET /api/users/search?q=… — directory search with strict privacy rules.
// Returns { teachers: [], students: [] } shaped for the caller's role:
//   - STUDENT  → teachers by name/username, ONLY those sharing an authorized
//     BATCH group. Each result carries ONLY name, subject, username (plus the
//     avatar + verified badge the UI needs) — never email/teacherId/phone.
//   - TEACHER  → students by name/username, ONLY those inside their authorized
//     batch groups (name/username/batch/course, no email/phone).
//   - SUPPORT / supportAdmin → ANY active student by name/username (the
//     support desk has access to every student).
router.get('/search', async (req, res) => {
  try {
    const me = req.user;
    const q = String(req.query.q || '').trim().toLowerCase();
    if (!q) return res.json({ teachers: [], students: [] });
    const groups = await Group.find({}).lean();
    const m = new Map(groups.map((g) => [g.groupId, g]));
    const rx = new RegExp(escapeRx(q), 'i');
    const out = { teachers: [], students: [] };

    if (me.role === 'student') {
      const teachers = await User.find({
        role: 'teacher',
        status: 'Active',
        $or: [{ name: rx }, { username: rx }, { usernameNorm: q }],
      }).lean();
      for (const t of teachers) {
        // A student may message a teacher ONLY when they share an authorized
        // active BATCH group — search hides every other teacher.
        const shared = await sharesBatchGroup(me.emailNorm, t.emailNorm, m);
        if (!shared) continue;
        out.teachers.push({
          id: t._id, name: t.name, username: t.username, subject: t.subject,
          avatarUrl: t.avatarUrl, isVerified: t.isVerified === true,
        });
      }
      return res.json(out);
    }

    // teacher / supportAdmin / SkillParkho Support -> students
    const support = me.role === 'supportAdmin' || isSupportAccount(me);
    const students = await User.find({
      role: 'student',
      status: 'Active',
      $or: [{ name: rx }, { username: rx }, { usernameNorm: q }],
    }).lean();
    if (support) {
      // Special account: full access to every student.
      out.students = students.map((s) => ({
        id: s._id, name: s.name, username: s.username, avatarUrl: s.avatarUrl,
        batch: s.batch || '', course: s.course || '',
      }));
      return res.json(out);
    }
    const myGroups = new Set(await teacherBatchGroups(me.emailNorm));
    for (const s of students) {
      const sGroups = await studentBatchGroups(s.emailNorm);
      const shared = sGroups.some((g) => {
        const grp = m.get(g);
        return grp && grp.status === 'Active' && grp.type === 'BATCH' && myGroups.has(g);
      });
      if (!shared) continue;
      out.students.push({
        id: s._id, name: s.name, username: s.username, avatarUrl: s.avatarUrl,
        batch: s.batch || '', course: s.course || '',
      });
    }
    return res.json(out);
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Search failed' });
  }
});

// Full profile fields mirrored from the Google Sheet (name, email, phone,
// role, username, teacherId, subject, batch, course, status, permissions…).
const PROFILE_FIELDS = 'name email phone role username teacherId subject batch course avatarUrl status isVerified notificationsEnabled teacherChatAccess supportAccess orgAnnouncementAccess';

// GET /api/users/:id — full details of another user. Access is strictly gated:
//  - SkillParkho Support (teacher in GRP_SUPPORT): any Active user (so anyone
//    messaging support can be fully identified).
//  - supportAdmin: any Active user.
//  - teacher <-> student: only when they share an authorized batch group.
// isSupportAccount() is imported from services/support (line 6) — a local
// duplicate used to live here but collided with that import.

router.get('/:id', async (req, res) => {
  try {
    const me = req.user;
    const target = await User.findById(req.params.id).select(PROFILE_FIELDS).lean();
    if (!target) return res.status(404).json({ error: 'User not found' });
    if (target.status !== 'Active' && me.role !== 'supportAdmin') {
      // Only supportAdmin may view inactive accounts.
      if (!isSupportAccount(me)) return res.status(403).json({ error: 'Not authorized' });
    }
    let ok = false;
    if (me.role === 'supportAdmin') ok = true;
    else if (isSupportAccount(me)) ok = true;
    else if (me.role === 'teacher' && target.role === 'student') {
      const groups = await Group.find({}).lean();
      const m = new Map(groups.map((g) => [g.groupId, g]));
      ok = !!(await sharesBatchGroup(target.emailNorm, me.emailNorm, m));
    } else if (me.role === 'student' && target.role === 'teacher') {
      const groups = await Group.find({}).lean();
      const m = new Map(groups.map((g) => [g.groupId, g]));
      ok = !!(await sharesBatchGroup(me.emailNorm, target.emailNorm, m));
      if (ok) {
        // Privacy: a student may only ever see a teacher's NAME, SUBJECT and
        // USERNAME (plus avatar + verified badge used across the UI) — no
        // email, teacherId or phone surfaces through this endpoint.
        return res.json({
          user: {
            name: target.name,
            username: target.username,
            subject: target.subject,
            avatarUrl: target.avatarUrl,
            isVerified: target.isVerified === true,
            role: target.role,
          },
        });
      }
    }
    if (!ok) return res.status(403).json({ error: 'Not authorized' });
    return res.json({ user: target });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to load profile' });
  }
});

module.exports = router;