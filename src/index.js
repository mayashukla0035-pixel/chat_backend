require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const compression = require('compression');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { Server } = require('socket.io');
const { connectDB } = require('./config/db');
const { initSocket } = require('./socket/handler');

const app = express();
// We sit behind Railway's proxy — trust the first hop so rate limiting and
// logs see the real client IP instead of the proxy's.
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(cors({ origin: (process.env.CLIENT_ORIGIN || '*').split(',') }));
// Gzip/deflate for JSON responses: the conversation list and history payloads
// are the biggest responses on the hot path.
app.use(compression());
app.use(express.json({ limit: '2mb' }));

// Abuse protection sized for a SHARED network: limits are deliberately
// generous per IP (schools/hotspots NAT many users behind one address) and
// the OTP endpoint is keyed per IP + email so one account can't be spammed.
const apiLimiter = rateLimit({
  windowMs: 60000,
  max: Number(process.env.RATE_LIMIT_PER_MIN || 600),
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api', apiLimiter);
const otpLimiter = rateLimit({
  windowMs: 5 * 60000,
  max: Number(process.env.OTP_RATE_LIMIT_5MIN || 10),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${ipKeyGenerator(req.ip)}:${String((req.body && req.body.email) || '').toLowerCase()}`,
});
app.use('/api/auth/request-otp', otpLimiter);

const uploadDir = process.env.UPLOAD_DIR || './uploads';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
// Upload filenames are unique per upload (<timestamp>-<random>), so a long
// immutable cache is safe and takes media re-downloads off the hot path.
app.use('/uploads', express.static(path.resolve(uploadDir), { maxAge: '7d', immutable: true }));

app.get('/health', (req, res) =>
  res.json({ ok: true, service: 'skillparkho-backend', push: require('./services/push').pushStatus() }));
app.use('/api/auth', require('./routes/auth'));
app.use('/api/conversations', require('./routes/conversations'));
app.use('/api/teachers', require('./routes/teachers'));
app.use('/api/users', require('./routes/users'));
app.use('/api/uploads', require('./routes/uploads'));
app.use('/api/drive', require('./routes/drive'));
app.use('/api/messages', require('./routes/messages'));
app.use('/api/sync', require('./routes/sync'));

const server = http.createServer(app);
// Keep sockets alive across load-balancer idle checks (the default 5s
// keepAliveTimeout caused dropped sockets on quiet connections).
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
const io = new Server(server, {
  cors: { origin: '*' },
  // Liveness tuned for mobile networks: a dead link is detected within
  // ~45s worst case, fast enough to flip status without hogging sockets.
  pingInterval: 25000,
  pingTimeout: 20000,
  // Matches the REST body cap; anything bigger is rejected outright.
  maxHttpBufferSize: 2 * 1024 * 1024,
  // Compression on the WS frames costs CPU per packet; JSON frames are small
  // and gzip already covers the HTTP side.
  perMessageDeflate: false,
  // Re-attach rooms and replay packets missed during a short blip, so a
  // 10k-user fleet doesn't re-run join work for every 2-second hiccup.
  connectionStateRecovery: { maxDisconnectionDuration: 2 * 60 * 1000 },
});
app.set('io', io);
initSocket(io);

// Closed-app push notifications (FCM) — no-op unless FCM_SERVICE_ACCOUNT is set.
require('./services/push').initPush();

// Periodic Google Sheets sync so access data stays fresh without manual runs.
// maybeRunSync is single-flight: the interval can never overlap a login
// triggered catch-up, so two full syncs never run at once.
const { maybeRunSync } = require('./services/sheetsSync');
const SYNC_MINS = Number(process.env.SYNC_INTERVAL_MINUTES || 5);
if (SYNC_MINS > 0) {
  maybeRunSync(0)
    .then((l) => l && console.log(`[sync] startup ok: students=${l.studentsProcessed} teachers=${l.teachersProcessed} groups=${l.groupsProcessed}`))
    .catch((e) => console.log('[sync] startup failed, keeping last good state:', e.message));
  setInterval(() => {
    maybeRunSync(SYNC_MINS * 60000)
      .then((l) => l && console.log(`[sync] ok: students=${l.studentsProcessed} teachers=${l.teachersProcessed} groups=${l.groupsProcessed}`))
      .catch((e) => console.log('[sync] failed, keeping last good state:', e.message));
  }, SYNC_MINS * 60000);
}

const PORT = Number(process.env.PORT || 4000);
connectDB(process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/skillparkho_chat')
  .then(() => server.listen(PORT, '0.0.0.0', () => console.log(`[backend] listening on :${PORT}`)))
  .catch((e) => { console.error('[mongo] failed', e); process.exit(1); });

// SkillParkho Support teacher (from .env) — create/refresh on boot so the
// account can log in without needing an OTP.
const { ensureSupportAccount } = require('./services/support');
ensureSupportAccount()
  .then((u) => u && console.log('[support] account ready:', u.email))
  .catch((e) => console.log('[support] ensure failed:', e.message));
