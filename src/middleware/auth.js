const jwt = require('jsonwebtoken');
const User = require('../models/User');

// One account, ONE device at a time. Lives here so both the login routes and
// the per-request check below reject with the exact same message.
const DEVICE_BLOCK_MSG =
  'This account is already signed in on another device. Log out there first, then sign in here.';

// The device that owns the session is embedded in the JWT, so EVERY
// authenticated call can prove which device holds it. Legacy tokens minted
// before this claim existed carry no deviceId and are grandfathered: they are
// checked at their next refresh instead (see routes/auth.js).
function signToken(user, deviceId) {
  const payload = { sub: String(user._id), role: user.role, emailNorm: user.emailNorm };
  if (deviceId) payload.deviceId = String(deviceId);
  return jwt.sign(
    payload,
    process.env.JWT_SECRET || 'dev-secret',
    { expiresIn: process.env.JWT_EXPIRES_IN || '30d' }
  );
}

async function authRequired(req, res, next) {
  try {
    const h = req.headers.authorization || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : (req.query.token || req.body.token);
    if (!token) return res.status(401).json({ error: 'Missing token' });
    const payload = jwt.verify(token, process.env.JWT_SECRET || 'dev-secret');
    const user = await User.findById(payload.sub);
    if (!user) return res.status(401).json({ error: 'Unknown user' });
    if (user.status !== 'Active') return res.status(403).json({ error: 'Account is inactive' });
    // Single-device, enforced on EVERY authenticated call — not only at
    // login/refresh: a token minted for a device that no longer owns the
    // login lock dies on its very next request, so two devices can never be
    // signed in and working at the same time.
    if (payload.deviceId) {
      if (!user.currentDeviceId) {
        // The lock was released after this token was minted = logged out.
        return res.status(401).json({ error: 'Session is no longer valid. Please sign in again.' });
      }
      if (payload.deviceId !== user.currentDeviceId) {
        return res.status(403).json({ error: DEVICE_BLOCK_MSG, code: 'DEVICE_REPLACED' });
      }
    }
    req.user = user;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

module.exports = { signToken, authRequired, DEVICE_BLOCK_MSG };
