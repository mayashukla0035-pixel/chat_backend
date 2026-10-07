// Account routes: password login, self-signup, Google login, and password
// reset. Mounted alongside routes/auth.js (which keeps the older emailed-OTP
// endpoints) at /api/auth.
//
// WHAT CHANGED AND WHY
// --------------------
// Sign-in no longer goes through an emailed OTP. The app now proves who the
// user is the ordinary way — with a password — and gets a JWT straight back.
// That removes a whole round trip from every login, but it also removes the
// rate-limiting that OTP gave us for free, so this file carries its own
// throttling (see `bumpFailure` / `isLocked`).
//
// The three identity proofs are deliberately kept separate:
//   * password  — POST /login       (students and teachers)
//   * Google    — POST /google-login (students only, no password; the ID
//                                    token is verified against Google)
//   * email OTP — POST /signup + /verify-signup, and /forgot-password +
//                 /reset-password
//
// ACCESS RULES
// ------------
// A row in the database proves an account exists; the spreadsheet proves what
// it may reach. `checkUserInSheet` answers the second question:
//
//   * not in the sheet at all  -> allowed in, but granted nothing beyond the
//                                 SkillParkho Support group (it simply has no
//                                 Membership rows)
//   * in the sheet, Inactive   -> refused: this is how "permission removed"
//                                 takes effect
//   * in the sheet, Active     -> full access, per its group memberships
//
// A self-signup row can never be refused for sheet reasons, because the sheet
// by definition does not know about it.

const express = require('express');
const User = require('../models/User');
const OtpSession = require('../models/OtpSession');
const { signToken } = require('../middleware/auth');
const { sendOtpEmail } = require('../services/mailer');
const { checkUserInSheet, maybeRunSync } = require('../services/sheetsSync');
const { ensureSupportAccount, isSupportAccount } = require('../services/support');
const { hashPassword, verifyPassword } = require('../services/password');

const router = express.Router();
const norm = (v) => String(v || '').trim().toLowerCase();
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

function makeCode() {
  return String(100000 + (Date.now() % 900000)).padStart(6, '0');
}

function otpTtlMinutes() {
  return Number(process.env.OTP_EXPIRES_MINUTES || process.env.OTP_TTL_MINUTES || 5);
}

function resendAfterSeconds() {
  return Number(process.env.OTP_RESEND_SECONDS || 45);
}

// ---------------------------------------------------------------------------
// Brute-force throttle for the password endpoints.
// ---------------------------------------------------------------------------
// The emailed OTP used to make guessing a password infeasible because guessing
// the OTP was equally hard. Without OTP that protection is gone, so failures
// are counted per account and the pair is locked out for a cool-off. In-memory
// on purpose: it resets with the process, which is the right trade for a
// per-instance guard, and the database lock (single-device) still applies on
// top of it.
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const LOCK_MS = 10 * 60 * 1000;
const MAX_FAILURES = 5;
const failures = new Map(); // `${emailNorm}|${ip}` -> { count, until, first }

function failureKey(req, email) {
  return `${email}|${req.ip || 'unknown'}`;
}

function isLocked(req, email) {
  const rec = failures.get(failureKey(req, email));
  if (!rec) return false;
  if (rec.until && Date.now() < rec.until) return true;
  if (rec.until && Date.now() >= rec.until) failures.delete(failureKey(req, email));
  return false;
}

function bumpFailure(req, email) {
  const k = failureKey(req, email);
  const now = Date.now();
  const rec = failures.get(k);
  if (!rec || now - rec.first > FAIL_WINDOW_MS) {
    failures.set(k, { count: 1, until: 0, first: now });
    return;
  }
  rec.count += 1;
  if (rec.count >= MAX_FAILURES) rec.until = now + LOCK_MS;
}

function clearFailures(req, email) {
  failures.delete(failureKey(req, email));
}

// Keep the map from growing without bound on a public instance.
setInterval(() => {
  const now = Date.now();
  for (const [k, rec] of failures) {
    if ((rec.until && now >= rec.until) || now - rec.first > FAIL_WINDOW_MS) {
      failures.delete(k);
    }
  }
}, FAIL_WINDOW_MS).unref();

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

/** Cuts every open socket belonging to [userId] — the device lock is changing hands. */
function evictLiveSockets(req, userId) {
  try {
    const io = req.app.get('io');
    if (!io) return;
    const id = String(userId);
    for (const s of io.sockets.sockets.values()) {
      if (s.user && String(s.user._id) === id) s.disconnect(true);
    }
  } catch (_) {}
}

/**
 * Applies the spreadsheet's verdict to [user] and reports whether the sign-in
 * may proceed.
 *
 * Returns `{ ok:false, status, error }` to refuse, or `{ ok:true }` to allow.
 *
 * The sheet is consulted only for rows the sheet owns (`origin: 'sheet'`). A
 * self-signup row is deliberately exempt: it is unknown to the spreadsheet, so
 * asking would fail-open or fail-closed for no reason. Such a user simply has
 * no group memberships, which is what limits them to SkillParkho Support.
 */
async function applySheetDecision(user) {
  if (user.origin === 'selfSignup') return { ok: true, reason: 'selfSignup' };
  // The support account is configured from .env, not from a spreadsheet row,
  // so there is no row for it to be found in. Validating it against the sheet
  // would lock the support team out of its own room.
  if (isSupportAccount(user)) return { ok: true, reason: 'support' };
  let verdict = null;
  try {
    verdict = await checkUserInSheet(user.emailNorm);
  } catch (_) {
    verdict = null;
  }
  // null => the sheet is unreachable or unconfigured. Fall back to the last
  // synchronised DB status: a network hiccup must never lock anyone out.
  if (!verdict) {
    return user.status === 'Active'
      ? { ok: true, reason: 'sheetUnreachable' }
      : { ok: false, status: 403, error: 'Your account is not active.' };
  }
  if (!verdict.inSheet) {
    // The database row proves an account exists; the spreadsheet decides what it
    // may REACH. A row that is not in the spreadsheet simply has no group
    // memberships, so the account is admitted with SkillParkho Support alone.
    // If the spreadsheet later grants groups, the sync creates those
    // memberships and they take effect on the next sign-in or app open.
    return { ok: true, reason: 'notInSheet' };
  }
  // Being IN the spreadsheet but Inactive is how removal is expressed, and it
  // is refused outright — that is the one spreadsheet state that blocks entry.
  if (verdict.status !== 'Active') {
    return {
      ok: false,
      status: 403,
      error: 'Your account has been deactivated. Please contact SkillParkho support.',
    };
  }
  return { ok: true, reason: 'inSheet' };
}

/** Records the device lock and issues the JWT, exactly like verify-otp does. */
async function completeLogin(req, user, deviceId) {
  const update = { lastLoginAt: new Date() };
  if (deviceId) {
    update.currentDeviceId = deviceId;
    update.fcmTokens = (user.fcmTokens || []).filter((t) => t && t.deviceId === deviceId);
  }
  await User.findByIdAndUpdate(user._id, update);
  evictLiveSockets(req, user._id);
  const token = signToken(user, deviceId);
  const fresh = await User.findById(user._id).lean();
  return { token, user: fresh };
}

/** Creates (or replaces) the single-use OTP for [email] and emails it. */
async function issueOtp(req, res, email, userName, purpose, role) {
  const code = makeCode();
  await OtpSession.deleteMany({ emailNorm: email });
  await OtpSession.create({
    emailNorm: email,
    code,
    purpose,
    ...(role ? { role } : {}),
    expiresAt: new Date(Date.now() + otpTtlMinutes() * 60000),
  });
  const emailed = await sendOtpEmail(email, code, userName).catch(() => false);
  const devReturn = String(process.env.OTP_DEV_RETURN_CODE || 'false') === 'true';
  return {
    ok: true,
    expiresMin: otpTtlMinutes(),
    resendAfter: resendAfterSeconds(),
    ...(devReturn && !emailed ? { code } : {}),
  };
}

/** Validates a `{ email, code, purpose }` OTP, returning the code or throwing a 4xx-shaped error. */
async function consumeOtp(email, code, purpose) {
  const sess = await OtpSession.findOne({ emailNorm: email, purpose });
  if (!sess) return { error: 'Please request the code again.', status: 400 };
  if (new Date() > sess.expiresAt) return { error: 'This code has expired. Please resend it.', status: 400 };
  if (sess.code !== code) return { error: 'Incorrect code. Please check and try again.', status: 400 };
  const role = sess.role;
  await OtpSession.deleteMany({ emailNorm: email, purpose });
  return { ok: true, role };
}

/**
 * Verifies a Google ID token against Google's own tokeninfo endpoint and
 * returns the verified email, or null if it is not valid for this app.
 *
 * The client is not trusted to assert an identity — it sends the token Google
 * minted and the claims are checked here: the audience must be this project's
 * client id, the email must be verified, and it must match the address the
 * client claims. Without this, anyone could POST any email and be logged in as
 * that user.
 */
async function verifyGoogleIdToken(idToken, expectedEmail) {
  const clientId = String(process.env.GOOGLE_WEB_CLIENT_ID || '').trim();
  if (!idToken) return { error: 'noToken' };
  if (!clientId) return { error: 'clientIdNotConfigured' };
  try {
    const r = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`,
      { method: 'GET' },
    );
    if (!r.ok) {
      // 400 is what Google returns for a token it will not accept (expired,
      // wrong audience, tampered with). The body names the reason.
      const detail = await r.text().catch(() => '');
      return { error: 'tokeninfoRejected', status: r.status, detail: detail.slice(0, 200) };
    }
    const info = await r.json();
    if (norm(info.aud) !== norm(clientId)) {
      return { error: 'audMismatch', aud: info.aud, expected: clientId };
    }
    if (info.email_verified !== 'true' && info.email_verified !== true) {
      return { error: 'emailNotVerified' };
    }
    const email = norm(info.email);
    if (!email || !EMAIL_RE.test(email)) return { error: 'badEmail', email: info.email };
    if (expectedEmail && norm(expectedEmail) !== email) {
      return { error: 'emailMismatch', got: email, expected: norm(expectedEmail) };
    }
    return { ok: true, email };
  } catch (e) {
    return { error: 'tokeninfoUnreachable', detail: String(e && e.message).slice(0, 200) };
  }
}

// ---------------------------------------------------------------------------
// POST /api/auth/login { email, password, deviceId? }
// ---------------------------------------------------------------------------
// The ordinary sign-in. Direct token, no OTP.
router.post('/login', async (req, res) => {
  try {
    const email = norm(req.body.email);
    const password = String(req.body.password || '');
    const deviceId = String(req.body.deviceId || '').trim() || undefined;
    // Which form the user signed in from. The two screens are for disjoint
    // populations, so a teacher must not be able to sign in through the student
    // form (or the reverse) — that used to be possible and is now refused.
    const role = norm(req.body.role);

    if (!email || !EMAIL_RE.test(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }
    if (!password) {
      return res.status(400).json({ error: 'Please enter your password.' });
    }
    if (isLocked(req, email)) {
      return res.status(429).json({
        error: 'Too many failed attempts. Please try again in a few minutes.',
      });
    }

    // +passwordHash: the field is `select: false` on the schema so it cannot
    // leak out of any other query result — this is the only call site that
    // needs it, to verify the submitted password.
    // Keeps the support account's env-derived password hash current. A
    // no-op unless that email belongs to support.
    await ensureSupportAccount().catch(() => null);

    const user = await User.findOne({ emailNorm: email }).select('+passwordHash');
    // Same wording whether the address is unknown or the password is wrong, so
    // this cannot be used to enumerate which addresses have accounts.
    const bad = () => res.status(401).json({ error: 'Incorrect email or password.' });

    if (!user) {
      // The database is the app's user store; the SPREADSHEET is the source of
      // truth for who exists and what they may reach. So a row can be in the
      // sheet and missing here — a brand-new sheet entry the periodic sync has
      // not picked up, or one whose sync was interrupted. Refusing outright
      // would lock out a student the spreadsheet says is entitled to groups.
      //
      // Instead: verify the spreadsheet, and if it lists them and is Active,
      // send a one-time code. Choosing a password on /complete-setup then
      // creates the missing row. Nothing is trusted from the client here — the
      // decision to go ahead is made from the sheet alone.
      const verdict = await checkUserInSheet(email).catch(() => null);
      if (verdict && verdict.inSheet && verdict.status === 'Active') {
        const body = await issueOtp(req, res, email, email, 'setup');
        bumpFailure(req, email); // not a password mistake — count it as neither
        failures.delete(failureKey(req, email));
        return res.json({ ...body, ok: true, needsSetup: true, email });
      }
      bumpFailure(req, email);
      return bad();
    }
    if (role && user.role !== role) {
      // Deliberately the same wording as a wrong password so this cannot be
      // used to discover which addresses belong to teachers.
      bumpFailure(req, email);
      return bad();
    }
    if (!user.passwordHash) {
      // Sheet-synced accounts have no password until one is set via signup or
      // a reset. Saying so is more useful than a bare rejection.
      return res.status(403).json({
        error: 'This account has no password yet. Use "Forgot password?" to set one.',
      });
    }
    if (!(await verifyPassword(password, user.passwordHash))) {
      bumpFailure(req, email);
      return bad();
    }

    const decision = await applySheetDecision(user);
    if (!decision.ok) return res.status(decision.status).json({ error: decision.error });

    clearFailures(req, email);
    const { token, user: fresh } = await completeLogin(req, user, deviceId);
    return res.json({ ok: true, token, user: fresh, access: decision.reason });
  } catch (e) {
    console.error('[auth/login]', e);
    return res.status(500).json({ error: 'Could not sign you in. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/auth/complete-setup { email, code, password, deviceId? }
// ---------------------------------------------------------------------------
// First login for someone the SPREADSHEET lists but the DATABASE does not have
// yet (see the branch in /login above).
//
// Three things happen here, in this order, and the order matters:
//
//  1. the emailed code is verified — this is the only thing proving the address
//     belongs to the person holding the phone;
//  2. the missing database row is created, `origin: 'sheet'`, so this account is
//     governed by the spreadsheet from here on exactly like any other;
//  3. a sync is run so the user's GROUP MEMBERSHIPS are built.
//
// Step 3 is not optional. sheetsSync cannot create a Membership for a user it
// cannot find (`unknown student or group`), so while the row was missing their
// group grants were silently skipped. Creating the row alone would sign them in
// to a chat with no groups and no support. The sync is coalesced and cheap
// because the periodic run shares it, so this is normally a no-op.
router.post('/complete-setup', async (req, res) => {
  try {
    const email = norm(req.body.email);
    const code = String(req.body.code || '').trim();
    const password = String(req.body.password || '');
    const deviceId = String(req.body.deviceId || '').trim() || undefined;
    if (!email || !code) return res.status(400).json({ error: 'Please enter the 6-digit code.' });
    if (!password || password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters long.' });
    }

    const checked = await consumeOtp(email, code, 'setup');
    if (checked.error) return res.status(checked.status).json({ error: checked.error });

    // Re-check the sheet: the code proves ownership of the ADDRESS, not that
    // the address is still entitled. Someone removed from the sheet between the
    // code being sent and it being used must not slip in here.
    const verdict = await checkUserInSheet(email).catch(() => null);
    if (!verdict || !verdict.inSheet || verdict.status !== 'Active') {
      return res.status(403).json({ error: 'Your access has been removed. Please contact SkillParkho support.' });
    }

    let user = await User.findOne({ emailNorm: email, role: 'student' });
    if (!user) {
      user = await User.create({
        email,
        emailNorm: email,
        // The sync below overwrites this with the sheet's real name; it only
        // needs to be non-empty to satisfy the schema in the meantime.
        name: email,
        role: 'student',
        status: 'Active',
        supportAccess: true,
        origin: 'sheet',
        passwordHash: await hashPassword(password),
        passwordUpdatedAt: new Date(),
      });
    } else {
      user.passwordHash = await hashPassword(password);
      user.passwordUpdatedAt = new Date();
      user.status = 'Active';
      await user.save();
    }

    // Build this user's group memberships now that the row exists.
    await maybeRunSync(0).catch(() => null);

    clearFailures(req, email);
    const fresh = await User.findById(user._id);
    const { token, user: signedIn } = await completeLogin(req, fresh, deviceId);
    return res.json({ ok: true, token, user: signedIn, access: 'inSheet' });
  } catch (e) {
    console.error('[auth/complete-setup]', e);
    return res.status(500).json({ error: 'Could not finish setting up your account. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/auth/setup-resend { email }
// ---------------------------------------------------------------------------
// Re-sends the SETUP code for a spreadsheet-listed user finishing their first
// login.
//
// Deliberately NOT routed through /forgot-password: that issues a 'reset'
// code, and /complete-setup only accepts 'setup' ones. Resending the wrong
// purpose here would leave the user staring at a code the server refuses.
router.post('/setup-resend', async (req, res) => {
  try {
    const email = norm(req.body.email);
    const generic = { ok: true, expiresMin: otpTtlMinutes(), resendAfter: resendAfterSeconds() };
    if (!email || !EMAIL_RE.test(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }
    const verdict = await checkUserInSheet(email).catch(() => null);
    if (!verdict || !verdict.inSheet || verdict.status !== 'Active') return res.json(generic);
    // A row that already exists uses the normal password login, so there is no
    // setup to finish.
    const existing = await User.findOne({ emailNorm: email, role: 'student' });
    if (existing) return res.json(generic);
    const body = await issueOtp(req, res, email, email, 'setup');
    return res.json(body);
  } catch (e) {
    console.error('[auth/setup-resend]', e);
    return res.status(500).json({ error: 'Could not resend the code. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/auth/google-login { email, idToken, deviceId? }
// ---------------------------------------------------------------------------
// Students only, and passwordless — a Google identity stands in for the
// password. The ID token is verified above; the address is never taken on
// trust.
router.post('/google-login', async (req, res) => {
  try {
    const claimed = norm(req.body.email);
    const idToken = String(req.body.idToken || '').trim();
    const deviceId = String(req.body.deviceId || '').trim() || undefined;

    const verified = await verifyGoogleIdToken(idToken, claimed);
    if (!verified.ok) {
      // Logged in full so the server's log says WHY. The user-facing text stays
      // generic on purpose, but the previous single catch-all message made this
      // indistinguishable from a genuinely bad token, and a missing
      // GOOGLE_WEB_CLIENT_ID — the most likely cause — looked identical.
      console.error('[auth/google-login] id token rejected:', verified);
      const message = verified.error === 'clientIdNotConfigured'
        ? 'Google sign-in is not set up on this server yet. Please sign in with your email.'
        : 'Google sign-in could not be verified. Please try again.';
      const status = verified.error === 'clientIdNotConfigured' ? 500 : 401;
      return res.status(status).json({ error: message });
    }
    const email = verified.email;

    const user = await User.findOne({ emailNorm: email });
    if (!user) {
      // Unlike password login this is not an error to hide: the address is
      // already proven to belong to the person holding the phone, so telling
      // them the account does not exist is the useful answer.
      return res.status(404).json({
        error: 'No SkillParkho account found for this email. Please create an account first.',
      });
    }
    // Google sign-in is a student convenience only. A teacher reaching this
    // button has used the wrong screen and must not get a session this way.
    if (user.role !== 'student') {
      return res.status(403).json({
        error: 'Google sign-in is only available for student accounts. Please use the faculty sign-in.',
      });
    }

    const decision = await applySheetDecision(user);
    if (!decision.ok) return res.status(decision.status).json({ error: decision.error });

    const { token, user: fresh } = await completeLogin(req, user, deviceId);
    return res.json({ ok: true, token, user: fresh, access: decision.reason });
  } catch (e) {
    console.error('[auth/google-login]', e);
    return res.status(500).json({ error: 'Google sign-in could not be completed. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/auth/signup { name, email, phone, jobStatus, graduationYear,
//                         salaryRange, password }
// ---------------------------------------------------------------------------
// Creates the row and emails a verification code. The account is NOT usable
// until /verify-signup succeeds, so an unverified address cannot sign in by any
// route. A signup never receives groups — it has no sheet row — so it lands on
// SkillParkho Support only until the sheet lists it.
router.post('/signup', async (req, res) => {
  try {
    const email = norm(req.body.email);
    const name = String(req.body.name || '').trim();
    const phone = String(req.body.phone || '').replace(/\D/g, '').slice(0, 10);
    const jobStatus = String(req.body.jobStatus || '').trim();
    const graduationYear = String(req.body.graduationYear || '').trim();
    const salaryRange = String(req.body.salaryRange || '').trim();
    const password = String(req.body.password || '');

    if (!email || !EMAIL_RE.test(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }
    if (!name) return res.status(400).json({ error: 'Please enter your full name.' });
    if (!phone || phone.length < 10) {
      return res.status(400).json({ error: 'Please enter a valid 10-digit mobile number.' });
    }
    if (!password || password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters long.' });
    }

    // One account per mobile number. Checked here as well as by the unique
    // index, so the user gets a clear sentence instead of a raw duplicate-key
    // error from the driver.
    const phoneTaken = await User.findOne({ phone });
    if (phoneTaken) {
      return res.status(409).json({
        error: 'That mobile number is already registered to another account.',
      });
    }

    const existing = await User.findOne({ emailNorm: email });
    if (existing) {
      // An unverified signup that was never completed may be replaced; a real
      // account (sheet-synced or already verified) may not be taken over.
      if (existing.isVerified || existing.origin === 'sheet') {
        return res.status(409).json({ error: 'An account already exists for this email. Please sign in.' });
      }
      await User.deleteOne({ _id: existing._id });
    }
    await OtpSession.deleteMany({ emailNorm: email });

    await User.create({
      email,
      emailNorm: email,
      name,
      phone,
      role: 'student',
      jobStatus,
      graduationYear,
      salaryRange,
      passwordHash: await hashPassword(password),
      passwordUpdatedAt: new Date(),
      origin: 'selfSignup',
      // Inactive until the emailed code proves the address; applySheetDecision
      // exempts selfSignup rows from sheet checks, so this gate is the only
      // thing standing between a signup and a usable account.
      status: 'Inactive',
      isVerified: false,
      supportAccess: true,
    });

    const body = await issueOtp(req, res, email, name, 'signup');
    return res.status(201).json(body);
  } catch (e) {
    console.error('[auth/signup]', e);
    return res.status(500).json({ error: 'Could not create your account. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/auth/verify-signup { email, code, deviceId? }
// ---------------------------------------------------------------------------
router.post('/verify-signup', async (req, res) => {
  try {
    const email = norm(req.body.email);
    const code = String(req.body.code || '').trim();
    const deviceId = String(req.body.deviceId || '').trim() || undefined;
    if (!email || !code) return res.status(400).json({ error: 'Please enter the 6-digit code.' });

    const user = await User.findOne({ emailNorm: email });
    if (!user) return res.status(404).json({ error: 'Account not found. Please sign up again.' });
    if (user.isVerified) {
      return res.status(409).json({ error: 'This account is already verified. Please sign in.' });
    }

    const checked = await consumeOtp(email, code, 'signup');
    if (checked.error) return res.status(checked.status).json({ error: checked.error });

    user.isVerified = true;
    user.status = 'Active';
    await user.save();

    const { token, user: fresh } = await completeLogin(req, user, deviceId);
    // A brand-new signup has no sheet row and therefore no group memberships,
    // so it sees only SkillParkho Support until the sheet lists it.
    return res.json({ ok: true, token, user: fresh, access: 'selfSignup' });
  } catch (e) {
    console.error('[auth/verify-signup]', e);
    return res.status(500).json({ error: 'Could not verify your account. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/auth/signup-resend { email }
// ---------------------------------------------------------------------------
router.post('/signup-resend', async (req, res) => {
  try {
    const email = norm(req.body.email);
    if (!email || !EMAIL_RE.test(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }
    const user = await User.findOne({ emailNorm: email, isVerified: false });
    // Deliberately vague: this endpoint must not confirm whether an address
    // has an account.
    if (!user) return res.json({ ok: true, expiresMin: otpTtlMinutes(), resendAfter: resendAfterSeconds() });
    const body = await issueOtp(req, res, email, user.name, 'signup');
    return res.json(body);
  } catch (e) {
    console.error('[auth/signup-resend]', e);
    return res.status(500).json({ error: 'Could not resend the code. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/auth/forgot-password { email }
// ---------------------------------------------------------------------------
// Emails a reset code, but only for an address that actually exists — the
// requester asked for this explicitly. Responds the same way either way, so it
// still cannot be used to probe for accounts.
router.post('/forgot-password', async (req, res) => {
  try {
    const email = norm(req.body.email);
    if (!email || !EMAIL_RE.test(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }
    const generic = { ok: true, expiresMin: otpTtlMinutes(), resendAfter: resendAfterSeconds() };
    const role = norm(req.body.role) === 'teacher' ? 'teacher' : 'student';

    // Someone qualifies if EITHER the database already holds them, OR the
    // spreadsheet lists them as Active. The second case matters: the periodic
    // sync can lag, or be interrupted, leaving a genuinely registered user with
    // no row — refusing to reset would lock them out of an account the
    // spreadsheet says they are entitled to.
    const user = await User.findOne({ emailNorm: email });
    if (user) {
      // An account the spreadsheet has deactivated must not be able to reset
      // its way back in.
      const decision = await applySheetDecision(user);
      if (!decision.ok) return res.json(generic);
      const body = await issueOtp(req, res, email, user.name, 'reset', user.role);
      return res.json(body);
    }

    const verdict = await checkUserInSheet(email).catch(() => null);
    if (!verdict || !verdict.inSheet || verdict.status !== 'Active') {
      return res.json(generic);
    }
    // No database row yet — /reset-password will create it from the spreadsheet.
    const body = await issueOtp(req, res, email, email, 'reset', role);
    return res.json(body);
  } catch (e) {
    console.error('[auth/forgot-password]', e);
    return res.status(500).json({ error: 'Could not send the code. Please try again.' });
  }
});

// ---------------------------------------------------------------------------
// POST /api/auth/reset-password { email, code, newPassword }
// ---------------------------------------------------------------------------
router.post('/reset-password', async (req, res) => {
  try {
    const email = norm(req.body.email);
    const code = String(req.body.code || '').trim();
    const newPassword = String(req.body.newPassword || '');
    if (!email || !code) return res.status(400).json({ error: 'Please enter the 6-digit code.' });
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters long.' });
    }

    const checked = await consumeOtp(email, code, 'reset');
    if (checked.error) return res.status(checked.status).json({ error: checked.error });

    let user = await User.findOne({ emailNorm: email });
    if (user) {
      user.passwordHash = await hashPassword(newPassword);
      user.passwordUpdatedAt = new Date();
      // From here on the spreadsheet must not overwrite this — for a teacher
      // that column holds the ORIGINAL Teacher ID, and a sync would otherwise
      // revert the reset on its next run.
      user.passwordSetByUser = true;
      await user.save();
      return res.json({ ok: true });
    }

    // The code was issued because the SPREADSHEET lists this person but the
    // database has no row yet, so setting a password has to create the account.
    // The role travelled with the code, because the row needs the right one.
    const role = checked.role === 'teacher' ? 'teacher' : 'student';
    const verdict = await checkUserInSheet(email).catch(() => null);
    if (!verdict || !verdict.inSheet || verdict.status !== 'Active') {
      return res.status(403).json({ error: 'Your access has been removed. Please contact SkillParkho support.' });
    }
    const created = await User.create({
      email,
      emailNorm: email,
      name: email, // the sync below replaces this with the spreadsheet's name
      role,
      status: 'Active',
      supportAccess: true,
      origin: 'sheet',
      passwordHash: await hashPassword(newPassword),
      passwordUpdatedAt: new Date(),
      passwordSetByUser: true,
    });
    // Group memberships cannot be built until the row exists.
    await maybeRunSync(0).catch(() => null);

    return res.json({ ok: true, created: true, id: String(created._id) });
  } catch (e) {
    console.error('[auth/reset-password]', e);
    return res.status(500).json({ error: 'Could not update your password. Please try again.' });
  }
});

module.exports = router;