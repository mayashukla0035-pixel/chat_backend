// FCM push notifications — the CLOSED-APP delivery path.
//
// While a recipient's socket is in the room, they get the live socket event
// and ring locally; this module covers everything else: app backgrounded with
// a dead socket, or the process fully killed after a swipe. Pushes only go to
// tokens registered by the device that currently owns the account's
// single-device login lock, so a logged-out (or replaced) install is silent.
//
// Configuration (either one):
//   FCM_SERVICE_ACCOUNT       — the service-account JSON, as a single-line
//                               string (Railway environment variable).
//   GOOGLE_APPLICATION_CREDENTIALS — path to that JSON file (local dev).
// Without either, the backend runs exactly as before with push disabled.
// firebase-admin v14 dropped the legacy root namespace (admin.credential no
// longer exists) — the modular API is the supported shape across v10+.
const { initializeApp, cert, applicationDefault } = require('firebase-admin/app');
const { getMessaging } = require('firebase-admin/messaging');
const User = require('../models/User');
const Membership = require('../models/Membership');
const Group = require('../models/Group');

let ready = false;

function initPush() {
  if (ready) return;
  try {
    const raw = process.env.FCM_SERVICE_ACCOUNT;
    if (raw) {
      initializeApp({ credential: cert(JSON.parse(raw)) });
    } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      initializeApp({ credential: applicationDefault() });
    } else {
      console.log('[push] FCM not configured (set FCM_SERVICE_ACCOUNT) — push notifications disabled');
      return;
    }
    ready = true;
    console.log('[push] FCM initialized');
  } catch (e) {
    console.log('[push] FCM init failed:', e.message);
  }
}

// Every Active user entitled to receive this conversation's messages,
// excluding the sender: the direct peer, or the group's members.
async function recipientIds(key, senderId) {
  const out = new Set();
  if (key.startsWith('direct:')) {
    for (const id of key.slice(7).split(':')) {
      if (id && id !== senderId) out.add(id);
    }
    return [...out];
  }
  if (key.startsWith('group:')) {
    const gid = key.slice(6);
    const g = await Group.findOne({ groupId: gid }).lean();
    if (!g || g.status !== 'Active') return [];
    const mem = await Membership.find({ groupId: gid, access: true }).lean();
    if (!mem.length) return [];
    const users = await User.find({
      emailNorm: { $in: mem.map((m) => m.emailNorm) },
      status: 'Active',
    }).lean();
    for (const u of users) {
      const id = String(u._id);
      if (id !== senderId) out.add(id);
    }
    return [...out];
  }
  return [];
}

function previewBody(msg) {
  const body = String(msg.content || '').trim();
  if (body) return body.slice(0, 120);
  const kind = (msg.attachment && msg.attachment.kind) || '';
  if (kind === 'image') return '📷 Photo';
  if (kind === 'video') return '🎬 Video';
  if (kind === 'audio') return '🎤 Voice message';
  if (msg.poll) return '📊 Poll';
  if (kind) return '📎 Attachment';
  return 'New message';
}

// Fire-and-forget after a message is stored + broadcast. Never throws (the
// send path must not care about push). Skips recipients who are connected in
// the room right now — they ring locally — and prunes dead registration
// tokens so the stored lists stay clean.
async function pushNewMessage(io, key, msg, sender) {
  try {
    if (!ready) return;
    const senderId = String((sender && sender._id) || sender || '');
    const ids = await recipientIds(key, senderId);
    if (!ids.length) return;
    const users = await User.find({ _id: { $in: ids } })
      .select('name notificationsEnabled currentDeviceId fcmTokens')
      .lean();
    if (!users.length) return;
    // Live sockets in this room already show an in-app notification.
    let online = new Set();
    try {
      const sockets = await io.in(key).fetchSockets();
      online = new Set(sockets
        .map((s) => (s.user && s.user._id ? String(s.user._id) : ''))
        .filter(Boolean));
    } catch (_) {}

    const tokens = [];
    for (const u of users) {
      if (u.notificationsEnabled === false) continue;
      if (online.has(String(u._id))) continue;
      // No lock = logged out = silent; tokens from a device that no longer
      // owns the lock are stale and must not ring.
      if (!u.currentDeviceId || !Array.isArray(u.fcmTokens)) continue;
      for (const t of u.fcmTokens) {
        if (t && t.token && t.deviceId === u.currentDeviceId) tokens.push(t.token);
      }
    }
    if (!tokens.length) return;

    let title = String(msg.senderName || '').trim() || 'New message';
    if (key.startsWith('group:')) {
      try {
        const g = await Group.findOne({ groupId: key.slice(6) }).lean();
        if (g && g.name) title = `${title} · ${g.name}`;
      } catch (_) {}
    }
    const body = previewBody(msg);

    const res = await getMessaging().sendEachForMulticast({
      tokens,
      data: { conversationKey: key, messageId: String(msg._id), kind: 'message' },
      notification: { title, body },
      android: {
        priority: 'high',
        notification: {
          channelId: 'chat_push',
          title,
          body,
          sound: 'default',
          clickAction: 'FLUTTER_NOTIFICATION_CLICK',
        },
      },
    });

    // Drop tokens FCM says are gone (uninstalled / reinstalled app) so a
    // user's capped token list never fills with corpses.
    const dead = [];
    res.responses.forEach((r, i) => {
      const code = r.error && r.error.code;
      if (code === 'messaging/registration-token-not-registered' ||
          code === 'messaging/invalid-registration-token') {
        dead.push(tokens[i]);
      }
    });
    if (dead.length) {
      await User.updateMany({}, { $pull: { fcmTokens: { token: { $in: dead } } } });
    }
  } catch (e) {
    console.log('[push] send failed:', e.message);
  }
}

module.exports = { initPush, pushNewMessage };
