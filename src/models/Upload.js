const mongoose = require('mongoose');

// Every uploaded file is recorded against its owner. A message may only carry
// an attachment whose URL matches an Upload row OWNED by the sender — so one
// user can never attach (or even reference) another user's file. Together with
// the per-conversation authorization checks this is the second wall of the
// "never mix data between accounts" privacy model:
//   1. canReadConversation / canSendInConversation gate every message/room.
//   2. resolveAttachment gates every attachment to the sender's own uploads.
// Files themselves live in per-user folders on Cloudinary (or per-user
// subfolders of UPLOAD_DIR on the local-disk fallback).
const uploadSchema = new mongoose.Schema({
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  kind: { type: String, required: true },      // image | video | audio | pdf | archive | doc
  mime: { type: String, default: '' },
  name: { type: String, default: '' },
  size: { type: Number, default: 0 },
  url: { type: String, required: true },
  storage: { type: String, enum: ['cloudinary', 'disk', 'drive'], default: 'disk' },
  fileId: { type: String, default: '' },      // Google Drive file id (storage: drive)
  publicId: { type: String, default: '' },     // Cloudinary public id (future delete/rotate)
  resourceType: { type: String, default: 'auto' },
  duration: { type: String, default: '' },     // video/audio duration reported by Cloudinary
  active: { type: Boolean, default: true },
}, { timestamps: true });

// One upload row per owner+url — re-uploading the same bytes still creates a
// new Cloudinary asset, so this unique key is just an integrity guard.
uploadSchema.index({ owner: 1, url: 1 }, { unique: true });
uploadSchema.index({ owner: 1, createdAt: -1 });

module.exports = mongoose.model('Upload', uploadSchema);