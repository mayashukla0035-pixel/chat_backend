const jwt = require('jsonwebtoken');
const User = require('../models/User');
const Message = require('../models/Message');
const msgRoutes = require('../routes/messages');
const { resolveAttachment } = require('../services/attachments');

function initSocket(io) {
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token || socket.handshake.query?.token;
      if (!token) return next(new Error('Missing token'));
      const payload = jwt.verify(token, process.env.JWT_SECRET || 'dev-secret');
      const user = await User.findById(payload.sub);
      if (!user || user.status !== 'Active') return next(new Error('Inactive account'));
      socket.user = user;
      next();
    } catch (e) {
      next(new Error('Invalid token'));
    }
  });

  io.on('connection', (socket) => {
    const me = socket.user;

    // Join only authorized conversations — server re-checks every join (never
    // trust client). Every conversation (group, direct, support-as-direct) is
    // its own room named by its conversationKey.
    socket.on('join', async (conversationKey, ack) => {
      try {
        const key = String(conversationKey);
        const check = await msgRoutes.canReadConversation(me, key);
        if (!check.ok) return ack?.({ ok: false, error: 'Not authorized' });
        socket.join(key);
        // Receipt: joining = this device received the room. Mark other people's
        // messages delivered and notify senders of the most recent ones so
        // their ticks advance to double ✓ even when they sent while offline.
        try {
          const res = await Message.updateMany(
            { conversationKey: key, sender: { $ne: me._id }, deliveredTo: { $ne: me._id } },
            { $addToSet: { deliveredTo: me._id } },
          );
          if (res.modifiedCount) {
            const recent = await Message.find({
              conversationKey: key,
              sender: { $ne: me._id },
              deliveredTo: me._id,
            }).sort({ createdAt: -1 }).limit(15).lean();
            for (const m of recent) {
              io.to(key).emit('message:updated', msgRoutes.cleanMsg(m, me._id));
            }
          }
        } catch (_) {}
        ack?.({ ok: true });
      } catch (e) {
        ack?.({ ok: false });
      }
    });

    socket.on('leave', (key) => socket.leave(String(key)));

    // Realtime delivery ack: a connected device received the message (client
    // fires this when message:new arrives while the chat screen is closed).
    socket.on('delivered', async (payload) => {
      try {
        const key = String(payload?.conversation || '');
        const ids = Array.isArray(payload?.ids) ? payload.ids.map(String).filter(Boolean).slice(0, 50) : [];
        if (!key || !ids.length) return;
        const check = await msgRoutes.canReadConversation(me, key);
        if (!check.ok) return;
        const res = await Message.updateMany(
          { _id: { $in: ids }, conversationKey: key, sender: { $ne: me._id } },
          { $addToSet: { deliveredTo: me._id } },
        );
        if (res.modifiedCount) {
          const msgs = await Message.find({ _id: { $in: ids } }).lean();
          for (const m of msgs) {
            io.to(key).emit('message:updated', msgRoutes.cleanMsg(m, me._id));
          }
        }
      } catch (_) {}
    });

    // Local-first send path: client shows optimistic message, server confirms + broadcasts.
    socket.on('send', async (payload, ack) => {
      try {
        const key = String(payload?.conversation || '');
        const check = await msgRoutes.canSendInConversation(me, key);
        if (!check.ok) return ack?.({ ok: false, error: check.reason || 'Cannot send here' });
        const content = String(payload?.content || '').slice(0, 4000);
        if (!content.trim() && !payload?.attachment && !payload?.poll) {
          return ack?.({ ok: false, error: 'Empty message' });
        }
        // Privacy wall #2: same ownership check as the REST send — the
        // attachment must be one of THIS user's own uploads.
        const attach = await resolveAttachment(me, payload?.attachment);
        if (attach.error) return ack?.({ ok: false, error: attach.error });
        // Idempotent send: a retried send (queue flush / REST fallback) must
        // never create a second server row — return the existing one instead.
        // The dedupe is GLOBAL on clientId (not scoped per sender): the CSPRNG
        // client ids are unique per logical send, and a stale fallback posted
        // under a switched account's token carries the SAME clientId — that is
        // exactly what used to reappear as a "reply". Global lookup returns the
        // single original row in every case.
        const clientId = String(payload?._clientId || payload?.clientId || '');
        if (clientId) {
          const existing = await Message.findOne({ clientId }).lean();
          if (existing) {
            const out = msgRoutes.cleanMsg(existing, me._id);
            out.delivered = (existing.deliveredTo || []).some((id) => String(id) !== String(me._id));
            out.read = (existing.reads || []).some((id) => String(id) !== String(me._id));
            return ack?.({ ok: true, message: out });
          }
        }
        // Swipe-to-reply: same server-side snapshot validation as the REST send.
        const replyTo = await msgRoutes.buildReplyTo(key, payload?.replyTo);
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
            content: content.trim(), attachment: attach.attachment,
            poll: payload?.poll && (payload.poll.question || (payload.poll.options || []).length) ? payload.poll : undefined,
            replyTo,
            isAnnouncement: await msgRoutes.resolveAnnouncement(groupId),
          });
        } catch (e) {
          // The unique (clientId) index won: a concurrent retry stored
          // this send between our lookup and create — ack with that exact row
          // instead of emitting (the winning path already broadcast it).
          if (e && e.code === 11000 && clientId) {
            const existing = await Message.findOne({ clientId }).lean();
            if (existing) {
              const outDup = msgRoutes.cleanMsg(existing, me._id);
              outDup.delivered = (existing.deliveredTo || []).some((id) => String(id) !== String(me._id));
              outDup.read = (existing.reads || []).some((id) => String(id) !== String(me._id));
              return ack?.({ ok: true, message: outDup });
            }
          }
          throw e;
        }
        const out = msgRoutes.cleanMsg(msg, me._id);
        // Receipt: if the other side of this conversation is online right now,
        // their device just received it — mark delivered at once.
        try {
          const roomSockets = await io.in(key).fetchSockets();
          const others = [...new Set(roomSockets
            .map((s) => (s.user && s.user._id ? String(s.user._id) : ''))
            .filter((id) => id && id !== String(me._id)))];
          if (others.length) {
            await Message.updateOne({ _id: msg._id }, { $addToSet: { deliveredTo: { $each: others } } });
            out.delivered = true;
          }
        } catch (_) {}
        io.to(key).emit('message:new', { ...out, _clientId: clientId || undefined });
        ack?.({ ok: true, message: out });
      } catch (e) {
        ack?.({ ok: false, error: 'Send failed' });
      }
    });

    socket.on('typing', (key) => {
      socket.to(String(key)).emit('typing', { userId: String(me._id), name: me.name });
    });
  });
}

module.exports = { initSocket };