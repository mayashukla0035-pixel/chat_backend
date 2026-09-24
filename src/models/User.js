const mongoose = require('mongoose');

function normEmail(v) {
  return String(v || '').trim().toLowerCase();
}

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, index: true },
  emailNorm: { type: String, required: true, index: true },
  name: { type: String, required: true },
  phone: { type: String, default: '' },
  role: { type: String, enum: ['student', 'teacher', 'supportAdmin'], required: true, index: true },
  // teacher-only
  username: { type: String, index: true, sparse: true },
  usernameNorm: { type: String }, // indexed via schema.index below (unique, sparse)
  teacherId: { type: String },
  subject: { type: String, default: '' },
  orgAnnouncementAccess: { type: Boolean, default: false },
  // student-only
  teacherChatAccess: { type: Boolean, default: true },
  supportAccess: { type: Boolean, default: true },
  batch: { type: String, default: '' },
  course: { type: String, default: '' },
  avatarUrl: { type: String, default: '' },
  status: { type: String, enum: ['Active', 'Inactive'], default: 'Active', index: true },
  isVerified: { type: Boolean, default: false },
  notificationsEnabled: { type: Boolean, default: true },
  // Single-device login enforcement
  currentDeviceId: { type: String, default: '' },
  lastLoginAt: { type: Date },
  // FCM registration tokens for closed-app push delivery — scoped per
  // device; pushes only ever use the token of currentDeviceId (capped).
  fcmTokens: [{
    token: { type: String },
    deviceId: { type: String, default: '' },
    updatedAt: { type: Date },
  }],
}, { timestamps: true });

userSchema.index({ emailNorm: 1, role: 1 }, { unique: true });
userSchema.index({ usernameNorm: 1 }, { unique: true, sparse: true });

userSchema.pre('validate', function (next) {
  this.emailNorm = normEmail(this.email);
  if (this.username) this.usernameNorm = String(this.username).trim().toLowerCase();
  next();
});

module.exports = mongoose.model('User', userSchema);
