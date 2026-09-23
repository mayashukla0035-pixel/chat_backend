const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { authRequired } = require('../middleware/auth');
const User = require('../models/User');
const Group = require('../models/Group');
const Membership = require('../models/Membership');
const Upload = require('../models/Upload');
const { configured: cloudinaryConfigured, uploadBuffer: cloudinaryUploadBuffer, resourceTypeFor } = require('../services/cloudinary');
const {
  configured: driveConfigured,
  makePublic: driveMakePublic,
  uploadBuffer: driveUploadBuffer,
  setPublic: driveSetPublic,
  publicUrl: drivePublicUrl,
} = require('../services/google_drive');
const { isSupportAccount } = require('../services/support');

const router = express.Router();
router.use(authRequired);

// Attachment kinds handled by Google Drive instead of Cloudinary.
const DRIVE_KINDS = new Set(['audio', 'pdf', 'doc', 'archive']);

// Files are buffered in memory first, then stored on Cloudinary when the
// CLOUDINARY_* env vars are configured. Every upload is RECORDED against the
// caller (models/Upload) so messages can only ever attach files the sender
// uploaded themselves. On Cloudinary each user gets their own folder
// (`skillparkho/<type>/<ownerId>/...`); the local-disk fallback mirrors the
// same per-user subfolder under UPLOAD_DIR.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: Number(process.env.MAX_UPLOAD_MB || 100) * 1024 * 1024 },
});

function kindFor(mime, originalname = '') {
  const m = String(mime || '').toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  if (m === 'application/pdf') return 'pdf';
  if (/zip|gzip|rar|tar|7z|x-compress/.test(m)) return 'archive';
  // MIME is often application/octet-stream (clients that don't send a real
  // content type). Fall back to the file extension so images/videos/audio
  // still keep their real kind — otherwise every upload becomes a generic doc.
  const n = String(originalname || '').toLowerCase();
  if (/\.(jpe?g|png|gif|webp|bmp|heic|heif)$/.test(n)) return 'image';
  if (/\.(mp4|mov|m4v|webm|3gp|mkv)$/.test(n)) return 'video';
  if (/\.(m4a|mp3|wav|aac|ogg|opus)$/.test(n)) return 'audio';
  if (n.endsWith('.pdf')) return 'pdf';
  if (/\.(zip|rar|tar|gz|7z|xz)$/.test(n)) return 'archive';
  return 'doc';
}

function publicUrl(baseUrl, ownerTag, filename) {
  const base = process.env.PUBLIC_BASE_URL || baseUrl;
  return `${String(base).replace(/\/+$/, '')}/uploads/${ownerTag}/${filename}`;
}

function diskBytes(buffer, originalname, ownerTag) {
  // Local-disk fallback: land in UPLOAD_DIR/<ownerTag>/ and serve from the
  // existing static `/uploads` route. Per-user subfolder = media isolation
  // holds even without Cloudinary.
  const ext = path.extname(originalname || '.bin').slice(0, 12).toLowerCase();
  const filename = `${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`;
  const dir = path.join(process.env.UPLOAD_DIR || './uploads', ownerTag);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, filename), buffer);
  return filename;
}

// Storage decision + orchestration over a full in-memory buffer (a single-shot
// multipart request, or the assembled result of a chunked upload).
// Per-user isolation always holds: Cloudinary gets `skillparkho/<type>/<owner>`,
// Drive gets a per-owner subfolder, disk gets UPLOAD_DIR/<owner>/.
async function storeFileData(buffer, { name = 'file', mime = '', folder = 'chat', ownerTag = '', baseUrl = '' }) {
  const kind = kindFor(mime, name);
  const resourceType = resourceTypeFor(mime, name);
  const size = buffer.length;
  if (folder === 'chat' && driveConfigured() && DRIVE_KINDS.has(kind)) {
    try {
      const r = await driveUploadBuffer(buffer, {
        name,
        mime: mime || 'application/octet-stream',
        owner: ownerTag,
      });
      if (r && r.fileId) {
        if (driveMakePublic()) {
          await driveSetPublic(r.fileId);
        }
        const url = driveMakePublic()
          ? drivePublicUrl(r.fileId)
          : `${String(baseUrl).replace(/\/+$/, '')}/api/drive/files/${encodeURIComponent(r.fileId)}`;
        return { url, fileId: r.fileId, kind, mime, name, size, storage: 'drive' };
      }
    } catch (e) {
      console.error('[uploads] google drive failed, falling back:', e.message);
    }
  }
  if (cloudinaryConfigured()) {
    try {
      const r = await cloudinaryUploadBuffer(buffer, {
        folder: `skillparkho/${folder}/${ownerTag}`,
        resourceType,
      });
      if (r) {
        return {
          url: r.url, publicId: r.publicId, resourceType: r.resourceType, duration: r.duration,
          kind, mime, name, size, storage: 'cloudinary',
        };
      }
    } catch (e) {
      console.error('[uploads] cloudinary failed, falling back to disk:', e.message);
    }
  }
  const filename = diskBytes(buffer, name, ownerTag);
  return {
    url: publicUrl(baseUrl, ownerTag, filename), publicId: '', resourceType: 'raw', duration: '',
    kind, mime, name, size, storage: 'disk',
  };
}

// Thin wrapper used by the avatar/group-avatar routes.
async function storeFile(req, folder, ownerTag) {
  return storeFileData(req.file.buffer, {
    name: req.file.originalname || 'file',
    mime: req.file.mimetype || '',
    folder,
    ownerTag,
    baseUrl: `${req.protocol}://${req.get('host')}`,
  });
}

async function recordUpload(me, st) {
  const doc = await Upload.create({
    owner: me._id,
    kind: st.kind, mime: st.mime, name: st.name,
    size: st.size, url: st.url,
    storage: st.storage, publicId: st.publicId,
    resourceType: st.resourceType, duration: st.duration,
    fileId: st.fileId || '',
  }).catch((e) => {
    // @unique(owner+url): a concurrent duplicate upload of the same bytes is
    // fine — return the existing row instead of failing the request.
    if (e && e.code === 11000) return Upload.findOne({ owner: me._id, url: st.url }).lean();
    throw e;
  });
  return {
    id: String(doc._id),
    url: doc.url, name: doc.name, size: doc.size,
    kind: doc.kind, mime: doc.mime, duration: doc.duration,
  };
}

// POST /api/uploads — chat attachment (image, video, audio, file).
router.post('/', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file received' });
    const stored = await storeFile(req, 'chat', String(req.user._id));
    const out = await recordUpload(req.user, stored);
    return res.json(out);
  } catch (e) {
    console.error('[uploads] failed:', e.message);
    return res.status(500).json({ error: 'Upload failed' });
  }
});

// POST /api/uploads/avatar — profile photo. The new URL is stored on the
// account so every future message carries it automatically. Lives in the
// user's own avatar folder.
router.post('/avatar', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file received' });
    const stored = await storeFile(req, 'avatars', String(req.user._id));
    const user = await User.findByIdAndUpdate(req.user._id, { avatarUrl: stored.url }, { new: true }).select('avatarUrl').lean();
    return res.json({ avatarUrl: (user && user.avatarUrl) || stored.url });
  } catch (e) {
    console.error('[uploads] avatar failed:', e.message);
    return res.status(500).json({ error: 'Failed to save avatar' });
  }
});

// POST /api/uploads/group-avatar?conversation=group:GRP002 — group profile
// image. Only a teacher authorized for that group (membership access, or the
// support teacher via GRP_SUPPORT) may set it. URL stored on the Group row.
router.post('/group-avatar', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file received' });
    const raw = String(req.query.conversation || req.query.groupId || '');
    const groupId = (String(raw).startsWith('group:') ? String(raw).slice(6) : String(raw)).trim();
    if (!groupId) return res.status(400).json({ error: 'Group conversation required.' });
    const g = await Group.findOne({ groupId }).lean();
    if (!g || g.status !== 'Active') return res.status(404).json({ error: 'Group not available.' });
    // Authorize: teacher with membership access, the support teacher (active in
    // GRP_SUPPORT), or supportAdmin.
    const me = req.user;
    const authorized = me.role === 'supportAdmin'
      || isSupportAccount(me)
      || (me.role === 'teacher' && !!(await Membership.findOne({ kind: 'teacher', emailNorm: me.emailNorm, groupId, access: true }).lean()));
    if (!authorized) return res.status(403).json({ error: 'You are not authorized to set this group image.' });
    const stored = await storeFile(req, 'groups', groupId);
    await Group.updateOne({ groupId }, { avatarUrl: stored.url });
    return res.json({ avatarUrl: stored.url });
  } catch (e) {
    console.error('[uploads] group-avatar failed:', e.message);
    return res.status(500).json({ error: 'Failed to update group image' });
  }
});

// ---------- chunked upload (chat attachments) ----------
// The app uploads large files (video / audio / documents) as a sequence of
// small chunks instead of one giant request. Each chunk is a tiny multer
// memory buffer, so many users can upload big files at the same time without
// a single request tying up the event loop or ballooning RAM. Chunks land on
// disk (UPLOAD_DIR/.chunks/<uploadId>/<n>), get assembled in order at the end,
// then flow through the same storeFileData() path (Drive/Cloudinary/disk).
//
// Read side stays streaming/chunk-friendly too: express.static already serves
// /uploads with HTTP Range support, Cloudinary streams, and the Drive proxy
// passes Range headers through — so playback/download of media only transfers
// the bytes that are actually needed instead of whole files.
const CHUNK_HINT_BYTES = 4 * 1024 * 1024; // what the app uses per chunk
const MAX_CHUNK_BYTES = 8 * 1024 * 1024;  // server guards slightly larger
const CHUNK_MAX_TOTAL = Number(process.env.MAX_UPLOAD_MB || 100) * 1024 * 1024;
const chunkUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_CHUNK_BYTES } });

// uploadId -> { name, mime, size, owner, createdAt }
const _chunks = new Map();

function chunkDir(uploadId) {
  return path.join(process.env.UPLOAD_DIR || './uploads', '.chunks', uploadId);
}

function purgeStaleChunks() {
  const root = path.join(process.env.UPLOAD_DIR || './uploads', '.chunks');
  let entries = [];
  try {
    entries = fs.readdirSync(root).map((n) => ({ n, d: path.join(root, n) }));
  } catch (_) {
    return;
  }
  const now = Date.now();
  for (const { d } of entries) {
    try {
      const st = fs.statSync(d);
      if (now - st.mtimeMs > 60 * 60 * 1000) fs.rmSync(d, { recursive: true, force: true });
    } catch (_) {}
  }
}
if (!process.env.CHUNK_SWEEP_DISABLED) {
  setInterval(purgeStaleChunks, 10 * 60 * 1000).unref();
}

function cleanupChunk(uploadId) {
  _chunks.delete(uploadId);
  try {
    fs.rmSync(chunkDir(uploadId), { recursive: true, force: true });
  } catch (_) {}
}

// POST /api/uploads/chunk-init — start a chunked upload. Body: { name, mime, size }.
router.post('/chunk-init', async (req, res) => {
  try {
    const name = String(req.body.name || '').slice(0, 256) || 'file';
    const mime = String(req.body.mime || '').toLowerCase().slice(0, 128);
    const size = Number(req.body.size || 0);
    if (!Number.isFinite(size) || size <= 0) return res.status(400).json({ error: 'Invalid file size.' });
    if (size > CHUNK_MAX_TOTAL) {
      return res.status(413).json({ error: `File exceeds the ${process.env.MAX_UPLOAD_MB || 100}MB limit.` });
    }
    const uploadId = crypto.randomBytes(16).toString('hex');
    _chunks.set(uploadId, { name, mime, size, owner: String(req.user._id), createdAt: Date.now() });
    purgeStaleChunks();
    return res.json({ uploadId, chunkSize: CHUNK_HINT_BYTES });
  } catch (e) {
    return res.status(500).json({ error: 'Chunk init failed' });
  }
});

// POST /api/uploads/chunk — one chunk (multipart: uploadId, index, file='chunk').
router.post('/chunk', chunkUpload.single('chunk'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No chunk received' });
    const uploadId = String(req.body.uploadId || '');
    const index = Number(req.body.index);
    const meta = _chunks.get(uploadId);
    if (!meta || meta.owner !== String(req.user._id)) return res.status(400).json({ error: 'Unknown upload session.' });
    if (!Number.isInteger(index) || index < 0) return res.status(400).json({ error: 'Invalid chunk index.' });
    const dir = chunkDir(uploadId);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, String(index).padStart(8, '0')), req.file.buffer);
    meta.createdAt = Date.now();
    return res.json({ ok: true, received: index });
  } catch (e) {
    return res.status(500).json({ error: 'Chunk failed' });
  }
});

// POST /api/uploads/chunk-complete — assemble the parts and store the file.
router.post('/chunk-complete', async (req, res) => {
  try {
    const uploadId = String(req.body.uploadId || '');
    const meta = _chunks.get(uploadId);
    if (!meta || meta.owner !== String(req.user._id)) return res.status(400).json({ error: 'Unknown upload session.' });
    const dir = chunkDir(uploadId);
    let parts = [];
    try {
      parts = fs.readdirSync(dir);
    } catch (_) {}
    if (!parts.length) return res.status(400).json({ error: 'No chunks received.' });
    parts.sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
    const buffers = parts.map((p) => fs.readFileSync(path.join(dir, p)));
    const full = Buffer.concat(buffers);
    cleanupChunk(uploadId); // free temp space before the (possibly long) store
    if (full.length !== meta.size) return res.status(400).json({ error: 'Size mismatch — upload incomplete.' });
    const stored = await storeFileData(full, {
      name: meta.name,
      mime: meta.mime,
      folder: 'chat',
      ownerTag: String(req.user._id),
      baseUrl: `${req.protocol}://${req.get('host')}`,
    });
    const out = await recordUpload(req.user, stored);
    return res.json(out);
  } catch (e) {
    console.error('[uploads] chunk-complete failed:', e.message);
    return res.status(500).json({ error: 'Chunk complete failed' });
  }
});

module.exports = router;