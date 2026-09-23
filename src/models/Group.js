const mongoose = require('mongoose');

// Group ID is permanent identity. Renaming Group Name with same Group ID = rename, not new group.
const groupSchema = new mongoose.Schema({
  groupId: { type: String, required: true, unique: true, index: true }, // e.g. GRP001, GRP_SUPPORT
  name: { type: String, required: true },
  type: { type: String, enum: ['ORGANIZATION', 'BATCH', 'SUPPORT'], required: true, index: true },
  status: { type: String, enum: ['Active', 'Inactive'], default: 'Active', index: true },
  description: { type: String, default: '' },
  batchCode: { type: String, default: '' },
  avatarUrl: { type: String, default: '' },
  memberCount: { type: Number, default: 0 },
}, { timestamps: true });

module.exports = mongoose.model('Group', groupSchema);
