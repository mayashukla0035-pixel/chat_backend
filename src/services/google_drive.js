// Google Drive upload helper for chat attachments (audio + documents).
// Active ONLY when these env vars are present:
//   GOOGLE_DRIVE_CLIENT_ID / GOOGLE_DRIVE_CLIENT_SECRET / GOOGLE_DRIVE_REFRESH_TOKEN
// Files land in per-owner subfolders under a root folder, so the "never mix
// data between accounts" rule holds on Drive too:
//   - GOOGLE_DRIVE_FOLDER_ID (optional): id of a parent folder that holds all
//     per-user sub-folders. If omitted, a root folder "SkillParkho Interview
//     Videos" is auto-created.
//   - GOOGLE_DRIVE_MAKE_PUBLIC=true: files are granted "anyone with the link"
//     read access and the attachment URL is a direct public Drive link. Leave
//     empty to keep files private (they are served through the backend proxy
//     GET /api/drive/files/:id).
const https = require('https');
const { Readable } = require('stream');

const ROOT_FOLDER_NAME = 'SkillParkho Interview Videos';

let _tokenCache = { token: '', expiresAt: 0 };
let _rootId = '';
const _ownerIds = {};

function cfg() {
  return {
    clientId: process.env.GOOGLE_DRIVE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_DRIVE_CLIENT_SECRET,
    refreshToken: process.env.GOOGLE_DRIVE_REFRESH_TOKEN,
    folderId: (process.env.GOOGLE_DRIVE_FOLDER_ID || '').trim(),
    makePublic: /^true$/i.test(String(process.env.GOOGLE_DRIVE_MAKE_PUBLIC || '')),
  };
}

function configured() {
  const c = cfg();
  return !!(c.clientId && c.clientSecret && c.refreshToken);
}

function makePublic() {
  return cfg().makePublic;
}

function httpsRequest(method, url, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request(
      u,
      {
        method,
        headers: {
          ...headers,
          ...(body != null && body.length ? { 'Content-Length': Buffer.byteLength(body) } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8'), stream: res }));
      }
    );
    req.on('error', reject);
    if (body != null) req.write(body);
    req.end();
  });
}

async function api(path, opts = {}) {
  const token = await getAccessToken();
  const { method = 'GET', headers = {}, body, qs = '' } = opts;
  const r = await httpsRequest(method, `https://www.googleapis.com/drive/v3${path}${qs}`, {
    headers: { Authorization: `Bearer ${token}`, ...headers },
    body,
  });
  if (r.status >= 400) {
    throw new Error(`drive api ${r.status}: ${r.body.slice(0, 300)}`);
  }
  return JSON.parse(r.body || '{}');
}

async function getAccessToken() {
  if (_tokenCache.token && _tokenCache.expiresAt > Date.now() + 60 * 1000) return _tokenCache.token;
  const c = cfg();
  const body = new URLSearchParams({
    client_id: c.clientId,
    client_secret: c.clientSecret,
    refresh_token: c.refreshToken,
    grant_type: 'refresh_token',
  }).toString();
  const r = await httpsRequest('POST', 'https://oauth2.googleapis.com/token', {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (r.status >= 400) throw new Error(`drive token ${r.status}: ${r.body.slice(0, 200)}`);
  const b = JSON.parse(r.body);
  _tokenCache = { token: b.access_token, expiresAt: Date.now() + (b.expires_in || 3600) * 1000 };
  return b.access_token;
}

// Resolve the root folder id (explicit GOOGLE_DRIVE_FOLDER_ID, or the
// auto-created "SkillParkho Interview Videos" folder).
async function ensureRootFolder() {
  const c = cfg();
  if (c.folderId) return c.folderId;
  if (_rootId) return _rootId;
  const q = `name='${ROOT_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const res = await api('/files', { qs: `?q=${encodeURIComponent(q)}&fields=files(id,name)&spaces=drive` });
  let root = (res.files || [])[0];
  if (!root) {
    root = await api('/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: ROOT_FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }),
      qs: '?fields=id,name',
    });
  }
  _rootId = root.id;
  return root.id;
}

// Every owner gets their own subfolder under the root — the per-user isolation
// wall on Drive. Folder ids are cached in-memory.
async function ensureOwnerFolder(ownerTag) {
  const key = String(ownerTag);
  if (_ownerIds[key]) return _ownerIds[key];
  const parent = await ensureRootFolder();
  const q = `name='${key}' and '${parent}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  let folder;
  try {
    const res = await api('/files', { qs: `?q=${encodeURIComponent(q)}&fields=files(id,name)&spaces=drive` });
    folder = (res.files || [])[0];
  } catch (_) {
    folder = null;
  }
  if (!folder) {
    folder = await api('/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: key, mimeType: 'application/vnd.google-apps.folder', parents: [parent] }),
      qs: '?fields=id,name',
    });
  }
  _ownerIds[key] = folder.id;
  return folder.id;
}

// Upload an in-memory buffer as a Drive file under the owner's subfolder.
// Returns { fileId, size } or null when Drive isn't configured.
async function uploadBuffer(buffer, { name = 'file', mime = 'application/octet-stream', owner = '' } = {}) {
  if (!configured()) return null;
  const parent = await ensureOwnerFolder(owner || 'default');
  const metadata = JSON.stringify({
    name: String(name).slice(0, 200) || 'file',
    mimeType: mime,
    parents: [parent],
  });
  const boundary = `fxb-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const parts = [
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`,
    `--${boundary}\r\nContent-Type: ${mime}\r\n\r\n`,
  ];
  const head = Buffer.from(parts.join(''));
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  const body = Buffer.concat([head, buffer, tail]);
  const token = await getAccessToken();
  const r = await httpsRequest(
    'POST',
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,size,mimeType,webViewLink',
    {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
      body,
    }
  );
  if (r.status >= 400) throw new Error(`drive upload ${r.status}: ${r.body.slice(0, 300)}`);
  const b = JSON.parse(r.body);
  return { fileId: b.id, size: Number(b.size || 0) };
}

// Grant "anyone with the link" read access (role=reader, type=anyone).
async function setPublic(fileId) {
  const token = await getAccessToken();
  const r = await httpsRequest('POST', `https://www.googleapis.com/drive/v3/files/${fileId}/permissions`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'reader', type: 'anyone' }),
  });
  if (r.status >= 400) {
    // Permission already granted (409/403 on existing anyone + user writes)
    // is fine; other errors are surfaced but shouldn't fail the upload.
    if (r.status !== 403 && r.status !== 409) throw new Error(`drive permission ${r.status}: ${r.body.slice(0, 200)}`);
  }
  return true;
}

// Public (unguessable) direct-download URL for a public file.
function publicUrl(fileId) {
  return `https://drive.google.com/uc?export=download&id=${encodeURIComponent(fileId)}`;
}

// Stream a Drive file's bytes through the backend (used for private files).
// The optional `range` header value (e.g. "bytes=0-1023") is passed through so
// audio players can seek. Returns data via the response object.
function download(fileId, { range } = {}) {
  return new Promise((resolve, reject) => {
    (async () => {
      try {
        const token = await getAccessToken();
        const u = new URL(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`);
        const headers = { Authorization: `Bearer ${token}` };
        if (range) headers.Range = range;
        const req = https.request(u, { method: 'GET', headers }, (res) => {
          resolve({ status: res.statusCode, headers: res.headers, stream: res });
        });
        req.on('error', reject);
        req.end();
      } catch (e) {
        reject(e);
      }
    })();
  });
}

module.exports = {
  configured,
  makePublic,
  getAccessToken,
  uploadBuffer,
  setPublic,
  publicUrl,
  download,
  ensureRootFolder,
  ensureOwnerFolder,
};