const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const OtpSession = require('../models/OtpSession');
const { signToken, DEVICE_BLOCK_MSG } = require('../middleware/auth');
const { sendOtpEmail } = require('../services/mailer');
const { runSync, checkUserInSheet } = require('../services/sheetsSync');
const { ensureSupportAccount, isSupportCredentials, isSupportAccount } = require('../services/support');

const router = express.Router();
const norm = (v) => String(v || '').trim().toLowerCase();

function makeCode() {
  return String(100000 + (Date.now() % 900000)).padStart(6, '0');
}

// One account, ONE device at a time: while `currentDeviceId` is set (and the
// session is not stale — JWTs live 30 days, mirroring signToken), a login
// attempt from ANY other device is rejected with 403 instead of silently
// taking over. Logging out (POST /api/auth/logout) clears the lock, which is
// how a user moves to a new device. The rejection message itself lives in
// middleware/auth.js and is shared with the per-request device check.
const SESSION_ACTIVE_MS = 30 * 24 * 60 * 60 * 1000;
function blockedByOtherDevice(user, deviceId) {
  if (!deviceId || !user.currentDeviceId || user.currentDeviceId === deviceId) return false;
  const last = user.lastLoginAt ? new Date(user.lastLoginAt).getTime() : 0;
  if (last && Date.now() - last > SESSION_ACTIVE_MS) return false; // abandoned lock
  return true;
}

// POST /api/auth/request-otp { email, teacherId? }
router.post('/request-otp', async (req, res) => {
  try {
    const email = norm(req.body.email);
    const teacherId = String(req.body.teacherId || '').trim();
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }
    // Verify against the live sheet first, so newly added/blocked users take
    // effect immediately. A sync failure falls back to the last good DB state
    // and must never block login (spec: retain last synchronized state).
    try {
      await runSync();
    } catch (e) {
      console.log('[auth] pre-login sync failed, using last good state:', e.message);
    }
    // The SkillParkho Support teacher is created/kept from .env config, not
    // from the sheet, and logs in WITHOUT an OTP (see below).
    await ensureSupportAccount();
    const user = await User.findOne({ emailNorm: email });
    if (!user) return res.status(404).json({ error: 'No SkillParkho account found for this email.' });
    if (user.status !== 'Active') return res.status(403).json({ error: 'Your account is inactive.' });

    // Single-device: reject a SECOND device outright while this account's
    // session on another device is still active — fails fast, before the
    // user ever types an OTP (same rule enforced again at verify-otp).
    const reqDeviceId = String(req.body.deviceId || '').trim();
    if (blockedByOtherDevice(user, reqDeviceId)) {
      return res.status(403).json({ error: DEVICE_BLOCK_MSG });
    }

    const wantsTeacher = user.role === 'teacher' || !!teacherId;
    if (wantsTeacher) {
      if (!teacherId) return res.status(400).json({ error: 'Please enter your Teacher ID.' });
      const tid = teacherId.toLowerCase();
      const candidates = [(user.teacherId || ''), (user.username || ''), String(user._id)].map((s) => String(s).toLowerCase());
      if (!candidates.includes(tid)) return res.status(400).json({ error: 'Teacher ID does not match our records.' });
      if (user.role !== 'teacher') return res.status(400).json({ error: 'This email is not a teacher account.' });
    }

    // Support login: matching email + Teacher ID from .env -> direct token, no OTP.
    if (isSupportCredentials(email, teacherId)) {
      // Same contract as verify-otp/support-login: record the device lock so
      // the direct-token session is single-device too.
      const upd = { lastLoginAt: new Date() };
      if (reqDeviceId) upd.currentDeviceId = reqDeviceId;
      await User.findByIdAndUpdate(user._id, upd);
      const token = signToken(user, reqDeviceId);
      return res.json({ ok: true, directToken: token, user });
    }

    const code = makeCode();
    const ttl = Number(process.env.OTP_EXPIRES_MINUTES || process.env.OTP_TTL_MINUTES || 5);
    const resendAfter = Number(process.env.OTP_RESEND_SECONDS || 45);
    await OtpSession.deleteMany({ emailNorm: email });
    await OtpSession.create({ emailNorm: email, code, expiresAt: new Date(Date.now() + ttl * 60000) });
    // Identity comes from Google-Sheets-synced users; unknown emails were
    // rejected above, so no account is created here.
    const emailed = await sendOtpEmail(email, code, user.name).catch(() => false);
    // The code is NEVER returned to the client — the user types the code they
    // received by email. Set OTP_DEV_RETURN_CODE=true ONLY in a throwaway dev
    // environment when you need to peek at it.
    const devReturn = String(process.env.OTP_DEV_RETURN_CODE || 'false') === 'true';
    return res.json({
      ok: true,
      expiresMin: ttl,
      resendAfter,
      ...(devReturn && !emailed ? { code } : {}),
    });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to send OTP' });
  }
});

// POST /api/auth/verify-otp { email, code, deviceId? } -> { token, user }
// Enforces single-device login: a SECOND device is REJECTED (403) while the
// account's session on another device is active — never a silent takeover.
router.post('/verify-otp', async (req, res) => {
  try {
    const email = norm(req.body.email);
    const code = String(req.body.code || '').trim();
    const deviceId = String(req.body.deviceId || '').trim() || undefined;
    const sess = await OtpSession.findOne({ emailNorm: email });
    if (!sess) return res.status(400).json({ error: 'No OTP requested. Please tap Send OTP again.' });
    if (new Date() > sess.expiresAt) return res.status(400).json({ error: 'OTP expired. Please resend.' });
    if (sess.code !== code) return res.status(400).json({ error: 'Invalid OTP. Please check the 6-digit code.' });
    const user = await User.findOne({ emailNorm: email });
    if (!user) return res.status(404).json({ error: 'Account not found.' });
    if (user.status !== 'Active') return res.status(403).json({ error: 'Your account is inactive.' });
    
    // Single-device login: a SECOND device is REJECTED while this account's
    // session on another device is still active — never a silent takeover.
    // (Logging out on the first device clears currentDeviceId and unblocks.)
    if (blockedByOtherDevice(user, deviceId)) {
      return res.status(403).json({ error: DEVICE_BLOCK_MSG });
    }
    
    await OtpSession.deleteMany({ emailNorm: email });
    const update = { lastLoginAt: new Date() };
    if (deviceId) update.currentDeviceId = deviceId;
    await User.findByIdAndUpdate(user._id, update);
    const token = signToken(user, deviceId);
    const updatedUser = await User.findById(user._id).lean();
    return res.json({ ok: true, token, user: updatedUser });
  } catch (e) {
    return res.status(500).json({ error: 'Verification failed' });
  }
});

// POST /api/auth/support-login { email, teacherId, deviceId? } -> { token, user }
// Direct login for support account (no OTP), with single-device enforcement.
router.post('/support-login', async (req, res) => {
  try {
    const email = norm(req.body.email);
    const teacherId = String(req.body.teacherId || '').trim();
    const deviceId = String(req.body.deviceId || '').trim() || undefined;
    
    if (!isSupportCredentials(email, teacherId)) {
      return res.status(401).json({ error: 'Invalid support credentials.' });
    }
    
    await ensureSupportAccount();
    const user = await User.findOne({ emailNorm: email, role: 'teacher' });
    if (!user || user.status !== 'Active') {
      return res.status(403).json({ error: 'Support account not available.' });
    }
    
    // Single-device: same hard rejection as verify-otp — a second device
    // cannot sign the support account in while another session is active.
    if (blockedByOtherDevice(user, deviceId)) {
      return res.status(403).json({ error: DEVICE_BLOCK_MSG });
    }
    
    const update = { lastLoginAt: new Date() };
    if (deviceId) update.currentDeviceId = deviceId;
    await User.findByIdAndUpdate(user._id, update);
    
    const token = signToken(user, deviceId);
    const updatedUser = await User.findById(user._id).lean();
    return res.json({ ok: true, token, user: updatedUser, directToken: token });
  } catch (e) {
    return res.status(500).json({ error: 'Support login failed' });
  }
});

const { authRequired } = require('../middleware/auth');
router.get('/me', authRequired, async (req, res) => res.json({ user: req.user }));

// POST /api/auth/logout { deviceId? } — releases this account's single-device
// login lock so the user can sign in on another device afterwards. Only the
// device that owns the lock (or a client with no deviceId — e.g. after a
// reinstall wiped its stored id) may clear it; a stale token from a replaced
// device can never clear someone else's active session.
router.post('/logout', authRequired, async (req, res) => {
  try {
    const deviceId = String(req.body.deviceId || '').trim();
    const u = await User.findById(req.user._id);
    if (u && (!deviceId || !u.currentDeviceId || u.currentDeviceId === deviceId)) {
      u.currentDeviceId = '';
      // The logging-out device's push tokens go with the lock: a signed-out
      // install must never receive FCM pushes for this account.
      u.fcmTokens = deviceId
        ? (u.fcmTokens || []).filter((t) => t.deviceId !== deviceId)
        : [];
      await u.save();
    }
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: 'Logout failed' });
  }
});

// POST /api/auth/register-device { token, deviceId } — stores this install's
// FCM token so messages can reach it while the app is closed. Replaces any
// older token from the same device (FCM rotates tokens) and caps the list at
// five devices' worth.
router.post('/register-device', authRequired, async (req, res) => {
  try {
    const token = String(req.body.token || '').trim();
    const deviceId = String(req.body.deviceId || '').trim();
    if (!token || token.length > 4096) return res.status(400).json({ error: 'Missing token' });
    const u = await User.findById(req.user._id);
    if (!u) return res.status(401).json({ error: 'Unknown user' });
    const keep = (u.fcmTokens || []).filter((t) => t.token !== token && t.deviceId !== (deviceId || '\u0000'));
    keep.unshift({ token, deviceId, updatedAt: new Date() });
    u.fcmTokens = keep.slice(0, 5);
    await u.save();
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: 'Failed to register device' });
  }
});

// POST /api/auth/refresh { token, deviceId? } — SILENT JWT RENEWAL.
// An expired (but authentic) token is exchanged for a fresh one so an active
// user is never kicked out mid-use: an explicit logout or a failed sheet
// validation are the only ways a session ends. The signature must still
// verify (expiry ignored), the account must exist and be Active, renewal is
// capped at 90 days after issue as an absolute staleness bound, and a device
// that no longer owns the single-device lock cannot renew.
router.post('/refresh', async (req, res) => {
  try {
    const old = String(req.body.token || '');
    if (!old) return res.status(400).json({ error: 'Missing token' });
    let payload;
    try {
      payload = jwt.verify(old, process.env.JWT_SECRET || 'dev-secret', { ignoreExpiration: true });
    } catch (_) {
      return res.status(401).json({ error: 'Session is no longer valid. Please sign in again.' });
    }
    const iatMs = (payload.iat || 0) * 1000;
    if (!iatMs || Date.now() - iatMs > 90 * 24 * 60 * 60 * 1000) {
      return res.status(401).json({ error: 'Session has expired. Please sign in again.' });
    }
    const user = await User.findById(payload.sub);
    if (!user || user.status !== 'Active') {
      return res.status(401).json({ error: 'This account is no longer active.' });
    }
    const deviceId = String(req.body.deviceId || '').trim();
    // A session whose lock was released (logout) can never be renewed, even
    // with an authentic token — that's what makes logged-out tokens dead.
    if (payload.deviceId && !user.currentDeviceId) {
      return res.status(401).json({ error: 'Session is no longer valid. Please sign in again.' });
    }
    if (user.currentDeviceId && deviceId && user.currentDeviceId !== deviceId) {
      return res.status(403).json({ error: DEVICE_BLOCK_MSG });
    }
    // Keep the active-session window (and with it the single-device lock)
    // sliding while the app is genuinely in use — mirrors the 30d JWT life.
    await User.findByIdAndUpdate(user._id, { lastLoginAt: new Date() });
    // Carry the owning device into the fresh token (legacy tokens without the
    // claim upgrade here).
    const token = signToken(user, deviceId || payload.deviceId);
    const fresh = await User.findById(user._id).lean();
    return res.json({ token, user: fresh });
  } catch (e) {
    return res.status(500).json({ error: 'Could not refresh the session' });
  }
});

// POST /api/auth/validate-session — called on EVERY app open. Re-checks the
// live Google Sheet for THIS account and rejects the session when the user
// was removed from the sheet or is no longer Active. The Support account is
// EXEMPT: it is created from .env, not from any sheet row, so sheet
// validation must never apply to it (that mismatch is exactly what used to
// break support logins). When the sheet is unreachable or not configured we
// fall back to the last synchronized DB state — a network hiccup must never
// log anyone out.
router.post('/validate-session', authRequired, async (req, res) => {
  try {
    const u = await User.findById(req.user._id);
    if (!u) return res.status(403).json({ error: 'This account no longer exists.', code: 'SESSION_INVALID' });
    if (isSupportAccount(u)) return res.json({ ok: true });
    const live = await checkUserInSheet(u.emailNorm);
    if (live === null) {
      if (u.status !== 'Active') {
        return res.status(403).json({ error: 'Your account is not active. Contact your administrator.', code: 'SESSION_INVALID' });
      }
      return res.json({ ok: true });
    }
    if (!live.inSheet) {
      return res.status(403).json({ error: 'Your account is no longer listed in the SkillParkho sheet. Contact your administrator.', code: 'SESSION_INVALID' });
    }
    if (live.status !== 'Active') {
      if (u.status !== 'Inactive') {
        u.status = 'Inactive';
        await u.save();
      }
      return res.status(403).json({ error: 'Your account has been deactivated. Contact your administrator.', code: 'SESSION_INVALID' });
    }
    return res.json({ ok: true });
  } catch (e) {
    // Transient DB trouble: 500 (not 403) so the client keeps the session.
    return res.status(500).json({ error: 'Session check failed' });
  }
});

module.exports = router;
