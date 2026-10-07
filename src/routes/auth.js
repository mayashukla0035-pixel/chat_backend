const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const OtpSession = require('../models/OtpSession');
const { signToken, DEVICE_BLOCK_MSG } = require('../middleware/auth');
const { sendOtpEmail } = require('../services/mailer');
const { maybeRunSync, checkUserInSheet } = require('../services/sheetsSync');
const { ensureSupportAccount, isSupportCredentials, isSupportAccount } = require('../services/support');

const router = express.Router();
const norm = (v) => String(v || '').trim().toLowerCase();

function makeCode() {
  return String(100000 + (Date.now() % 900000)).padStart(6, '0');
}

// One account, ONE device at a time: `currentDeviceId` is the device lock.
// NEW LOGIN WINS — a verified login (OTP / support credentials prove account
// ownership) always takes over the lock, so an uninstall-reinstall or a new
// phone can never be locked out by a stale lock. The previous device is
// evicted by the per-request DEVICE_REPLACED check (its app wipes itself),
// by /refresh refusal, at the socket handshake, and here on live sockets —
// so two devices are never ACTIVE at once even though login is never refused.
function evictLiveSockets(req, userId) {
  try {
    const io = req.app.get('io');
    if (!io) return;
    const id = String(userId);
    // The handshake check only guards NEW connections — an already-open
    // socket of the replaced device must be cut here, or it would keep
    // receiving (and sending) under the evicted session.
    for (const s of io.sockets.sockets.values()) {
      if (s.user && String(s.user._id) === id) s.disconnect(true);
    }
  } catch (_) {}
}

// POST /api/auth/request-otp { email, teacherId? }
router.post('/request-otp', async (req, res) => {
  try {
    const email = norm(req.body.email);
    const teacherId = String(req.body.teacherId || '').trim();
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }
    // Sheet freshness now happens in the BACKGROUND: a full sync on this
    // request path (hundreds of sequential DB roundtrips) made responses take
    // 15s+, so the client timed out with "server isn't reachable" even though
    // the OTP was eventually delivered. Login reads the last good DB state,
    // which the 5-minute interval keeps fresh. Unknown emails get ONE
    // coalesced catch-up sync (at most once a minute) so brand-new sheet rows
    // still log in promptly.
    maybeRunSync(); // fire-and-forget
    // The SkillParkho Support teacher is created/kept from .env config, not
    // from the sheet, and logs in WITHOUT an OTP (see below).
    await ensureSupportAccount();
    let user = await User.findOne({ emailNorm: email });
    if (!user) {
      // Unknown email: the periodic sync may not have picked up a brand-new
      // sheet row yet. Give it one coalesced catch-up run (at most one per
      // minute, shared across concurrent requests) and re-check, so a fresh
      // sheet row can still log in on first try without putting a full sync
      // on every login request.
      await maybeRunSync(60000);
      user = await User.findOne({ emailNorm: email });
    }
    if (!user) return res.status(404).json({ error: 'No SkillParkho account found for this email.' });
    if (user.status !== 'Active') return res.status(403).json({ error: 'Your account is inactive.' });

    // Single-device: no rejection HERE — the lock is only ever contested at
    // the verified step (verify-otp / support direct token), where the new
    // device takes it over.
    const reqDeviceId = String(req.body.deviceId || '').trim();

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
      if (reqDeviceId) {
        upd.currentDeviceId = reqDeviceId;
        upd.fcmTokens = (user.fcmTokens || []).filter((t) => t && t.deviceId === reqDeviceId);
      }
      await User.findByIdAndUpdate(user._id, upd);
      evictLiveSockets(req, user._id);
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
// NEW LOGIN WINS: the OTP proves account ownership, so a verified login
// always takes over the single-device lock — login is never refused.
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
    
    await OtpSession.deleteMany({ emailNorm: email });
    const update = { lastLoginAt: new Date() };
    if (deviceId) {
      update.currentDeviceId = deviceId;
      // Takeover cleanup: drop the evicted device's push tokens (they can
      // never be used again — pushes only target the lock-owning device).
      // Same-device re-login keeps its own tokens.
      update.fcmTokens = (user.fcmTokens || []).filter((t) => t && t.deviceId === deviceId);
    }
    await User.findByIdAndUpdate(user._id, update);
    evictLiveSockets(req, user._id);
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
    
    // Same new-login-wins rule as verify-otp: the support credentials are
    // full proof, so the lock is taken over and any previous device evicted.
    const update = { lastLoginAt: new Date() };
    if (deviceId) {
      update.currentDeviceId = deviceId;
      update.fcmTokens = (user.fcmTokens || []).filter((t) => t && t.deviceId === deviceId);
    }
    await User.findByIdAndUpdate(user._id, update);
    evictLiveSockets(req, user._id);
    
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
    // Self-signups exist only in the database and are never expected to appear
    // in the spreadsheet. Validating them against it would log every one of them
    // out on the very next app open.
    if (u.origin === 'selfSignup') {
      return u.status === 'Active'
        ? res.json({ ok: true })
        : res.status(403).json({ error: 'Your account has been deactivated. Contact your administrator.', code: 'SESSION_INVALID' });
    }
    const live = await checkUserInSheet(u.emailNorm);
    if (live === null) {
      if (u.status !== 'Active') {
        return res.status(403).json({ error: 'Your account is not active. Contact your administrator.', code: 'SESSION_INVALID' });
      }
      return res.json({ ok: true });
    }
    // NOT being listed is no longer a reason to end the session: an account that
    // is absent from the spreadsheet keeps working and simply reaches nothing
    // beyond SkillParkho Support, because it has no group memberships. Only an
    // explicit Inactive status removes the account.
    if (!live.inSheet) {
      return res.json({ ok: true });
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
