const express = require('express');
const Group = require('../models/Group');
const Membership = require('../models/Membership');
const Message = require('../models/Message');
const User = require('../models/User');
const DirectVisibility = require('../models/DirectVisibility');
const { authRequired } = require('../middleware/auth');
const { sharesBatchGroup } = require('../services/access');
const { supportEmail, isSupportAccount } = require('../services/support');

const router = express.Router();
router.use(authRequired);

const normId = (v) => String(v || '').trim().toLowerCase();

// Unread count: messages in this conversation sent by someone else that the
// caller has not read yet (their id not in the message's `reads` array).
async function unreadFor(me, conversationKey) {
  return Message.countDocuments({
    conversationKey,
    sender: { $ne: me._id },
    reads: { $ne: me._id },
  });
}

// Build group map once per request
async function groupMap() {
  const groups = await Group.find({}).lean();
  const m = new Map(groups.map((g) => [g.groupId, g]));
  return { groups, m };
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
    const out = [];

    if (me.role === 'student') {
      // SUPPORT (student-only): every Active student gets a plain DIRECT chat
      // with the support teacher (WhatsApp-style, identical machinery to any
      // other teacher chat — receipts, avatars, unread, offline queue).
      if (me.supportAccess !== false) {
        const support = await User.findOne({ emailNorm: supportEmail(), role: 'teacher', status: 'Active' }).lean();
        if (support) {
          const key = `direct:${[String(me._id), String(support._id)].sort().join(':')}`;
          const last = await Message.findOne({ conversationKey: key }).sort({ createdAt: -1 }).lean();
          out.push({
            id: key, kind: 'direct', title: 'SkillParkho Support',
            subtitle: 'Official SkillParkho Support',
            peerId: String(support._id), peerUsername: support.username,
            avatarUrl: support.avatarUrl || '',
            status: 'Active', readOnly: false,
            lastMessage: last?.content || 'How can our team assist you today?',
            lastMessageAt: last?.createdAt || null,
            lastMessageSenderId: String(last?.sender || ''),
            unread: await unreadFor(me, key),
          });
        }
      }
      // BATCH (membership TRUE + group Active) — normal two-way group chats.
      const rels = await Membership.find({ kind: 'student', emailNorm: me.emailNorm, access: true }).lean();
      for (const r of rels) {
        const g = m.get(r.groupId);
        if (!g || g.status !== 'Active' || g.type !== 'BATCH') continue;
        const last = await Message.findOne({ conversationKey: `group:${g.groupId}` }).sort({ createdAt: -1 }).lean();
        out.push({
          id: g.groupId, kind: 'batch', title: g.name,
          subtitle: g.batchCode ? `Group ${g.batchCode}` : 'Group chat',
          groupId: g.groupId, status: g.status, batchCode: g.batchCode,
          memberCount: memberCounts.get(g.groupId) || 0, avatarUrl: g.avatarUrl || '',
          authorizedTeacherIds: authByGroup.get(g.groupId) || [],
          lastMessage: last?.content || '', lastMessageAt: last?.createdAt || null,
          lastMessageSenderId: String(last?.sender || ''),
          unread: await unreadFor(me, `group:${g.groupId}`),
        });
      }
      // DIRECT teacher chats: only where shared authorized BATCH group exists +
      // teacher Active. Included even when the student's Teacher Chat Access
      // is FALSE — those stay visible as read-only history (never deleted).
      {
        const directs = await Message.find({ directKey: { $exists: true }, participantIds: me._id }).lean();
        const seen = new Set();
        for (const d of directs) {
          const otherId = (d.participantIds || []).map(String).find((x) => x !== String(me._id));
          if (!otherId || seen.has(otherId)) continue;
          seen.add(otherId);
          const teacher = await User.findById(otherId).lean();
          if (!teacher || teacher.role !== 'teacher' || teacher.status !== 'Active') continue;
          if (isSupportAccount(teacher)) continue; // support chat already listed above
          const shared = await sharesBatchGroup(me.emailNorm, teacher.emailNorm, m);
          if (!shared) continue; // relationship no longer authorized -> hide
          const key = `direct:${[String(me._id), String(teacher._id)].sort().join(':')}`;
          const vis = await DirectVisibility.findOne({ directKey: key }).lean();
          out.push({
            id: key, kind: 'direct', title: teacher.name, subtitle: teacher.subject || '',
            peerId: String(teacher._id), peerUsername: teacher.username,
            avatarUrl: teacher.avatarUrl, lastMessage: d.content || '',
            lastMessageAt: d.createdAt, lastMessageSenderId: String(d.sender || ''),
            unread: await unreadFor(me, key),
            hiddenFromTeacher: vis?.hiddenFromTeacher === true,
            readOnly: !me.teacherChatAccess,
          });
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
        const directs = await Message.find({ directKey: { $exists: true }, participantIds: me._id }).lean();
        const seen = new Set();
        for (const d of directs) {
          const studentId = (d.participantIds || []).map(String).find((x) => x !== String(me._id));
          if (!studentId || seen.has(studentId)) continue;
          seen.add(studentId);
          const student = await User.findById(studentId).lean();
          if (!student || student.role !== 'student' || student.status !== 'Active') continue;
          const key = `direct:${[String(me._id), String(student._id)].sort().join(':')}`;
          const vis = await DirectVisibility.findOne({ directKey: key }).lean();
          if (vis?.hiddenFromTeacher) continue; // student hid the chat
          out.push({
            id: key, kind: 'direct', title: student.name, subtitle: student.course || '',
            peerId: String(student._id), peerUsername: student.username || '',
            avatarUrl: student.avatarUrl, status: 'Active',
            lastMessage: d.content || '', lastMessageAt: d.createdAt,
            lastMessageSenderId: String(d.sender || ''),
            unread: await unreadFor(me, key),
          });
        }
      }
      for (const gid of myGroups) {
        const g = m.get(gid);
        if (!g || g.status !== 'Active' || g.type !== 'BATCH') continue;
        const last = await Message.findOne({ conversationKey: `group:${g.groupId}` }).sort({ createdAt: -1 }).lean();
        out.push({
          id: g.groupId, kind: 'batch', title: g.name,
          subtitle: g.batchCode ? `Group ${g.batchCode}` : 'Group chat',
          groupId: g.groupId, status: g.status, batchCode: g.batchCode,
          memberCount: memberCounts.get(g.groupId) || 0, avatarUrl: g.avatarUrl || '',
          authorizedTeacherIds: authByGroup.get(g.groupId) || [],
          lastMessage: last?.content || '', lastMessageAt: last?.createdAt || null,
          lastMessageSenderId: String(last?.sender || ''),
          unread: await unreadFor(me, `group:${g.groupId}`),
        });
      }
      // Direct student chats: students in teacher's batch groups
      const studentEmails = await Membership.find({ kind: 'student', groupId: { $in: [...myGroups] }, access: true }).lean();
      const emails = [...new Set(studentEmails.map((s) => s.emailNorm))];
      const students = await User.find({ emailNorm: { $in: emails }, role: 'student', status: 'Active' }).lean();
      for (const s of students) {
        const key = `direct:${[String(me._id), String(s._id)].sort().join(':')}`;
        const last = await Message.findOne({ conversationKey: key }).sort({ createdAt: -1 }).lean();
        if (!last) continue; // only show started conversations (no global student directory)
        // A student can hide their chat from the teacher; then it disappears here.
        const vis = await DirectVisibility.findOne({ directKey: key }).lean();
        if (vis?.hiddenFromTeacher) continue;
        out.push({
          id: key, kind: 'direct', title: s.name, subtitle: s.course || '',
          peerId: String(s._id), peerUsername: s.username || '',
          avatarUrl: s.avatarUrl, lastMessage: last.content || '',
          lastMessageAt: last.createdAt,
          lastMessageSenderId: String(last.sender || ''),
          unread: await unreadFor(me, key),
        });
      }
    }
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