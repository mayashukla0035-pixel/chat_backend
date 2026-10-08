const mongoose = require('mongoose');

const otpSchema = new mongoose.Schema({
  emailNorm: { type: String, required: true, index: true },
  code: { type: String, required: true },
  // What this code may be used for. 'login' is the legacy emailed sign-in OTP;
  // 'signup' proves a new account's address and, on success, activates the
  // account; 'reset' authorises a password change; 'setup' is the emailed code
  // a spreadsheet-listed user gets on their FIRST login, when the row exists in
  // the sheet but not yet in the database, and choosing a password also creates
  // the database row. Scoping the purpose stops a
  // 'signup' or 'reset' code from being replayed as a sign-in.
  purpose: { type: String, enum: ['login', 'signup', 'reset', 'setup'], default: 'login', index: true },
  // Which population asked for the code. A reset may have to CREATE the account
  // (the address was in the spreadsheet but not yet in the database), and that
  // row needs the right role, so the role travels with the code.
  role: { type: String, enum: ['student', 'teacher'], default: 'student' },
  // A 'signup' code carries the submitted details here instead of the account
  // being written early. The record expires with its TTL index, so an
  // unverified signup leaves nothing behind at all — no half-made account to
  // clean up, and the address is free to try again.
  payload: { type: mongoose.Schema.Types.Mixed, default: null },
  expiresAt: { type: Date, required: true },
  attempts: { type: Number, default: 0 },
}, { timestamps: true });

otpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('OtpSession', otpSchema);
