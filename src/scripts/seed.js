require('dotenv').config();
const { connectDB } = require('../config/db');
const User = require('../models/User');
const Group = require('../models/Group');
const Membership = require('../models/Membership');

async function main() {
  await connectDB(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/skillparkho_chat');
  // Canonical groups
  for (const g of [
    { groupId: 'GRP001', name: 'SkillParkho Announcements', type: 'ORGANIZATION', status: 'Active' },
    { groupId: 'GRP_SUPPORT', name: 'SkillParkho Support', type: 'SUPPORT', status: 'Active', description: 'Official SkillParkho Support' },
    { groupId: 'GRP002', name: 'Linux Batch 101', type: 'BATCH', status: 'Active', batchCode: 'LNX-101' },
    { groupId: 'GRP003', name: 'Network Batch 102', type: 'BATCH', status: 'Active', batchCode: 'NET-102' },
  ]) {
    await Group.findOneAndUpdate({ groupId: g.groupId }, g, { upsert: true });
  }
  // Demo student + teacher sharing GRP002 (authorized direct-chat relationship)
  await User.findOneAndUpdate({ emailNorm: 'rahul@gmail.com', role: 'student' },
    { email: 'rahul@gmail.com', emailNorm: 'rahul@gmail.com', name: 'Rahul Sharma', phone: '9876543210', role: 'student', teacherChatAccess: true, supportAccess: true, status: 'Active', batch: 'LNX-101', course: 'Linux Administration' }, { upsert: true });
  await User.findOneAndUpdate({ emailNorm: 'ravi@skillparkho.com', role: 'teacher' },
    { email: 'ravi@skillparkho.com', emailNorm: 'ravi@skillparkho.com', name: 'Ravi Kumar', username: 'ravi_linux', usernameNorm: 'ravi_linux', teacherId: 'TCH-1001', subject: 'Linux', role: 'teacher', status: 'Active', orgAnnouncementAccess: true, isVerified: true }, { upsert: true });
  // SkillParkho Support teacher (from .env: SUPPORT_EMAIL + SUPPORT_TEACHER_ID) — no OTP login.
  const { ensureSupportAccount } = require('../services/support');
  await ensureSupportAccount();
  const stu = await User.findOne({ emailNorm: 'rahul@gmail.com' });
  const tea = await User.findOne({ emailNorm: 'ravi@skillparkho.com' });
  const g2 = await Group.findOne({ groupId: 'GRP002' });
  await Membership.findOneAndUpdate({ kind: 'student', emailNorm: stu.emailNorm, groupId: 'GRP002' }, { kind: 'student', emailNorm: stu.emailNorm, user: stu._id, groupId: 'GRP002', group: g2._id, access: true }, { upsert: true });
  await Membership.findOneAndUpdate({ kind: 'teacher', emailNorm: tea.emailNorm, groupId: 'GRP002' }, { kind: 'teacher', emailNorm: tea.emailNorm, user: tea._id, groupId: 'GRP002', group: g2._id, access: true }, { upsert: true });
  console.log('[seed] done. OTP codes print to backend console on request.');
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
