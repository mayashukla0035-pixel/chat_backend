// OTP delivery via Resend (https://resend.com).
// Needs RESEND_API_KEY + a verified sender in RESEND_FROM_EMAIL (falls back to
// FROM_EMAIL, then the legacy RESEND_FROM). Without a key, OTP is logged for
// dev (same as before).
const { Resend } = require('resend');

const apiKey = process.env.RESEND_API_KEY || '';
const resend = apiKey ? new Resend(apiKey) : null;

const fromAddress =
  (process.env.RESEND_FROM_EMAIL || '').trim() ||
  (process.env.FROM_EMAIL || '').trim() ||
  (process.env.RESEND_FROM || '').trim() ||
  'SkillParkho Chat <no-reply@skillparkho.com>';

async function sendOtpEmail(to, code, name) {
  console.log(`[SkillParkho OTP] ${to} -> ${code}`);
  if (!resend) return false; // no Resend key configured
  const ttl = process.env.OTP_EXPIRES_MINUTES || process.env.OTP_TTL_MINUTES || 5;
  await resend.emails.send({
    from: fromAddress,
    to,
    subject: 'Your SkillParkho Chat login code',
    text: `Hello ${name || ''},\n\nYour SkillParkho Chat login code is: ${code}\nIt expires in ${ttl} minutes.\n\nIf you did not request this, please ignore this email.`,
  });
  return true;
}

module.exports = { sendOtpEmail, mailConfigured: () => !!resend };