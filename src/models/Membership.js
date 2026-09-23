const mongoose = require('mongoose');

// One doc per (emailNorm + groupId + kind). FALSE wins at read time if duplicates were ever ingested,
// but sync consolidates to a single effective doc (FALSE priority) to stay idempotent.
const membershipSchema = new mongoose.Schema({
  kind: { type: String, enum: ['student', 'teacher'], required: true, index: true },
  emailNorm: { type: String, required: true, index: true },
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  groupId: { type: String, required: true, index: true },
  group: { type: mongoose.Schema.Types.ObjectId, ref: 'Group' },
  access: { type: Boolean, required: true, default: true },
}, { timestamps: true });

membershipSchema.index({ kind: 1, emailNorm: 1, groupId: 1 }, { unique: true });

module.exports = mongoose.model('Membership', membershipSchema);
