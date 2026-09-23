const Membership = require('../models/Membership');

const norm = (v) => String(v || '').trim().toLowerCase();
const toBool = (v) => {
  if (v === true || v === false) return v;
  const s = String(v || '').trim().toUpperCase();
  return s === 'TRUE' || s === '1' || s === 'YES' || s === 'ACTIVE';
};

async function effectiveAccess(kind, emailNorm, groupId) {
  const m = await Membership.findOne({ kind, emailNorm: norm(emailNorm), groupId: String(groupId).trim() }).lean();
  if (!m) return false;
  return m.access === true;
}

async function studentBatchGroups(emailNorm) {
  const rows = await Membership.find({ kind: 'student', emailNorm: norm(emailNorm), access: true }).lean();
  return rows.map((r) => r.groupId);
}

async function teacherBatchGroups(emailNorm) {
  const rows = await Membership.find({ kind: 'teacher', emailNorm: norm(emailNorm), access: true }).lean();
  return rows.map((r) => r.groupId);
}

// Shared authorized BATCH group => direct-chat relationship exists.
async function sharesBatchGroup(studentEmailNorm, teacherEmailNorm, groupById) {
  const s = await studentBatchGroups(studentEmailNorm);
  const t = await teacherBatchGroups(teacherEmailNorm);
  const setT = new Set(t);
  for (const g of s) {
    if (!setT.has(g)) continue;
    const grp = groupById.get(g);
    if (grp && grp.status === 'Active' && grp.type === 'BATCH') return g;
  }
  return null;
}

module.exports = { norm, toBool, effectiveAccess, studentBatchGroups, teacherBatchGroups, sharesBatchGroup };
