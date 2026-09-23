const express = require('express');
const Message = require('../models/Message');
const Group = require('../models/Group');
const Membership = require('../models/Membership');
const User = require('../models/User');
const DirectVisibility = require('../models/DirectVisibility');
const { authRequired } = require('../middleware/auth');
const { effectiveAccess, sharesBatchGroup } = require('../services/access');
const { isSupportAccount } = require('../services/support');
const { resolveAttachment } = require('../services/attachments');

const router = express.Router();
router.use(authRequired);

// Strip the auto-created empty poll subdoc (Mongoose initializes it from the
// schema default) so clients never render a "poll" on plain messages.
// Also derives one-tick/double-tick/blue-tick flags for the sender:
//   delivered = some OTHER participant's device received it,
//   read      = some OTHER participant read it.
// (In direct chats there is exactly one peer, so "some other" == "the peer".)
// When [meId] is the caller, per-recipient state is added so the RECEIVER can
// track a read/unread flag on every message (WhatsApp-style):
//   readByMe      = I (the caller) read this message
//   deliveredToMe = I (the caller) received/delivered it on this device
function cleanMsg(doc, meId) {
  const o = doc.toObject ? doc.toObject() : { ...doc };
  if (o.poll && !o.poll.question && !(o.poll.options && o.poll.options.length)) delete o.poll;
  // Same for the reply quote: Mongoose auto-creates the empty subdoc, so a
  // plain message must never ship an empty `replyTo: {}` to clients.
  if (o.replyTo && !o.replyTo.messageId) delete o.replyTo;
  const sender = String(o.sender?._id || o.sender || '');
  o.delivered = (o.deliveredTo || []).some((id) => String(id) !== sender);
  o.read = (o.reads || []).some((id) => String(id) !== sender);
  if (meId) {
    const my = String(meId);
    o.readByMe = (o.reads || []).some((id) => String(id) === my);
    o.deliveredToMe = (o.deliveredTo || []).some((id) => String(id) === my);
  } else {
    delete o.readByMe;
    delete o.deliveredToMe;
  }
  delete o.deliveredTo;
  delete o.reads;
  return o;
}

// Conversations are normal two-way chats — the announcements feature has been
// removed, so no message is flagged as an announcement anymore.
async function resolveAnnouncement() {
  return false;
}

// Swipe-to-reply: resolve the referenced message and SNAPSHOT it server-side
// (quoted sender + preview text come from the stored row, never from the
// client) — and only when the reference lives in the SAME conversation the
// new message goes to. Returns undefined when unusable (bad id, unknown
// message, cross-conversation quote attempt), so a bad reference can never
// block or poison a send.
async function buildReplyTo(key, rawReply) {
  const mid = String((rawReply && (rawReply.messageId || rawReply.id)) || '').trim();
  if (!/^[a-f0-9]{24}$/i.test(mid)) return undefined;
  let ref;
  try {
    ref = await Message.findById(mid).lean();
  } catch (_) {
    return undefined;
  }
  if (!ref || ref.conversationKey !== key) return undefined;
  const kind = ref.poll && (ref.poll.question || (ref.poll.options || []).length)
    ? 'poll'
    : ref.attachment && (ref.attachment.kind || ref.attachment.url)
      ? (ref.attachment.kind || 'doc')
      : 'text';
  return {
    messageId: ref._id,
    senderId: ref.sender,
    senderName: ref.senderName || '',
    content: String(ref.content || '').slice(0, 1000),
    kind,
  };
}

async function canReadConversation(me, conversationKey) {
  if (conversationKey.startsWith('group:')) {
    const gid = conversationKey.slice(6);
    const g = await Group.findOne({ groupId: gid }).lean();
    if (!g || g.status !== 'Active') return { ok: false };
    if (g.type === 'ORGANIZATION') return { ok: true, group: g }; // all Active auto-members
    // BATCH
    const kind = me.role === 'student' ? 'student' : 'teacher';
    const ok = await effectiveAccess(kind, me.emailNorm, gid);
    return ok ? { ok: true, group: g } : { ok: false };
  }
  if (conversationKey.startsWith('direct:')) {
    const ids = conversationKey.slice(7).split(':');
    if (!ids.includes(String(me._id))) return { ok: false };
    const otherId = ids.find((x) => x !== String(me._id));
    const other = await User.findById(otherId).lean();
    if (!other || other.status !== 'Active') return { ok: false };
    // Hidden from teacher: the teacher loses read/send access entirely.
    const vis = await DirectVisibility.findOne({ directKey: conversationKey }).lean();
    if (vis?.hiddenFromTeacher && String(me._id) !== String(vis.student)) return { ok: false };
    // The support teacher / supportAdmin <-> any Active student is a normal
    // direct: no shared batch group exists (support belongs to no student
    // batch), so exempt it.
    if ((isSupportAccount(me) || me.role === 'supportAdmin') && other.role === 'student') return { ok: true };
    if (me.role === 'student' && (isSupportAccount(other) || other.role === 'supportAdmin')) return { ok: true };
    const groups = await Group.find({}).lean();
    const m = new Map(groups.map((g) => [g.groupId, g]));
    let shared = null;
    if (me.role === 'student' && other.role === 'teacher') {
      // Reads stay allowed when Teacher Chat Access is FALSE so history is
      // visible read-only; sending is still denied in canSendInConversation.
      shared = await sharesBatchGroup(me.emailNorm, other.emailNorm, m);
    } else if (me.role !== 'student' && other.role === 'student') {
      shared = await sharesBatchGroup(other.emailNorm, me.emailNorm, m);
    } else {
      return { ok: false }; // no student-to-student chats, ever
    }
    return shared ? { ok: true } : { ok: false };
  }
  return { ok: false };
}

async function canSendInConversation(me, conversationKey) {
  const read = await canReadConversation(me, conversationKey);
  if (!read.ok) return read;
  if (conversationKey.startsWith('group:')) {
    const g = read.group;
    if (g.type === 'BATCH') {
      // Students can read, react and vote in group chats, but ONLY the
      // teacher (and support staff) can post — no two students chat directly.
      if (me.role === 'student') return { ok: false, reason: 'Only teachers can post in this group.' };
      return { ok: true, group: g };
    }
    if (g.type === 'ORGANIZATION') {
      // Legacy rows only — the organization channel is no longer surfaced in
      // the app, but retain read/teacher-post for backward compatibility.
      if (me.role === 'student') return { ok: false, reason: 'Announcements are disabled.' };
      return { ok: true, group: g };
    }
    return { ok: false };
  }
  if (conversationKey.startsWith('direct:')) {
    if (me.role === 'student') {
      const ids = conversationKey.slice(7).split(':');
      const peerId = ids.find((x) => x !== String(me._id));
      const peer = peerId ? await User.findById(peerId).lean() : null;
      // Support chat is two-way regardless of Teacher Chat Access (its own
      // gate is the account's supportAccess flag).
      if (peer && (isSupportAccount(peer) || peer.role === 'supportAdmin')) {
        if (me.supportAccess === false) return { ok: false, reason: 'Support chat is currently unavailable for your account.' };
        return { ok: true };
      }
      if (!me.teacherChatAccess) {
        return { ok: false, reason: 'Teacher messaging is currently unavailable for your account.' };
      }
    }
    return { ok: true };
  }
  return { ok: false };
}

// POST /api/messages/forward { messageId, conversation } — "forward" a message
// (text, media or both) the caller can READ into another conversation the
// caller can SEND in. The attachment is copied as-is (the URL is the same file),
// so no re-upload is needed and forwards are instant. Polls are NOT forwarded
// (their votes belong to the original voters).
router.post('/forward', async (req, res) => {
  try {
    const me = req.user;
    const src = await Message.findById(String(req.body.messageId || '')).lean();
    if (!src) return res.status(404).json({ error: 'Message not found' });
    const target = String(req.body.conversation || '');
    if (!target) return res.status(400).json({ error: 'Target conversation is required.' });
    const srcCheck = await canReadConversation(me, src.conversationKey);
    if (!srcCheck.ok) return res.status(403).json({ error: 'Not authorized to read the source message.' });
    const tgtCheck = await canSendInConversation(me, target);
    if (!tgtCheck.ok) return res.status(403).json({ error: tgtCheck.reason || 'You cannot send in that conversation.' });
    const hasContent = String(src.content || '').trim().length > 0;
    const hasAttach = !!(src.attachment && src.attachment.url);
    if (!hasContent && !hasAttach) {
      return res.status(400).json({ error: 'Nothing to forward.' });
    }
    const groupId = target.startsWith('group:') ? target.slice(6) : undefined;
    const directKey = target.startsWith('direct:') ? target : undefined;
    const participantIds = target.startsWith('direct:') ? target.slice(7).split(':') : undefined;
    const msg = await Message.create({
      conversationKey: target,
      groupId, directKey, participantIds,
      sender: me._id, senderName: me.name, senderRole: me.role,
      senderAvatar: me.avatarUrl || '',
      content: hasContent ? src.content : '',
      attachment: hasAttach
        ? {
            name: src.attachment.name,
            size: src.attachment.size,
            mime: src.attachment.mime || '',
            url: src.attachment.url,
            kind: src.attachment.kind,
            duration: src.attachment.duration || '',
          }
        : undefined,
    });
    const out = cleanMsg(msg, req.user._id);
    const io = req.app.get('io');
    io?.to(target).emit('message:new', out);
    return res.json({ message: out });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to forward' });
  }
});

// GET /api/messages?conversation=<key>&before=<iso>&limit=50 — late joiners see
// history (retention rules apply in UI).
router.get('/', async (req, res) => {
  try {
    const key = String(req.query.conversation || '');
    const check = await canReadConversation(req.user, key);
    if (!check.ok) return res.status(403).json({ error: 'Not authorized for this conversation.' });
    const limit = Math.min(Number(req.query.limit || 50), 100);
    const q = { conversationKey: key };
    if (req.query.before) q.createdAt = { $lt: new Date(req.query.before) };
    const msgs = await Message.find(q).sort({ createdAt: -1 }).limit(limit).lean();
    const out = msgs.reverse().map((m) => cleanMsg(m, req.user._id));
    // Backfill: messages created before senderAvatar existed in the schema
    // never stored it, so resolve the sender's current avatar in ONE query and
    // stamp it on the payload — every bubble then shows the sender's image.
    const missing = out.filter((m) => !m.senderAvatar && m.sender);
    if (missing.length) {
      const ids = [...new Set(missing.map((m) => String(m.sender)))];
      const senders = await User.find({ _id: { $in: ids } }).select('_id avatarUrl').lean();
      const byId = new Map(senders.map((s) => [String(s._id), s.avatarUrl || '']));
      for (const m of missing) m.senderAvatar = byId.get(String(m.sender)) || '';
    }
    return res.json({ messages: out });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to load messages' });
  }
});

// POST /api/messages { conversation, content, attachment?, poll? }
router.post('/', async (req, res) => {
  try {
    const me = req.user;
    const key = String(req.body.conversation || '');
    const check = await canSendInConversation(me, key);
    if (!check.ok) return res.status(403).json({ error: check.reason || 'You cannot send in this conversation.' });
    const content = String(req.body.content || '').slice(0, 4000);
    if (!content.trim() && !req.body.attachment && !req.body.poll) {
      return res.status(400).json({ error: 'Empty message' });
    }
    // Privacy wall #2: an attachment may only reference a file THIS user
    // uploaded (never another user's file, never an arbitrary URL).
    const attach = await resolveAttachment(me, req.body.attachment);
    if (attach.error) return res.status(403).json({ error: attach.error });
    // Idempotent send (WhatsApp-style exactly-once): if this device's retry
    // (REST fallback / queue flush) already stored the same send, return the
    // existing message instead of creating a second copy. The dedupe is GLOBAL
    // on clientId — a stale retry retokenized under another account carries
    // the same CSPRNG clientId, and per-sender dedupe would have stored it as
    // a new row (the "message comes back as a reply" bug).
    const clientId = String(req.body._clientId || req.body.clientId || '');
    if (clientId) {
      const existing = await Message.findOne({ clientId }).lean();
      if (existing) return res.json({ message: cleanMsg(existing, req.user._id) });
    }
    const groupId = key.startsWith('group:') ? key.slice(6) : undefined;
    const directKey = key.startsWith('direct:') ? key : undefined;
    const participantIds = key.startsWith('direct:') ? key.slice(7).split(':') : undefined;
    let msg;
    try {
      msg = await Message.create({
        conversationKey: key,
        groupId, directKey, participantIds,
        sender: me._id, senderName: me.name, senderRole: me.role,
        senderAvatar: me.avatarUrl || '',
        clientId: clientId || undefined,
        content: content.trim(),
        attachment: attach.attachment,
        poll: req.body.poll && (req.body.poll.question || (req.body.poll.options || []).length) ? req.body.poll : undefined,
        replyTo: await buildReplyTo(key, req.body.replyTo),
        isAnnouncement: await resolveAnnouncement(groupId),
      });
    } catch (e) {
      // The unique (clientId) index won: a concurrent retry (socket
      // flush / REST fallback) stored this send between our lookup and create.
      // Return that exact row — never a second copy. (Clean send, no poll.)
      if (e && e.code === 11000 && clientId) {
        const existing = await Message.findOne({ clientId }).lean();
        if (existing) return res.json({ message: cleanMsg(existing, req.user._id) });
      }
      throw e;
    }
    const out = cleanMsg(msg, req.user._id);
    // Receipt: if any other participant is online in this room right now,
    // their devices just received the broadcast — mark delivered immediately.
    try {
      const io = req.app.get('io');
      const roomSockets = io ? await io.in(key).fetchSockets() : [];
      const others = [...new Set(roomSockets
        .map((s) => (s.user && s.user._id ? String(s.user._id) : ''))
        .filter((id) => id && id !== String(me._id)))];
      if (others.length) {
        await Message.updateOne({ _id: msg._id }, { $addToSet: { deliveredTo: { $each: others } } });
        out.delivered = true;
      }
    } catch (_) {}
    const io = req.app.get('io');
    io?.to(key).emit('message:new', { ...out, _clientId: clientId || undefined });
    return res.json({ message: out });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to send message' });
  }
});

// POST /api/messages/read { conversation } — read receipt. Marks messages the
// caller hasn't read yet as received+read, then broadcasts message:updated so
// senders see double ✓, then blue ✓✓. Debounced on the client to avoid spam.
router.post('/read', async (req, res) => {
  try {
    const me = req.user;
    const key = String(req.body.conversation || '');
    const check = await canReadConversation(me, key);
    if (!check.ok) return res.status(403).json({ error: 'Not authorized' });
    const msgs = await Message.find({
      conversationKey: key,
      sender: { $ne: me._id },
      reads: { $ne: me._id },
    }).limit(100).select('_id').lean();
    const ids = msgs.map((m) => m._id);
    if (ids.length) {
      await Message.updateMany(
        { _id: { $in: ids } },
        { $addToSet: { deliveredTo: me._id, reads: me._id } },
      );
      const fresh = await Message.find({ _id: { $in: ids } }).lean();
      const io = req.app.get('io');
      for (const m of fresh) io?.to(key).emit('message:updated', cleanMsg(m, req.user._id));
    }
    return res.json({ ok: true, updated: ids.length });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to mark read' });
  }
});

// GET /api/messages/:id/info — long-press "Info":
//  - BATCH group (teacher/support): which group members' devices received/read
//    this message (WhatsApp-style receipt info).
//  - direct: received/read counts for the single peer; when viewed by the
//    support teacher (or a message from the support teacher), returns the
//    sender's full sheet profile so either side can be fully identified.
router.get('/:id/info', async (req, res) => {
  try {
    const me = req.user;
    const msg = await Message.findById(req.params.id).lean();
    if (!msg) return res.status(404).json({ error: 'Not found' });
    const check = await canReadConversation(me, msg.conversationKey);
    if (!check.ok) return res.status(403).json({ error: 'Not authorized' });

    const delivered = new Set((msg.deliveredTo || []).map((x) => String(x)));
    const read = new Set((msg.reads || []).map((x) => String(x)));
    const counts = (ids) => ({
      total: ids.length,
      receivedCount: ids.filter((x) => delivered.has(String(x))).length,
      readCount: ids.filter((x) => read.has(String(x))).length,
    });

    const sender = msg.sender
      ? await User.findById(msg.sender)
          .select('name email emailNorm phone role username teacherId subject batch course avatarUrl status isVerified notificationsEnabled teacherChatAccess supportAccess').lean()
      : null;
    // Support side (either direction over a plain direct): the full sender
    // sheet profile so the support account can identify anyone who messages
    // them, and a student who messages support sees the support account.
    if (isSupportAccount(me) || (sender && isSupportAccount(sender))) {
      return res.json({ kind: 'support', sender: sender || null, members: [], total: 0, receivedCount: 0, readCount: 0 });
    }

    if (!msg.conversationKey.startsWith('group:')) {
      const peers = (msg.participantIds || []).map(String).filter((x) => x !== String(me._id));
      return res.json({ kind: 'direct', members: [], ...counts(peers) });
    }
    const gid = msg.conversationKey.slice(6);
    const g = await Group.findOne({ groupId: gid }).lean();
    if (!g) return res.status(404).json({ error: 'Group not found' });

    if (g.type === 'BATCH' && (me.role === 'teacher' || me.role === 'supportAdmin')) {
      const rels = await Membership.find({ kind: 'student', groupId: gid, access: true }).lean();
      const students = await User.find({ _id: { $in: rels.map((r) => r.user) }, role: 'student', status: 'Active' })
        .select('name email avatarUrl batch course').lean();
      const members = students
        .map((s) => ({
          id: String(s._id),
          name: s.name,
          email: s.email,
          avatarUrl: s.avatarUrl,
          batch: s.batch || '',
          course: s.course || '',
          received: delivered.has(String(s._id)),
          read: read.has(String(s._id)),
        }))
        .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
      return res.json({
        kind: 'batch',
        members,
        total: members.length,
        receivedCount: members.filter((m) => m.received).length,
        readCount: members.filter((m) => m.read).length,
      });
    }
    return res.json({ kind: 'group', members: [], total: 0, receivedCount: 0, readCount: 0 });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Failed to load message info' });
  }
});

// POST /api/messages/:id/react { emoji }
router.post('/:id/react', async (req, res) => {
  try {
    const msg = await Message.findById(req.params.id);
    if (!msg) return res.status(404).json({ error: 'Not found' });
    const check = await canReadConversation(req.user, msg.conversationKey);
    if (!check.ok) return res.status(403).json({ error: 'Not authorized' });
    const emoji = String(req.body.emoji || '').slice(0, 8);
    msg.reactions = (msg.reactions || []).filter((r) => String(r.userId) !== String(req.user._id));
    msg.reactions.push({ emoji, userId: req.user._id, userName: req.user.name });
    await msg.save();
    req.app.get('io')?.to(msg.conversationKey).emit('message:updated', cleanMsg(msg, req.user._id));
    return res.json({ message: cleanMsg(msg, req.user._id) });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to react' });
  }
});

// POST /api/messages/:id/vote { optionId }
router.post('/:id/vote', async (req, res) => {
  try {
    const msg = await Message.findById(req.params.id);
    if (!msg || !msg.poll) return res.status(404).json({ error: 'Poll not found' });
    const check = await canReadConversation(req.user, msg.conversationKey);
    if (!check.ok) return res.status(403).json({ error: 'Not authorized' });
    for (const o of msg.poll.options) {
      o.votes = (o.votes || []).filter((v) => String(v) !== String(req.user._id));
      if (o.id === req.body.optionId) o.votes.push(req.user._id);
    }
    await msg.save();
    req.app.get('io')?.to(msg.conversationKey).emit('message:updated', cleanMsg(msg, req.user._id));
    return res.json({ message: cleanMsg(msg, req.user._id) });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to vote' });
  }
});

// POST /api/messages/bulk-delete — multi-select delete. Body: { ids: [...] }.
// Same 24h + ownership rules as the single delete, applied to each message;
// one message:deleted socket event per removed message so every participant's
// chat list preview and cache stay in sync.
router.post('/bulk-delete', async (req, res) => {
  try {
    const raw = (req.body && req.body.ids) || [];
    const ids = Array.isArray(raw)
      ? raw.map((x) => String(x)).filter((x) => /^[a-f0-9]{24}$/i.test(x)).slice(0, 100)
      : [];
    if (!ids.length) return res.status(400).json({ error: 'No valid message ids provided.' });

    const msgs = await Message.find({ _id: { $in: ids } }).lean();
    const now = Date.now();
    const ok = [];
    const refused = [];
    for (const msg of msgs) {
      if (now - new Date(msg.createdAt).getTime() > 24 * 3600 * 1000) {
        refused.push(String(msg._id));
        continue;
      }
      const isOwner = String(msg.sender) === String(req.user._id);
      if (!isOwner && req.user.role !== 'supportAdmin') {
        refused.push(String(msg._id));
        continue;
      }
      ok.push(msg);
    }
    const okIds = ok.map((m) => String(m._id));
    if (okIds.length) {
      await Message.deleteMany({ _id: { $in: okIds } });
      for (const m of ok) {
        req.app.get('io')?.to(m.conversationKey).emit('message:deleted', { _id: String(m._id), conversation: m.conversationKey });
      }
    }
    return res.json({ ok: okIds.length, deleted: okIds, refused });
  } catch (e) {
    return res.status(500).json({ error: 'Bulk delete failed' });
  }
});

// DELETE /api/messages/:id — 24h rule: after 24h content is permanently undeletable.
router.delete('/:id', async (req, res) => {
  try {
    const msg = await Message.findById(req.params.id);
    if (!msg) return res.status(404).json({ error: 'Not found' });
    if (Date.now() - new Date(msg.createdAt).getTime() > 24 * 3600 * 1000) {
      return res.status(403).json({ error: 'Message is older than 24 hours and cannot be deleted.' });
    }
    const isOwner = String(msg.sender) === String(req.user._id);
    if (!isOwner && req.user.role !== 'supportAdmin') return res.status(403).json({ error: 'Not permitted' });
    await msg.deleteOne();
    req.app.get('io')?.to(msg.conversationKey).emit('message:deleted', { _id: msg._id, conversation: msg.conversationKey });
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: 'Delete failed' });
  }
});

module.exports = router;
module.exports.canReadConversation = canReadConversation;
module.exports.canSendInConversation = canSendInConversation;
module.exports.cleanMsg = cleanMsg;
module.exports.resolveAnnouncement = resolveAnnouncement;
module.exports.buildReplyTo = buildReplyTo;