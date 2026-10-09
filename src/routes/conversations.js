const express = require('express');
const Group = require('../models/Group');
const Membership = require('../models/Membership');
const Message = require('../models/Message');
const User = require('../models/User');
const DirectVisibility = require('../models/DirectVisibility');
const { authRequired } = require('../middleware/auth');
const { sharesBatchGroup } = require('../services/access');
const { supportEmail, isSupportAccount } = require('../services/support');
const { cachedGroups } = require('../services/groupCache');

const router = express.Router();
router.use(authRequired);

const normId = (v) => String(v || '').trim().toLowerCase();

// Batched last-message + unread computation for a SET of conversation keys.
// This replaces the per-key pair of findOne(latest) + countDocuments(unread)
// that used to run 2 queries PER conversation on every app open. One
// aggregation resolves all of them: the $sort matches the
// { conversationKey, createdAt } index exactly, so it streams from the index
// (no in-memory sort, no 100MB limit), takes $last as the latest message, and
// accumulates the unread flag (sent by someone else AND my id not in reads)
// in the same pass.
async function lastAndUnreadByKeys(keys, meId) {
  const out = new Map();
  const uniq = [...new Set(keys.map(String))];
  if (!uniq.length) return out;
  const rows = await Message.aggregate([
    { $match: { conversationKey: { $in: uniq } } },
    { $sort: { conversationKey: 1, createdAt: 1 } },
    { $group: {
      _id: '$conversationKey',
      last: { $last: '$$ROOT' },
      unread: { $sum: { $cond: [
        { $and: [
          { $ne: ['$sender', meId] },
          { $not: { $in: [meId, { $ifNull: ['$reads', []] }] } },
        ] },
        1,
        0,
      ] } },
    } },
  ]);
  for (const r of rows) out.set(String(r._id), { last: r.last, unread: r.unread });
  for (const k of uniq) if (!out.has(k)) out.set(k, { last: null, unread: 0 });
  return out;
}

// Build group map once per request (served from the shared short-TTL cache —
// groups only change on sync, but were re-loaded from Mongo on every request).
async function groupMap() {
  const { list, map } = await cachedGroups();
  return { groups: list, m: map };
}

// groupId -> [teacher objectId strings with membership access], precomputed so
// callers can ship Group.avatarUrl + authorizedTeacherIds on every group row.
async function authorizedTeachersByGroup() {
  const rels = await Membership.find({ kind: 'teacher', access: true }).select('groupId emailNorm').lean();
  const emails = [...new Set(rels.map((r) => r.emailNorm))];
  const teachers = await User.find({ emailNorm: { $in: emails }, role: 'teacher', status: 'Active' }).select('emailNorm').lean();
  const idByEmail = new Map(teachers.map((t) => [String(t.emailNorm), String(t._id)]));
  const out = new Map();
  for (const r of rels) {
    const tid = idByEmail.get(String(r.emailNorm));
    if (!tid) continue;
    if (!out.has(r.groupId)) out.set(r.groupId, []);
    out.get(r.groupId).push(tid);
  }
  return out;
}

// Live member count per group: EVERY membership with access:true (students +
// teachers) whose account is Active. Group.memberCount is a default-0 field
// nothing ever writes, so it must never be trusted for display — computing it
// here is what stops every group from showing "0 members".
async function memberCountsByGroup(groupIds) {
  const counts = new Map();
  if (!groupIds.length) return counts;
  const rels = await Membership.find({ groupId: { $in: groupIds }, access: true })
    .select('groupId emailNorm')
    .lean();
  const emails = [...new Set(rels.map((r) => String(r.emailNorm)))];
  const active = await User.find({ emailNorm: { $in: emails }, status: 'Active' })
    .select('emailNorm')
    .lean();
  const activeSet = new Set(active.map((u) => String(u.emailNorm)));
  for (const r of rels) {
    if (!activeSet.has(String(r.emailNorm))) continue;
    counts.set(r.groupId, (counts.get(r.groupId) || 0) + 1);
  }
  return counts;
}

// GET /api/conversations — only conversations the caller is authorized to access.
// Never leaks other users' data: every branch filters by req.user.
router.get('/', async (req, res) => {
  try {
    const me = req.user;
    const { groups, m } = await groupMap();
    const authByGroup = await authorizedTeachersByGroup();
    const memberCounts = await memberCountsByGroup(groups.map((g) => g.groupId));

    // Rows are collected as specs first; lastMessage + unread resolve in ONE
    // cached aggregation pass (statsFor) at the end — the old code issued
    // findOne + countDocuments PER conversation on every app open.
    const specs = [];
    const statsCache = new Map();
    const statsFor = async (keys) => {
      const missing = [...new Set(keys.map(String))].filter((k) => !statsCache.has(k));
      if (missing.length) {
        const r = await lastAndUnreadByKeys(missing, me._id);
        for (const [k, v] of r) statsCache.set(k, v);
      }
      return statsCache;
    };
    const add = (key, row, fallbackText = '') => specs.push({ key, row, fallbackText });

    // Distinct direct-chat counterpart ids for the caller: one distinct() over
    // the participantIds index instead of loading EVERY direct message body
    // (the old query pulled the full message history just to find peers).
    const directCounterparts = async () => {
      const keys = await Message.distinct('directKey', { participantIds: me._id });
      const meId = String(me._id);
      const seen = new Set();
      const ids = [];
      for (const k of keys) {
        const s = String(k || '');
        if (!s.startsWith('direct:')) continue;
        const other = s.slice(7).split(':').find((x) => x && x !== meId);
        if (!other || seen.has(other)) continue;
        seen.add(other);
        ids.push(other);
      }
      return ids;
    };
    // One visibility query for a batch of direct keys -> map(key -> row).
    const directVis = async (keys) => {
      if (!keys.length) return new Map();
      const rows = await DirectVisibility.find({ directKey: { $in: keys } }).lean();
      return new Map(rows.map((v) => [String(v.directKey), v]));
    };

    if (me.role === 'student') {
      // SUPPORT (student-only): every Active student gets a plain DIRECT chat
      // with the support teacher (WhatsApp-style, identical machinery to any
      // other teacher chat — receipts, avatars, unread, offline queue).
      if (me.supportAccess !== false) {
        const support = await User.findOne({ emailNorm: supportEmail(), role: 'teacher', status: 'Active' }).lean();
        if (support) {
          const key = `direct:${[String(me._id), String(support._id)].sort().join(':')}`;
          add(key, {
            id: key, kind: 'direct', title: 'SkillParkho Support',
            subtitle: 'Official SkillParkho Support',
            peerId: String(support._id), peerUsername: support.username,
            avatarUrl: support.avatarUrl || '',
            status: 'Active', readOnly: false,
          }, 'How can our team assist you today?');
        }
      }
      // BATCH (membership TRUE + group Active) — normal two-way group chats.
      const rels = await Membership.find({ kind: 'student', emailNorm: me.emailNorm, access: true }).lean();
      const myGroupIds = new Set(rels.map((r) => r.groupId));
      for (const r of rels) {
        const g = m.get(r.groupId);
        if (!g || g.status !== 'Active' || g.type !== 'BATCH') continue;
        add(`group:${g.groupId}`, {
          id: g.groupId, kind: 'batch', title: g.name,
          // No group/batch code: the group detail screen renders this
          // directly under the avatar, and it is an identifier, not a label.
          subtitle: 'Group chat',
          groupId: g.groupId, status: g.status, batchCode: g.batchCode,
          memberCount: memberCounts.get(g.groupId) || 0, avatarUrl: g.avatarUrl || '',
          authorizedTeacherIds: authByGroup.get(g.groupId) || [],
        });
      }
      // DIRECT teacher chats: only where shared authorized BATCH group exists +
      // teacher Active. Included even when the student's Teacher Chat Access
      // is FALSE — those stay visible as read-only history (never deleted).
      {
        const specStart = specs.length;
        const otherIds = await directCounterparts();
        const users = otherIds.length ? await User.find({ _id: { $in: otherIds } }).lean() : [];
        // Teacher group memberships for ALL candidates in ONE query (the old
        // sharesBatchGroup ran 2 Membership queries per teacher).
        const tEmails = [...new Set(users.map((u) => String(u.emailNorm)))];
        const tRels = tEmails.length
          ? await Membership.find({ kind: 'teacher', emailNorm: { $in: tEmails }, access: true }).lean()
          : [];
        const teacherGroups = new Map();
        for (const r of tRels) {
          const e = String(r.emailNorm).trim().toLowerCase();
          if (!teacherGroups.has(e)) teacherGroups.set(e, []);
          teacherGroups.get(e).push(r.groupId);
        }
        for (const t of users) {
          if (t.role !== 'teacher' || t.status !== 'Active') continue;
          if (isSupportAccount(t)) continue; // support chat already listed above
          // shared authorized BATCH group (batched equivalent of sharesBatchGroup)
          const tg = teacherGroups.get(String(t.emailNorm).trim().toLowerCase()) || [];
          const shared = tg.find((gid) => {
            const grp = m.get(gid);
            return grp && grp.status === 'Active' && grp.type === 'BATCH' && myGroupIds.has(gid);
          });
          if (!shared) continue; // relationship no longer authorized -> hide
          const key = `direct:${[String(me._id), String(t._id)].sort().join(':')}`;
          add(key, {
            id: key, kind: 'direct', title: t.name, subtitle: t.subject || '',
            peerId: String(t._id), peerUsername: t.username,
            avatarUrl: t.avatarUrl,
            hiddenFromTeacher: false,
            readOnly: !me.teacherChatAccess,
          });
        }
        const directKeys = specs.slice(specStart).map((s) => s.key);
        const vis = await directVis(directKeys);
        for (const sp of specs.slice(specStart)) {
          sp.row.hiddenFromTeacher = vis.get(sp.key)?.hiddenFromTeacher === true;
        }
      }
    } else {
      // teacher / supportAdmin
      const rels = await Membership.find({ kind: 'teacher', emailNorm: me.emailNorm, access: true }).lean();
      const myGroups = new Set(rels.map((r) => r.groupId));
      // SkillParkho Support account behaves like a NORMAL teacher: every
      // student who wrote to support shows up as a plain direct conversation
      // (sourced from message history — support shares no batch groups).
      if (me.role === 'supportAdmin' || isSupportAccount(me)) {
        const otherIds = await directCounterparts();
        const users = otherIds.length ? await User.find({ _id: { $in: otherIds } }).lean() : [];
        const candidates = [];
        for (const st of users) {
          if (st.role !== 'student' || st.status !== 'Active') continue;
          candidates.push({ st, key: `direct:${[String(me._id), String(st._id)].sort().join(':')}` });
        }
        const vis = await directVis(candidates.map((c) => c.key));
        for (const c of candidates) {
          if (vis.get(c.key)?.hiddenFromTeacher) continue; // student hid the chat
          add(c.key, {
            id: c.key, kind: 'direct', title: c.st.name, subtitle: c.st.course || '',
            peerId: String(c.st._id), peerUsername: c.st.username || '',
            avatarUrl: c.st.avatarUrl, status: 'Active',
          });
        }
      }
      for (const gid of myGroups) {
        const g = m.get(gid);
        if (!g || g.status !== 'Active' || g.type !== 'BATCH') continue;
        add(`group:${g.groupId}`, {
          id: g.groupId, kind: 'batch', title: g.name,
          // No group/batch code: the group detail screen renders this
          // directly under the avatar, and it is an identifier, not a label.
          subtitle: 'Group chat',
          groupId: g.groupId, status: g.status, batchCode: g.batchCode,
          memberCount: memberCounts.get(g.groupId) || 0, avatarUrl: g.avatarUrl || '',
          authorizedTeacherIds: authByGroup.get(g.groupId) || [],
        });
      }
      // Direct student chats: students in teacher's batch groups
      const studentEmails = await Membership.find({ kind: 'student', groupId: { $in: [...myGroups] }, access: true }).lean();
      const emails = [...new Set(studentEmails.map((s) => s.emailNorm))];
      const students = await User.find({ emailNorm: { $in: emails }, role: 'student', status: 'Active' }).lean();
      const candidates = students.map((s) => ({
        s,
        key: `direct:${[String(me._id), String(s._id)].sort().join(':')}`,
      }));
      const [vis, stats] = await Promise.all([
        directVis(candidates.map((c) => c.key)),
        statsFor(candidates.map((c) => c.key)),
      ]);
      for (const c of candidates) {
        if (!stats.get(c.key).last) continue; // only show started conversations (no global student directory)
        if (vis.get(c.key)?.hiddenFromTeacher) continue; // student hid the chat
        add(c.key, {
          id: c.key, kind: 'direct', title: c.s.name, subtitle: c.s.course || '',
          peerId: String(c.s._id), peerUsername: c.s.username || '',
          avatarUrl: c.s.avatarUrl,
        });
      }
    }
    // Single cached pass: latest message + unread for every collected spec.
    await statsFor(specs.map((s) => s.key));
    const out = specs.map((s) => {
      const st = statsCache.get(s.key);
      const last = st && st.last;
      return {
        ...s.row,
        lastMessage: (last && last.content) || s.fallbackText || '',
        lastMessageAt: (last && last.createdAt) || null,
        lastMessageSenderId: String((last && last.sender) || ''),
        unread: st ? st.unread : 0,
      };
    });
    return res.json({ conversations: out });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to load conversations' });
  }
});

// POST /api/conversations/direct { peerId } — strict relationship check, never
// auto-creates for strangers. Exception: the support teacher (and any student
// messaging it) chat directly without sharing a batch group.
router.post('/direct', async (req, res) => {
  try {
    const me = req.user;
    const peer = await User.findById(req.body.peerId);
    if (!peer || peer.status !== 'Active') return res.status(404).json({ error: 'User not available' });
    const { m } = await groupMap();
    if (me.role === 'student') {
      if (isSupportAccount(peer)) {
        if (me.supportAccess === false) return res.status(403).json({ error: 'Support chat is currently unavailable for your account.' });
      } else {
        if (!me.teacherChatAccess) return res.status(403).json({ error: 'Teacher messaging is currently unavailable for your account.' });
        if (peer.role !== 'teacher') return res.status(403).json({ error: 'Not permitted' });
        const shared = await sharesBatchGroup(me.emailNorm, peer.emailNorm, m);
        if (!shared) return res.status(403).json({ error: 'You share no authorized batch group with this teacher.' });
      }
    } else {
      if (peer.role !== 'student') return res.status(403).json({ error: 'Not permitted' });
      // The SkillParkho Support desk (support teacher or supportAdmin) may open
      // a direct chat with ANY student; regular teachers only with students
      // inside their authorized groups.
      if (!isSupportAccount(me) && me.role !== 'supportAdmin') {
        const shared = await sharesBatchGroup(peer.emailNorm, me.emailNorm, m);
        if (!shared) return res.status(403).json({ error: 'This student is not in your authorized groups.' });
      }
    }
    const key = `direct:${[String(me._id), String(peer._id)].sort().join(':')}`;
    // Privacy: a student opening a direct chat with a teacher receives ONLY
    // the teacher's name, username, subject and avatar — never email/teacherId.
    const peerBody = {
      id: peer._id,
      name: peer.name,
      username: peer.username,
      subject: peer.subject,
      avatarUrl: peer.avatarUrl,
    };
    if (!(me.role === 'student' && peer.role === 'teacher')) {
      peerBody.teacherId = peer.teacherId;
      peerBody.email = peer.email;
    }
    return res.json({ id: key, peer: peerBody });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to open direct chat' });
  }
});

// POST /api/conversations/direct/visibility { directKey, hidden }
// Student-only toggle: hide my direct chat from the teacher (or unhide).
router.post('/direct/visibility', async (req, res) => {
  try {
    const me = req.user;
    if (me.role !== 'student') return res.status(403).json({ error: 'Only students can change this setting.' });
    const key = String(req.body.directKey || '');
    const hidden = req.body.hidden === true;
    const ids = key.startsWith('direct:') ? key.slice(7).split(':') : [];
    if (!ids.includes(String(me._id))) return res.status(403).json({ error: 'Not your conversation.' });
    const teacherId = ids.find((x) => x !== String(me._id));
    const teacher = await User.findById(teacherId).lean();
    if (!teacher || teacher.role !== 'teacher') return res.status(404).json({ error: 'Teacher not found.' });
    const vis = await DirectVisibility.findOneAndUpdate(
      { directKey: key },
      { directKey: key, student: me._id, teacher: teacher._id, hiddenFromTeacher: hidden },
      { upsert: true, new: true }
    ).lean();
    return res.json({ ok: true, hiddenFromTeacher: vis.hiddenFromTeacher });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to update visibility' });
  }
});

// GET /api/conversations/members?conversation=group:GRP002
// Group member info for the info panel. Teachers list is visible to any
// authorized reader; the student list is only returned to teachers.
router.get('/members', async (req, res) => {
  try {
    const me = req.user;
    const key = String(req.query.conversation || '');
    if (!key.startsWith('group:')) return res.status(400).json({ error: 'Group conversation required.' });
    const gid = key.slice(6);
    const g = await Group.findOne({ groupId: gid }).lean();
    if (!g || g.status !== 'Active' || g.type !== 'BATCH') return res.status(404).json({ error: 'Group not available.' });
    const kind = me.role === 'student' ? 'student' : 'teacher';
    const mine = await Membership.findOne({ kind, emailNorm: me.emailNorm, groupId: gid, access: true }).lean();
    if (!mine) return res.status(403).json({ error: 'Not authorized for this group.' });
    const tRels = await Membership.find({ kind: 'teacher', groupId: gid, access: true }).lean();
    // Privacy: a student browsing the group sees teachers' NAME, SUBJECT and
    // USERNAME only — the email is stripped server-side for student readers.
    const teacherProj = me.role === 'student'
      ? 'name username subject avatarUrl'
      : 'name username email subject avatarUrl';
    const teachers = await User.find({ emailNorm: { $in: tRels.map((r) => r.emailNorm) }, role: 'teacher', status: 'Active' })
      .select(teacherProj).lean();
    let students = [];
    if (me.role !== 'student') {
      const sRels = await Membership.find({ kind: 'student', groupId: gid, access: true }).lean();
      students = await User.find({ emailNorm: { $in: sRels.map((r) => r.emailNorm) }, role: 'student', status: 'Active' })
        .select('name username email avatarUrl batch course').lean();
    }
    return res.json({ teachers, students });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to load members' });
  }
});

module.exports = router;