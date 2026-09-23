const jwt = require('jsonwebtoken');
const User = require('../models/User');

function signToken(user) {
  return jwt.sign(
    { sub: String(user._id), role: user.role, emailNorm: user.emailNorm },
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
    req.user = user;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

module.exports = { signToken, authRequired };
