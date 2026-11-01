'use strict';
const { q, tx } = require('../db');
const { HttpError, bad, now, SERVICES, PLANS, v, audit, publicUser } = require('../core');
const sec = require('../security');
const http = require('../http');
const { limiter, createSession } = require('../session');

const LOGIN_FAIL = 'Incorrect email or password';
const config = () => ({
  services: SERVICES,
  plans: Object.entries(PLANS).map(([name, p]) => ({ name, cents: p.cents, from: p.from, blurb: p.blurb })),
});

const STAFF = ['staff', 'admin'];

module.exports = (add) => {
  add('GET', '/api/session', { auth: null }, async (ctx) => {
    if (!ctx.user) return { user: null, config: config() };
    return { user: publicUser(ctx.user), csrf: ctx.session.csrf, config: config() };
  });

  add('POST', '/api/auth/login', { auth: null }, async (ctx) => {
    const email = v.email(ctx.body.email);
    const password = typeof ctx.body.password === 'string' ? ctx.body.password.slice(0, 200) : '';
    if (!limiter.hit('login-ip:' + ctx.ip, 30, 15 * 60e3) || !limiter.hit('login-em:' + email, 12, 15 * 60e3)) {
      throw new HttpError(429, 'Too many attempts. Please wait 15 minutes and try again.');
    }
    // Customers have no accounts any more. Only crew and admin can sign in.
    const u = q("SELECT * FROM users WHERE email=? AND role IN ('staff','admin')").get(email);
    if (!u) { await sec.dummyVerify(password); throw new HttpError(401, LOGIN_FAIL); }
    if (u.locked_until > now()) throw new HttpError(429, 'This account is temporarily locked after too many wrong passwords. Try again in 15 minutes or ask the administrator for a reset code.');
    const ok = await sec.verifyPassword(password, u.pw_hash);
    if (!ok) {
      const fails = u.failed_logins + 1;
      if (fails >= 5) {
        q('UPDATE users SET failed_logins=0, locked_until=? WHERE id=?').run(now() + 900, u.id);
        ctx.user = null; audit(ctx, 'account_locked', 'user', u.id, 'too many failed logins');
      } else {
        q('UPDATE users SET failed_logins=? WHERE id=?').run(fails, u.id);
      }
      throw new HttpError(401, LOGIN_FAIL);
    }
    if (u.status !== 'active') throw new HttpError(403, 'This account is disabled. Please contact the administrator.');
    q('UPDATE users SET failed_logins=0, locked_until=0, last_login=? WHERE id=?').run(now(), u.id);

    // drop any session this browser already had, then issue a brand-new one
    const old = http.parseCookies(ctx.req.headers.cookie)[require('../config').cookieName];
    if (old) q('DELETE FROM sessions WHERE id_hash=?').run(sec.sha256(old));
    const csrf = createSession(ctx, u.id);
    ctx.user = u;
    audit(ctx, 'login', 'user', u.id, u.role);
    return { user: publicUser(u), csrf };
  });

  add('POST', '/api/auth/logout', { auth: STAFF, allowMustChange: true }, async (ctx) => {
    q('DELETE FROM sessions WHERE id_hash=?').run(ctx.session.id_hash);
    ctx.headers['Set-Cookie'] = http.sessionCookie('', 0);
    return { ok: true };
  });

  // Staff give out one-time reset codes (usually over WhatsApp). No email server needed.
  add('POST', '/api/auth/reset', { auth: null }, async (ctx) => {
    const email = v.email(ctx.body.email);
    if (!limiter.hit('reset-ip:' + ctx.ip, 10, 3600e3) || !limiter.hit('reset-em:' + email, 6, 3600e3)) {
      throw new HttpError(429, 'Too many attempts. Try again later.');
    }
    const code = v.text(ctx.body.code, 'Reset code', { max: 20 }).toUpperCase().replace(/[^A-Z0-9]/g, '');
    const u = q("SELECT id,email,status FROM users WHERE email=? AND role IN ('staff','admin')").get(email);
    const row = u && q('SELECT code_hash,expires_at FROM reset_codes WHERE user_id=? ORDER BY id DESC LIMIT 1').get(u.id);
    if (!u || !row || row.expires_at < now() || !sec.safeEqual(sec.sha256(code), row.code_hash)) {
      throw bad('That reset code is invalid or has expired');
    }
    const problem = sec.passwordProblem(ctx.body.new_password, email);
    if (problem) throw bad(problem);
    const pw = await sec.hashPassword(ctx.body.new_password);
    tx(() => {
      q('UPDATE users SET pw_hash=?, failed_logins=0, locked_until=0, must_change_pw=0 WHERE id=?').run(pw, u.id);
      q('DELETE FROM reset_codes WHERE user_id=?').run(u.id);
      q('DELETE FROM sessions WHERE user_id=?').run(u.id);
    });
    ctx.user = null;
    audit(ctx, 'password_reset_by_code', 'user', u.id);
    return { ok: true };
  });

  add('PATCH', '/api/me', { auth: STAFF }, async (ctx) => {
    const b = ctx.body;
    const name = v.text(b.name, 'Full name', { min: 2, max: 100 });
    const phone = v.phone(b.phone);
    const area = v.text(b.area, 'Area or street', { max: 120, optional: true });
    const address = v.text(b.address, 'Address', { max: 200, optional: true });
    q('UPDATE users SET name=?, phone=?, area=?, address=? WHERE id=?').run(name, phone, area, address, ctx.user.id);
    audit(ctx, 'profile_update', 'user', ctx.user.id);
    return { user: publicUser({ ...ctx.user, name, phone, area, address }) };
  });

  add('POST', '/api/me/password', { auth: STAFF, allowMustChange: true }, async (ctx) => {
    if (!limiter.hit('pwchange:' + ctx.user.id, 8, 3600e3)) throw new HttpError(429, 'Too many attempts. Try again later.');
    const row = q('SELECT pw_hash,email FROM users WHERE id=?').get(ctx.user.id);
    const current = typeof ctx.body.current === 'string' ? ctx.body.current.slice(0, 200) : '';
    if (!(await sec.verifyPassword(current, row.pw_hash))) throw bad('Your current password is not correct');
    const problem = sec.passwordProblem(ctx.body.new_password, row.email);
    if (problem) throw bad(problem);
    if (ctx.body.new_password === current) throw bad('Choose a different password to your current one');
    const pw = await sec.hashPassword(ctx.body.new_password);
    tx(() => {
      q('UPDATE users SET pw_hash=?, must_change_pw=0 WHERE id=?').run(pw, ctx.user.id);
      q('DELETE FROM sessions WHERE user_id=? AND id_hash<>?').run(ctx.user.id, ctx.session.id_hash);
    });
    audit(ctx, 'password_change', 'user', ctx.user.id);
    return { ok: true };
  });
};
