'use strict';
const cfg = require('./config');
const { q } = require('./db');
const { now } = require('./core');
const sec = require('./security');
const http = require('./http');

const limiter = new sec.Limiter();

/** Creates a fresh session (new random id every login, so session fixation is impossible). */
function createSession(ctx, userId) {
  const tok = sec.token();
  const csrf = sec.token();
  const t = now();
  q('INSERT INTO sessions(id_hash,user_id,csrf,created_at,last_seen,ip,ua) VALUES(?,?,?,?,?,?,?)')
    .run(sec.sha256(tok), userId, csrf, t, t, ctx.ip, String(ctx.req.headers['user-agent'] || '').slice(0, 200));
  // keep at most 10 live sessions per user
  q(`DELETE FROM sessions WHERE user_id=? AND id_hash NOT IN
     (SELECT id_hash FROM sessions WHERE user_id=? ORDER BY last_seen DESC LIMIT 10)`).run(userId, userId);
  ctx.headers['Set-Cookie'] = http.sessionCookie(tok, cfg.sessionMaxSec);
  return csrf;
}

function loadSession(req) {
  const raw = http.parseCookies(req.headers.cookie)[cfg.cookieName];
  if (!raw || raw.length > 100) return null;
  const row = q(`SELECT s.id_hash, s.csrf, s.created_at, s.last_seen,
      u.id, u.role, u.name, u.email, u.phone, u.area, u.address, u.status, u.must_change_pw
    FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ? AND u.role IN ('staff','admin')`).get(sec.sha256(raw));
  if (!row) return null;
  const t = now();
  if (row.status !== 'active' || t - row.last_seen > cfg.sessionIdleSec || t - row.created_at > cfg.sessionMaxSec) {
    q('DELETE FROM sessions WHERE id_hash=?').run(row.id_hash);
    return null;
  }
  if (t - row.last_seen > 60) q('UPDATE sessions SET last_seen=? WHERE id_hash=?').run(t, row.id_hash);
  return row;
}

function cleanup() {
  const t = now();
  // Customers no longer have accounts: remove any session left over from before.
  q("DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE role='customer')").run();
  q('DELETE FROM sessions WHERE last_seen < ? OR created_at < ?').run(t - cfg.sessionIdleSec, t - cfg.sessionMaxSec);
  q('DELETE FROM reset_codes WHERE expires_at < ?').run(t);
}

module.exports = { limiter, createSession, loadSession, cleanup };
