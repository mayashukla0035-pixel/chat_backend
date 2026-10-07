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

  // ---------- password login ----------
  // scrypt hash (see services/password.js). EMPTY means "no password set",
  // which is the normal state for every account that came from the Google
  // Sheet: those authenticate by emailed OTP or by Google, not by password.
  // Only self-signups and password resets populate this.
  // `select: false` keeps the hash out of every query result by default,
  // INCLUDING .lean() — which a schema `toJSON` transform would NOT cover.
  // Without this, /login, /me, /refresh and verify-otp all serialised the hash
  // straight back to the app. The one place that genuinely needs it (password
  // verification) asks for it explicitly with .select('+passwordHash').
  passwordHash: { type: String, default: '', select: false },
  passwordUpdatedAt: { type: Date, select: false },
  // True once the holder has chosen their own password (signup, first-login
  // setup, or a forgot-password reset). The sheet keeps the initial password for
  // teachers, but it must NOT overwrite a password the teacher has since
  // changed — otherwise the next periodic sync would silently revert them to the
  // Teacher ID value and the reset would appear not to have worked.
  passwordSetByUser: { type: Boolean, default: false },

  // ---------- self-signup profile ----------
  // The fields the app's "Create account" form collects, mirroring the React
  // signup form. Only meaningful for `origin: 'selfSignup'` rows.
  jobStatus: { type: String, default: '' },
  graduationYear: { type: String, default: '' },
  salaryRange: { type: String, default: '' },

  // Where this row came from. 'sheet' rows are managed by the spreadsheet sync
  // and can be deactivated or removed from there. 'selfSignup' rows exist only
  // in the database — which is why such a user may still sign in, but is
  // granted nothing but the SkillParkho Support group until the sheet lists
  // them.
  origin: { type: String, enum: ['sheet', 'selfSignup'], default: 'sheet', index: true },
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
// One account per mobile number. Partial, because `phone` defaults to '' and a
// plain unique index would collide on every row that has no number at all.
userSchema.index(
  { phone: 1 },
  { unique: true, partialFilterExpression: { phone: { $type: 'string', $gt: '' } } },
);

// Belt-and-braces with `select: false`: that setting hides the hash from query
// results, but a document that was fetched with an explicit
// .select('+passwordHash') still holds it in memory, and any future route that
// returns such a document would serialise it. This makes that impossible.
userSchema.set('toJSON', {
  virtuals: true,
  transform(_doc, ret) {
    delete ret.passwordHash;
    delete ret.passwordUpdatedAt;
    delete ret.__v;
    return ret;
  },
});

userSchema.pre('validate', function (next) {
  this.emailNorm = normEmail(this.email);
  if (this.username) this.usernameNorm = String(this.username).trim().toLowerCase();
  next();
});

module.exports = mongoose.model('User', userSchema);
