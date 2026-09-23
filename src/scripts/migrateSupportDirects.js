// One-time migration: convert the legacy support desk threads
// (`group:GRP_SUPPORT` messages with a `supportFor` student) into plain
// `direct:<studentId>:<supportTeacherId>` conversations so the support account
// behaves like a normal teacher (WhatsApp-style, with receipts/avatars/unread).
//
// Messages WITHOUT `supportFor` (old generic desk broadcasts) are left in place
// and simply become unreachable — the support desk room no longer exists.
// Idempotent: rows already migrated (conversationKey starts with 'direct:')
// are skipped. Safe to re-run.
//
// Run: node src/scripts/migrateSupportDirects.js
require('dotenv').config();
const { connectDB } = require('../config/db');
const Message = require('../models/Message');
const User = require('../models/User');
const { supportEmail, isSupportAccount } = require('../services/support');

async function main() {
  await connectDB(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/skillparkho_chat');

  const support = await User.findOne({ emailNorm: supportEmail(), role: 'teacher', status: 'Active' }).lean();
  if (!support) {
    console.log('[migrate] support teacher not found — aborting');
    process.exit(1);
  }
  const tid = String(support._id);
  console.log('[migrate] support teacher:', support.email, tid);

  const dirties = await Message.find({
    conversationKey: 'group:GRP_SUPPORT',
    supportFor: { $exists: true, $ne: null },
  }).select('_id supportFor').lean();

  const seen = new Set();
  let migrated = 0;
  let skippedByStudent = 0;
  for (const m of dirties) {
    const studentId = String(m.supportFor);
    if (seen.has(studentId)) continue; // one pass per student (dedupe)
    seen.add(studentId);
    const student = await User.findById(studentId).lean();
    if (!student) {
      skippedByStudent++;
      continue;
    }
    const directKey = `direct:${[studentId, tid].sort().join(':')}`;
    const res = await Message.updateMany(
      {
        conversationKey: 'group:GRP_SUPPORT',
        supportFor: m.supportFor,
      },
      {
        $set: { conversationKey: directKey, directKey, participantIds: [student._id, support._id] },
        $unset: { supportFor: '', groupId: '' },
      }
    );
    migrated += res.modifiedCount;
    console.log(`[migrate] ${student.name} (${student.email}) -> ${directKey} (${res.modifiedCount} messages)`);
  }

  const leftover = await Message.countDocuments({
    conversationKey: 'group:GRP_SUPPORT',
    $or: [{ supportFor: { $exists: false } }, { supportFor: null }],
  });
  console.log(`[migrate] done: migrated=${migrated} students=${seen.size} skippedOrphanStudents=${skippedByStudent} legacyGroupMessagesLeft=${leftover}`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });