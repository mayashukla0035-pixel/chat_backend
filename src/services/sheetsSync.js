// Google Sheets sync — idempotent, FALSE-wins, last-good-state on failure.
const { google } = require('googleapis');
const User = require('../models/User');
const Group = require('../models/Group');
const { hashPassword } = require('./password');
const Membership = require('../models/Membership');
const SyncLog = require('../models/SyncLog');
const { norm, toBool } = require('./access');

function sheetsClient() {
  const key = process.env.GOOGLE_API_KEY;
  if (key) return google.sheets({ version: 'v4', auth: key });
  let auth;
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
    auth = new google.auth.GoogleAuth({ credentials: creds, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
  } else if (process.env.GOOGLE_SERVICE_ACCOUNT_FILE) {
    auth = new google.auth.GoogleAuth({ keyFile: process.env.GOOGLE_SERVICE_ACCOUNT_FILE, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
  } else {
    throw new Error('No Google credentials configured (GOOGLE_API_KEY or service account)');
  }
  return google.sheets({ version: 'v4', auth });
}

async function readTab(sheets, spreadsheetId, tab) {
  const r = await sheets.spreadsheets.values.get({ spreadsheetId, range: tab });
  return r.data.values || [];
}

function rowsToObjects(values) {
  if (!values.length) return [];
  const header = values[0].map((h) => String(h || '').trim());
  return values.slice(1).filter((r) => r.some((c) => String(c || '').trim() !== '')).map((r) => {
    const o = {};
    header.forEach((h, i) => { o[h] = (r[i] || '').toString().trim(); });
    return o;
  });
}

const normStatus = (v) => {
  const s = String(v || '').trim().toLowerCase();
  return s === 'inactive' ? 'Inactive' : 'Active';
};

const isEmail = (v) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(v || '').trim());

// Per-row safe upsert: a single bad row warns and continues instead of
// failing the whole sync.
async function safeRow(log, label, fn) {
  try {
    await fn();
    return true;
  } catch (e) {
    log.warnings.push(`${label}: ${e.message}`);
    return false;
  }
}

async function runSync() {
  const log = await SyncLog.create({ startedAt: new Date(), ok: false, syncErrors: [], warnings: [] });
  try {
    const spreadsheetId = process.env.GOOGLE_SHEET_ID;
    if (!spreadsheetId) throw new Error('GOOGLE_SHEET_ID not set');
    const sheets = sheetsClient();

    const [sVals, tVals, gVals, sgVals, tgVals] = await Promise.all([
      readTab(sheets, spreadsheetId, 'Students'),
      readTab(sheets, spreadsheetId, 'Teachers'),
      readTab(sheets, spreadsheetId, 'Groups'),
      readTab(sheets, spreadsheetId, 'Student_Group_Access'),
      readTab(sheets, spreadsheetId, 'Teacher_Group_Access'),
    ]);

    const students = rowsToObjects(sVals);
    const teachers = rowsToObjects(tVals);
    const groups = rowsToObjects(gVals);
    const sRels = rowsToObjects(sgVals);
    const tRels = rowsToObjects(tgVals);

    // --- Groups first (Group ID permanent; rename = update name) ---
    let groupsProcessed = 0;
    for (const g of groups) {
      const groupId = String(g['Group ID'] || g['GroupID'] || '').trim();
      if (!groupId) { log.warnings.push('Group row missing Group ID'); continue; }
      const type = String(g['Group Type'] || '').trim().toUpperCase();
      if (!['ORGANIZATION', 'BATCH', 'SUPPORT'].includes(type)) { log.warnings.push(`Group ${groupId} bad type ${type}`); continue; }
      const okRow = await safeRow(log, `Group ${groupId}`, () => Group.findOneAndUpdate(
        { groupId },
        {
          groupId,
          name: g['Group Name'] || groupId,
          type,
          status: normStatus(g['Status']),
          description: g['Description'] || '',
          batchCode: g['Batch Code'] || groupId,
        },
        { upsert: true, new: true }
      ));
      if (okRow) groupsProcessed++;
    }
    // Ensure canonical groups exist even before sheet is filled
    await Group.findOneAndUpdate({ groupId: 'GRP_SUPPORT' }, { groupId: 'GRP_SUPPORT', name: 'SkillParkho Support', type: 'SUPPORT', status: 'Active', description: 'Official SkillParkho Support' }, { upsert: true });

    // --- Students ---
    let studentsProcessed = 0;
    for (const s of students) {
      const email = norm(s['Student Email'] || s['Email']);
      if (!email) { log.warnings.push('Student row missing email'); continue; }
      if (!isEmail(email)) { log.warnings.push(`Student row skipped (bad email): ${email}`); continue; }
      const username = String(s['Username'] || '').trim();
      const okRow = await safeRow(log, `Student ${email}`, () => User.findOneAndUpdate(
        { emailNorm: email, role: 'student' },
        {
          email: email, emailNorm: email,
          name: s['Student Name'] || s['Name'] || email,
          username: username || undefined,
          usernameNorm: username ? username.toLowerCase() : undefined,
          phone: s['Phone'] || '',
          role: 'student',
          teacherChatAccess: toBool(s['Teacher Chat Access'] ?? s['Teacher ChatAccess'] ?? 'TRUE'),
          supportAccess: true,
          status: normStatus(s['Status']),
          // A row in the sheet is authoritative: if this address previously
          // self-signed-up, the sheet now adopts it, so its status and group
          // access are governed from here on.
          origin: 'sheet',
        },
        { upsert: true, new: true }
      ));
      if (okRow) studentsProcessed++;
    }

    // --- Teachers (Username unique, student-facing) ---
    let teachersProcessed = 0;
    for (const t of teachers) {
      const email = norm(t['Teacher Email'] || t['Email']);
      if (!email) { log.warnings.push('Teacher row missing email'); continue; }
      if (!isEmail(email)) { log.warnings.push(`Teacher row skipped (bad email): ${email}`); continue; }
      const username = String(t['Username'] || '').trim();

      // PASSWORD SOURCE, by decision: a dedicated `Password` column if one is
      // ever added, otherwise the `Teacher ID` cell itself. The spreadsheet
      // holds the teacher ID column repurposed as the password — it is hashed
      // HERE, on the way in, and only the hash is stored or logged. The
      // plaintext is read, hashed and dropped.
      //
      // `teacherId` is still written to its own field, so the identifier keeps
      // working (teacher credential checks, the teachers search endpoint, the
      // support login) while the same value doubles as the password.
      //
      // Empty => the teacher's password is LEFT ALONE rather than cleared, so
      // adding this on a live sheet does not wipe passwords that a self-signup
      // or a Forgot-password reset already set. To REVOKE a teacher set Status
      // to Inactive: that is the path applySheetDecision honours.
      const teacherIdCell = String(t['Teacher ID'] || '').trim();
      // Only ever write the sheet's password when the holder has not chosen
      // one. Once they have — via Forgot password, or their first-login setup —
      // their choice wins from then on, and every later sync leaves it alone.
      const existingTeacher = await User.findOne({ emailNorm: email, role: 'teacher' })
        .select('+passwordSetByUser')
        .lean();
      const sheetPassword = existingTeacher && existingTeacher.passwordSetByUser
        ? ''
        : String(
            t['Password'] || t['Password Hash'] || t['PasswordHash'] || teacherIdCell || ''
          ).trim();
      const passwordUpdate = sheetPassword
        ? { passwordHash: await hashPassword(sheetPassword), passwordUpdatedAt: new Date() }
        : {};

      const okRow = await safeRow(log, `Teacher ${email}`, () => User.findOneAndUpdate(
        { emailNorm: email, role: 'teacher' },
        {
          email, emailNorm: email,
          name: t['Teacher Name'] || t['Name'] || email,
          username: username || undefined,
          usernameNorm: username ? username.toLowerCase() : undefined,
          teacherId: String(t['Teacher ID'] || '').trim() || undefined,
          phone: t['Phone'] || '',
          subject: t['Subject'] || '',
          role: 'teacher',
          status: normStatus(t['Status']),
          orgAnnouncementAccess: toBool(t['Organization Announcement Access'] ?? 'FALSE'),
          // See the student upsert: a sheet row adopts any existing account.
          origin: 'sheet',
          ...passwordUpdate,
        },
        { upsert: true, new: true }
      ));
      if (okRow) teachersProcessed++;
    }

    // --- Memberships: consolidate duplicates, FALSE wins ---
    const consolidate = (rows, emailKey) => {
      const map = new Map(); // `${email}|${groupId}` -> bool (false wins)
      for (const r of rows) {
        const email = norm(r[emailKey] || r['Email']);
        const gid = String(r['Group ID'] || r['GroupID'] || '').trim();
        if (!email || !gid) continue;
        const key = `${email}|${gid}`;
        const b = toBool(r['Access']);
        if (!map.has(key)) map.set(key, b);
        else if (b === false) map.set(key, false);
      }
      return map;
    };

    const sMap = consolidate(sRels, 'Student Email');
    const tMap = consolidate(tRels, 'Teacher Email');

    for (const [key, access] of sMap) {
      const [emailNorm, groupId] = key.split('|');
      const okRow = await safeRow(log, `Student access ${emailNorm}/${groupId}`, async () => {
        const user = await User.findOne({ emailNorm, role: 'student' });
        const group = await Group.findOne({ groupId });
        if (!user || !group) throw new Error('unknown student or group');
        await Membership.findOneAndUpdate(
          { kind: 'student', emailNorm, groupId },
          { kind: 'student', emailNorm, user: user._id, groupId, group: group._id, access },
          { upsert: true, new: true }
        );
      });
      void okRow;
    }
    for (const [key, access] of tMap) {
      const [emailNorm, groupId] = key.split('|');
      const okRow = await safeRow(log, `Teacher access ${emailNorm}/${groupId}`, async () => {
        const user = await User.findOne({ emailNorm, role: 'teacher' });
        const group = await Group.findOne({ groupId });
        if (!user || !group) throw new Error('unknown teacher or group');
        await Membership.findOneAndUpdate(
          { kind: 'teacher', emailNorm, groupId },
          { kind: 'teacher', emailNorm, user: user._id, groupId, group: group._id, access },
          { upsert: true, new: true }
        );
      });
      void okRow;
    }

    log.studentsProcessed = studentsProcessed;
    log.teachersProcessed = teachersProcessed;
    log.groupsProcessed = groupsProcessed;
    log.studentRelsProcessed = sMap.size;
    log.teacherRelsProcessed = tMap.size;
    log.completedAt = new Date();
    log.ok = true;
    await log.save();
    return log;
  } catch (e) {
    // Sync failure: retain last successfully synchronized state (do nothing destructive).
    log.syncErrors.push(String(e && e.message || e));
    log.completedAt = new Date();
    log.ok = false;
    await log.save();
    throw e;
  }
}

// Live check for ONE account (used on every app open): is this email still a
// row of the Students/Teachers tabs, and with what status? Returns null when
// the sheet is unreachable or not configured, so callers fall back to the
// last synchronized DB state — a network hiccup must never log anyone out.
async function checkUserInSheetLive(email) {
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  const target = norm(email);
  if (!spreadsheetId || !target) return null;
  try {
    const sheets = sheetsClient();
    const [sVals, tVals] = await Promise.all([
      readTab(sheets, spreadsheetId, 'Students'),
      readTab(sheets, spreadsheetId, 'Teachers'),
    ]);
    for (const [vals, emailKey] of [[sVals, 'Student Email'], [tVals, 'Teacher Email']]) {
      for (const r of rowsToObjects(vals)) {
        if (norm(r[emailKey] || r['Email']) === target) {
          return { inSheet: true, status: normStatus(r['Status']) };
        }
      }
    }
    return { inSheet: false, status: null };
  } catch (_) {
    return null;
  }
}

// Per-account TTL cache: validate-session runs on EVERY app open and a live
// check downloads both sheet tabs (Students + Teachers). Caching the result
// for SHEET_CHECK_TTL_SECONDS keeps that path cheap under load while a block
// or removal still takes effect within the TTL (default 2 minutes). A live
// failure falls back to the last cached answer, never to a logout.
const _sheetCheckCache = new Map();
const SHEET_CHECK_TTL_MS = Number(process.env.SHEET_CHECK_TTL_SECONDS || 120) * 1000;

async function checkUserInSheet(email) {
  const key = norm(email);
  if (!key) return null;
  const hit = _sheetCheckCache.get(key);
  if (hit && Date.now() - hit.at < SHEET_CHECK_TTL_MS) return hit.val;
  try {
    const val = await checkUserInSheetLive(key);
    if (val !== null) _sheetCheckCache.set(key, { at: Date.now(), val });
    return val;
  } catch (_) {
    return hit ? hit.val : null;
  }
}

// Throttled, single-flight sync trigger for request-path callers (login,
// unknown-email catch-up, periodic job). Never blocks the caller when used
// fire-and-forget, never runs two syncs at once, and coalesces concurrent
// triggers into the in-flight run.
let _syncInFlight = null;
let _lastSyncAt = 0;

async function maybeRunSync(minAgeMs = 4 * 60000) {
  if (_syncInFlight) return _syncInFlight;
  if (Date.now() - _lastSyncAt < minAgeMs) return null;
  _syncInFlight = runSync()
    .then((log) => { _lastSyncAt = Date.now(); return log; })
    .catch((e) => {
      console.log('[sync] background sync failed, keeping last good state:', e.message);
      _lastSyncAt = Date.now();
      return null;
    })
    .finally(() => { _syncInFlight = null; });
  return _syncInFlight;
}

module.exports = { runSync, maybeRunSync, checkUserInSheet };
