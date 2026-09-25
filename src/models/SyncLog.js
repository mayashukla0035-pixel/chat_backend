const mongoose = require('mongoose');

const syncLogSchema = new mongoose.Schema({
  startedAt: Date,
  completedAt: Date,
  ok: Boolean,
  studentsProcessed: { type: Number, default: 0 },
  teachersProcessed: { type: Number, default: 0 },
  groupsProcessed: { type: Number, default: 0 },
  studentRelsProcessed: { type: Number, default: 0 },
  teacherRelsProcessed: { type: Number, default: 0 },
  syncErrors: [String],
  warnings: [String],
}, { timestamps: true });

// /api/sync/status sorts on createdAt — indexed so it never scans.
syncLogSchema.index({ createdAt: -1 });

module.exports = mongoose.model('SyncLog', syncLogSchema);
