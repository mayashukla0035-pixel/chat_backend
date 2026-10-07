const crypto = require('crypto');

// Password hashing on Node's built-in scrypt.
//
// Why not bcrypt: this backend has no bcrypt dependency, and scrypt is
// memory-hard and in the standard library, so there is nothing to install and
// no native build to fail. It is an appropriate KDF for this job — the only
// requirement is that it is slow and salted, which it is.
//
// Stored form:  scrypt$<N>$<r>$<p>$<saltHex>$<hashHex>
// Keeping the parameters in the record means the cost can be raised later
// without invalidating existing passwords: `verify` reads them back from the
// stored string instead of assuming today's constants.

const N = 16384; // CPU/memory cost
const r = 8; // block size
const p = 1; // parallelisation
const KEYLEN = 64;
const SALT_BYTES = 16;

// scrypt needs headroom above its memory cost or it throws on a small box.
function scryptOpts(N_, r_, p_) {
  return { N: N_, r: r_, p: p_, maxmem: 256 * 1024 * 1024 };
}

function derive(password, salt, N_, r_, p_, len = KEYLEN) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      Buffer.from(String(password), 'utf8'),
      salt,
      len,
      scryptOpts(N_, r_, p_),
      (err, key) => (err ? reject(err) : resolve(key)),
    );
  });
}

/** Hashes [password], returning the self-describing string stored on the user. */
async function hashPassword(password) {
  const salt = crypto.randomBytes(SALT_BYTES);
  const key = await derive(password, salt, N, r, p);
  return `scrypt$${N}$${r}$${p}$${salt.toString('hex')}$${key.toString('hex')}`;
}

/**
 * Constant-time verification of [password] against a stored hash.
 * Returns false for any malformed/legacy record rather than throwing, so a
 * corrupt row can never lock a user out of the error path.
 */
async function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N_ = Number(parts[1]);
  const r_ = Number(parts[2]);
  const p_ = Number(parts[3]);
  const salt = Buffer.from(parts[4], 'hex');
  const expected = Buffer.from(parts[5], 'hex');
  if (!Number.isFinite(N_) || !Number.isFinite(r_) || !Number.isFinite(p_)) return false;
  if (salt.length === 0 || expected.length === 0) return false;
  let actual;
  try {
    actual = await derive(password, salt, N_, r_, p_, expected.length);
  } catch (_) {
    return false;
  }
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

module.exports = { hashPassword, verifyPassword };