// Google Sheets sync — idempotent, FALSE-wins, last-good-state on failure.
const { google } = require('googleapis');
const User = require('../models/User');
const Group = require('../models/Group');
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
async function checkUserInSheet(email) {
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

module.exports = { runSync, checkUserInSheet };
