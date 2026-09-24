require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');
const { connectDB } = require('./config/db');
const { initSocket } = require('./socket/handler');

const app = express();
app.use(cors({ origin: (process.env.CLIENT_ORIGIN || '*').split(',') }));
app.use(express.json({ limit: '2mb' }));

const uploadDir = process.env.UPLOAD_DIR || './uploads';
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
app.use('/uploads', express.static(path.resolve(uploadDir)));

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
const io = new Server(server, { cors: { origin: '*' } });
app.set('io', io);
initSocket(io);

// Closed-app push notifications (FCM) — no-op unless FCM_SERVICE_ACCOUNT is set.
require('./services/push').initPush();

// Periodic Google Sheets sync so access data stays fresh without manual runs.
// Failures keep the last good state (handled inside runSync).
const { runSync } = require('./services/sheetsSync');
const SYNC_MINS = Number(process.env.SYNC_INTERVAL_MINUTES || 5);
if (SYNC_MINS > 0) {
  runSync()
    .then((l) => console.log(`[sync] startup ok: students=${l.studentsProcessed} teachers=${l.teachersProcessed} groups=${l.groupsProcessed}`))
    .catch((e) => console.log('[sync] startup failed, keeping last good state:', e.message));
  setInterval(async () => {
    try {
      const l = await runSync();
      console.log(`[sync] ok: students=${l.studentsProcessed} teachers=${l.teachersProcessed} groups=${l.groupsProcessed}`);
    } catch (e) {
      console.log('[sync] failed, keeping last good state:', e.message);
    }
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
