const mongoose = require('mongoose');

// Student-controlled visibility: a student can hide their direct chat so the
// teacher can no longer see it. Toggled only by the student participant.
const directVisibilitySchema = new mongoose.Schema({
  directKey: { type: String, required: true, unique: true, index: true },
  student: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  teacher: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  hiddenFromTeacher: { type: Boolean, default: false },
}, { timestamps: true });

module.exports = mongoose.model('DirectVisibility', directVisibilitySchema);
