// Cloudinary upload helper. Active ONLY when the three env vars are present;
// without them uploads fall back to the local disk (see routes/uploads.js).
const cloudinary = require('cloudinary').v2;

function configured() {
  return !!(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET);
}

function applyConfig() {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
  });
}

// Cloudinary resource type per MIME so videos stream as video and documents
// land in raw storage. Cloudinary treats audio as the "video" resource type.
// Falls back to the file extension when the MIME is generic.
function resourceTypeFor(mime = '', originalname = '') {
  const m = String(mime || '').toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'video';
  const n = String(originalname || '').toLowerCase();
  if (/\.(jpe?g|png|gif|webp|bmp|heic|heif)$/.test(n)) return 'image';
  if (/\.(mp4|mov|m4v|webm|3gp|mkv)$/.test(n)) return 'video';
  if (/\.(m4a|mp3|wav|aac|ogg|opus)$/.test(n)) return 'video';
  return 'auto';
}

// Upload an in-memory file buffer. Returns
//   { url, publicId, resourceType, duration }
// (duration is only present for videos/audio handled by Cloudinary), or null
// when Cloudinary isn't configured (caller then saves to ./uploads as before).
function uploadBuffer(buffer, { folder = 'skillparkho', resourceType = 'auto' } = {}) {
  if (!configured()) return Promise.resolve(null);
  applyConfig();
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, resource_type: resourceType, unique_filename: true, overwrite: false },
      (err, result) => {
        if (err) return reject(err);
        resolve({
          url: result.secure_url,
          publicId: result.public_id,
          resourceType: result.resource_type || resourceType,
          duration: result.duration ? String(result.duration) : '',
        });
      }
    );
    stream.end(buffer);
  });
}

module.exports = { configured, uploadBuffer, resourceTypeFor };