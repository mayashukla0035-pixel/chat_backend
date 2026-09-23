// GET /api/drive/files/:fileId — serves a Google Drive file's bytes through
// the backend. Used for attachments that were stored privately (i.e. when
// GOOGLE_DRIVE_MAKE_PUBLIC is not "true"). The file arrives via the backend's
// OAuth credentials, so a short unguessable fileId is the only thing the app
// needs — but the standard authenticated access wall still applies because any
// participant must hold a message whose attachment references this id.
//
// Range requests are passed through so audio players can seek. Downloads set
// ?download=1 to force a Content-Disposition attachment.
const express = require('express');
const { authRequired } = require('../middleware/auth');
const { download } = require('../services/google_drive');

const router = express.Router();
router.use(authRequired);

function passthroughHeaders(src) {
  const h = {};
  if (src['content-type']) h['Content-Type'] = String(src['content-type']);
  if (src['content-length']) h['Content-Length'] = String(src['content-length']);
  if (src['content-range']) h['Content-Range'] = String(src['content-range']);
  if (src['accept-ranges']) h['Accept-Ranges'] = String(src['accept-ranges']);
  if (src['content-disposition']) h['Content-Disposition'] = String(src['content-disposition']);
  return h;
}

router.get('/files/:fileId', async (req, res) => {
  try {
    const fileId = req.params.fileId;
    if (!/^[A-Za-z0-9_-]{6,}$/.test(fileId)) return res.status(400).json({ error: 'Invalid file id' });
    const download1 = String(req.query.download || '') === '1';
    let range;
    if (req.headers.range) {
      // Only the single-range form is supported.
      const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range));
      if (m) range = m[1] || m[2] ? String(req.headers.range) : undefined;
    }
    const r = await download(fileId, { range });
    if (r.status >= 400) {
      return res.status(r.status === 404 ? 404 : 502).json({ error: 'Drive file unavailable' });
    }
    const headers = passthroughHeaders(r.headers);
    if (download1) {
      headers['Content-Disposition'] = `attachment; filename="${fileId}"`;
    }
    res.writeHead(r.status, headers);
    r.stream.pipe(res);
  } catch (e) {
    res.status(502).json({ error: 'Failed to proxy drive file' });
  }
});

module.exports = router;