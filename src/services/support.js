// SkillParkho Support account — a dedicated teacher login (configured in .env).
// It now behaves like ANY normal teacher account: students and the support
// teacher chat over plain `direct:<studentId>:<supportTeacherId>` conversations,
// with the full receipt/avatar/unread machinery. Login for this account skips
// OTP entirely (handled in routes/auth.js) — that is its only special-casing.
const User = require('../models/User');
const Group = require('../models/Group');
const Membership = require('../models/Membership');

const norm = (v) => String(v || '').trim().toLowerCase();

function supportEmail() {
  return norm(process.env.SUPPORT_EMAIL);
}
function supportTeacherId() {
  return String(process.env.SUPPORT_TEACHER_ID || '').trim();
}

// Does this (emailNorm, teacherId) identify the support account?
function isSupportCredentials(emailNorm, teacherId) {
  const e = supportEmail();
  const tid = norm(supportTeacherId());
  return !!(e && tid && emailNorm === e && norm(teacherId) === tid);
}

// Does this user document identify the support teacher account? Accepts a
// req.user document or a lean DB row (both carry role + emailNorm).
function isSupportAccount(user) {
  const e = supportEmail();
  return !!(user && e && user.role === 'teacher' && user.emailNorm && norm(user.emailNorm) === e);
}

// Upsert the support teacher + its GRP_SUPPORT membership so the account can
// log in and read/reply in the support room. Idempotent; safe to call at boot.
async function ensureSupportAccount() {
  const email = supportEmail();
  const teacherId = supportTeacherId();
  if (!email || !teacherId) return null;
  const user = await User.findOneAndUpdate(
    { emailNorm: email, role: 'teacher' },
    {
      email,
      emailNorm: email,
      name: 'SkillParkho Support',
      username: 'support',
      usernameNorm: 'support',
      teacherId,
      subject: 'Support',
      phone: '',
      role: 'teacher',
      status: 'Active',
      orgAnnouncementAccess: true,
      isVerified: true,
    },
    { upsert: true, new: true }
  );
  const g = await Group.findOne({ groupId: 'GRP_SUPPORT' }).lean();
  if (g) {
    await Membership.findOneAndUpdate(
      { kind: 'teacher', emailNorm: email, groupId: 'GRP_SUPPORT' },
      { kind: 'teacher', emailNorm: email, user: user._id, groupId: 'GRP_SUPPORT', group: g._id, access: true },
      { upsert: true, new: true }
    );
  }
  return user;
}

module.exports = { isSupportCredentials, isSupportAccount, ensureSupportAccount, supportEmail };