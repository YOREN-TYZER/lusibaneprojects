'use strict';
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const scrypt = promisify(crypto.scrypt);

// scrypt, per-user random salt, memory-hard. Runs in the libuv threadpool so it never blocks requests.
const N = 32768, R = 8, P = 1, KEYLEN = 64, MAXMEM = 96 * 1024 * 1024;

async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(pw.normalize('NFKC'), salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return ['scrypt', N, R, P, salt.toString('base64'), key.toString('base64')].join('$');
}

async function verifyPassword(pw, stored) {
  try {
    const [alg, n, r, p, salt, key] = stored.split('$');
    if (alg !== 'scrypt') return false;
    const expect = Buffer.from(key, 'base64');
    const got = await scrypt(pw.normalize('NFKC'), Buffer.from(salt, 'base64'), expect.length,
      { N: +n, r: +r, p: +p, maxmem: MAXMEM });
    return crypto.timingSafeEqual(got, expect);
  } catch { return false; }
}

// Used so a login for an unknown email costs the same time as a real one.
let dummyHash;
async function dummyVerify(pw) {
  dummyHash = dummyHash || (await hashPassword('dummy-password-for-timing'));
  await verifyPassword(pw, dummyHash);
}

const COMMON = new Set(['password','password1','password123','1234567890','12345678910','qwertyuiop','qwerty12345',
  'iloveyou123','welcome123','lusibane123','letmein1234','admin12345','0123456789','1q2w3e4r5t','password12']);

function passwordProblem(pw, email = '') {
  if (typeof pw !== 'string') return 'Password is required';
  if (pw.length < 10) return 'Password must be at least 10 characters';
  if (pw.length > 128) return 'Password is too long (max 128)';
  if (COMMON.has(pw.toLowerCase())) return 'That password is too common. Choose something harder to guess';
  if (/^(.)\1+$/.test(pw)) return 'Password cannot be one repeated character';
  if (email && pw.toLowerCase() === email.toLowerCase()) return 'Password cannot be your email address';
  if (new Set(pw).size < 5) return 'Password needs more variety';
  return null;
}

const token = () => crypto.randomBytes(32).toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
function resetCode() {
  let s = '';
  for (const b of crypto.randomBytes(10)) s += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return s.slice(0, 5) + '-' + s.slice(5);
}

/** Fixed-window in-memory limiter. Fine for a single server process. */
class Limiter {
  constructor() { this.m = new Map(); setInterval(() => this.sweep(), 60000).unref(); }
  hit(key, max, windowMs) {
    const now = Date.now();
    let e = this.m.get(key);
    if (!e || e.reset < now) { e = { n: 0, reset: now + windowMs }; this.m.set(key, e); }
    e.n++;
    return e.n <= max;
  }
  sweep() { const now = Date.now(); for (const [k, e] of this.m) if (e.reset < now) this.m.delete(k); }
}

module.exports = { hashPassword, verifyPassword, dummyVerify, passwordProblem, token, sha256, safeEqual, resetCode, Limiter };
