const mongoose = require('mongoose');

const reactionSchema = new mongoose.Schema({
  emoji: String,
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  userName: String,
  createdAt: { type: Date, default: Date.now },
}, { _id: false });

const pollOptionSchema = new mongoose.Schema({
  id: String,
  text: String,
  votes: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
}, { _id: false });

const messageSchema = new mongoose.Schema({
  conversationKey: { type: String, required: true, index: true }, // groupId OR direct:<sortedIds>
  groupId: { type: String, index: true },       // set for group/support/org/batch messages
  directKey: { type: String, index: true },     // set for direct messages
  participantIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], // direct chats
  sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  senderName: String,
  senderRole: String,
  // The sender's profile image URL, copied from the User doc at send time so
  // history/socket payloads can render the avatar without an extra lookup.
  // (Previously missing from the schema, so Mongoose silently dropped it and
  // every message bubble showed an empty avatar — this field fixes it; the
  // GET history route also backfills older rows from the sender's current
  // profile.)
  senderAvatar: String,
  // The device's client-generated id for this send ('local-…'). Used as an
  // idempotency key so REST-fallback / queue-flush retries can NEVER create a
  // second copy of the same message (WhatsApp-style exactly-once delivery).
  clientId: { type: String, index: true },
  content: { type: String, default: '' },
  // WhatsApp-style swipe-to-reply: a SNAPSHOT of the referenced message taken
  // server-side at send time (never trusted from the client), so the quote
  // still renders even if the original message is deleted later.
  replyTo: {
    messageId: { type: mongoose.Schema.Types.ObjectId },
    senderId: { type: mongoose.Schema.Types.ObjectId },
    senderName: { type: String, default: '' },
    content: { type: String, default: '' },
    kind: { type: String, default: 'text' }, // text | image | video | audio | pdf | archive | doc | poll
  },
  attachment: {
    name: String, size: String, mime: String, url: String, kind: String, duration: String,
  },
  poll: {
    id: String, question: String, isActive: { type: Boolean, default: true },
    options: [pollOptionSchema],
  },
  isAnnouncement: { type: Boolean, default: false },
  reactions: [reactionSchema],
  // per-user state (read/unread, archive) — keeps "no data mixing" at DB level
  reads: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  // receipts: users whose device received the message (delivered) — same shape
  // as reads, so senders can show ✓ → ✓✓ → blue ✓✓.
  deliveredTo: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  archivedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  mutedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
  // SkillParkho Support inbox: each support message belongs to ONE student.
  //  - student -> support messages: supportFor = student
  //  - support -> student replies:  supportFor = that student
  // This is what turns the old shared room into per-student private threads.
  supportFor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
}, { timestamps: true });

messageSchema.index({ conversationKey: 1, createdAt: 1 });
// Exact-once delivery: one message per clientId — GLOBALLY, regardless of
// sender. The CSPRNG client ids are unique per logical send, so this is safe,
// and it is what kills the cross-account echo: a stale REST fallback posted
// under a switched account's token carries the same clientId, and a per-sender
// index would have stored it as a brand-new row under the other sender.
// The explicit name sidesteps the legacy non-unique sender_1_clientId_1 index,
// and the partial filter means legacy rows without a clientId can't collide.
messageSchema.index(
  { clientId: 1 },
  { name: 'clientId_unique', unique: true, partialFilterExpression: { clientId: { $type: 'string' } } }
);
// Compatibility: the old per-sender unique index is superseded by the global
// one above; it is kept only so existing deployments need no index rebuild.
messageSchema.index(
  { sender: 1, clientId: 1 },
  { name: 'sender_clientId_unique', unique: true, partialFilterExpression: { clientId: { $type: 'string' } } }
);

// 24h deletion rule enforced in routes/socket (after 24h -> undeletable).
module.exports = mongoose.model('Message', messageSchema);
