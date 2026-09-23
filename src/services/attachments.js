const Upload = require('../models/Upload');

// Attachment gate (privacy wall #2). Clients never get to fabricate an
// attachment: the ONLY accepted URLs are ones this user uploaded through
// POST /api/uploads, looked up from the Upload collection. This means:
//   - a user cannot attach a file another user uploaded,
//   - a user cannot point an attachment at some arbitrary external URL.
// The stored fields (name/size/mime/kind/url) always come from the Upload row,
// never from the client's JSON — only a short video `duration` hint is taken
// from the client (capped), otherwise the Cloudinary-reported duration is kept.
//
// Returns { attachment, error }. When `raw` is null/undefined the result is
// { attachment: null } (plain text message).
async function resolveAttachment(me, raw) {
  if (raw == null) return { attachment: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { error: 'Invalid attachment.' };
  const url = String(raw.url || '').trim();
  if (!url) return { error: 'Attachment URL is required.' };
  if (!/^https?:\/\//.test(url)) return { error: 'Invalid attachment URL.' };

  const up = await Upload.findOne({ owner: me._id, url, active: true }).lean();
  if (!up) {
    return { error: 'Attachment not found for your account. Please upload the file again.' };
  }

  const duration =
    typeof raw.duration === 'string' && raw.duration.trim()
      ? raw.duration.trim().slice(0, 20)
      : up.duration || '';

  return {
    attachment: {
      name: up.name || 'file',
      size: up.size,
      mime: up.mime || '',
      url: up.url,
      kind: up.kind,
      duration,
    },
  };
}

module.exports = { resolveAttachment };