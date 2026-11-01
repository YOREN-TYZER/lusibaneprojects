'use strict';
const nodeHttp = require('node:http');
const { HttpError } = require('./core');
const http = require('./http');
const { limiter, loadSession, cleanup } = require('./session');
const sec = require('./security');
const { runBilling } = require('./billing');
const { retryFailed } = require('./joinmail');
const { todaySAST, audit } = require('./core');

const routes = [];

function add(method, pattern, opts, handler) {
  const names = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, n) => { names.push(n); return '(\\d{1,12})'; }) + '$');
  routes.push({ method, re, names, opts, handler });
}
require('./routes/auth')(add);
require('./routes/public')(add);
require('./routes/join')(add);
require('./routes/staff')(add);
require('./routes/admin')(add);

async function handleApi(req, res, url) {
  const ip = http.clientIp(req);
  const ctx = { req, res, url, ip, params: {}, headers: {}, user: null, session: null, body: {}, status: 200 };

  if (!limiter.hit('g:' + ip, 300, 60000)) throw new HttpError(429, 'Too many requests. Please slow down.');

  let route = null, pathMatched = false, m;
  for (const r of routes) {
    if ((m = r.re.exec(url.pathname))) {
      pathMatched = true;
      if (r.method === req.method) { route = r; break; }
    }
  }
  if (!route) throw new HttpError(pathMatched ? 405 : 404, pathMatched ? 'Method not allowed' : 'Not found');
  route.names.forEach((n, i) => { ctx.params[n] = m[i + 1]; });

  const mutating = req.method !== 'GET' && req.method !== 'HEAD';
  if (mutating && !http.originOk(req)) throw new HttpError(403, 'Cross-site request blocked');

  const s = loadSession(req);
  if (s) {
    ctx.session = { id_hash: s.id_hash, csrf: s.csrf };
    ctx.user = { id: s.id, role: s.role, name: s.name, email: s.email, phone: s.phone, area: s.area,
      address: s.address, must_change_pw: s.must_change_pw };
  }

  const { auth, allowMustChange } = route.opts;
  if (auth) {
    if (!ctx.user) throw new HttpError(401, 'Please log in');
    if (!auth.includes(ctx.user.role)) throw new HttpError(403, 'You do not have access to this');
    if (ctx.user.must_change_pw && !allowMustChange) throw new HttpError(403, 'You must change your password first');
    if (mutating && !sec.safeEqual(req.headers['x-csrf-token'] || '', ctx.session.csrf)) {
      throw new HttpError(403, 'Security check failed. Refresh the page and try again');
    }
  }
  if (mutating) ctx.body = await http.readJson(req);

  const result = await route.handler(ctx);
  http.send(res, ctx.status, result === undefined ? { ok: true } : result, ctx.headers);
}

function createServer() {
  const server = nodeHttp.createServer(async (req, res) => {
    http.securityHeaders(res);
    try {
      let url;
      try { url = new URL(req.url, 'http://localhost'); } catch { throw new HttpError(400, 'Bad request'); }
      if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
      else http.serveStatic(req, res, url.pathname);
    } catch (e) {
      if (res.headersSent) return res.end();
      if (e instanceof HttpError) return http.send(res, e.status, { error: e.message });
      console.error('[error]', e && e.stack ? e.stack : e);
      http.send(res, 500, { error: 'Something went wrong on our side. Please try again.' });
    }
  });
  server.headersTimeout = 15000;
  server.requestTimeout = 30000;
  server.keepAliveTimeout = 5000;
  server.maxHeadersCount = 60;
  // Hourly housekeeping + automatic monthly billing (idempotent: nobody is billed twice).
  const tick = () => {
    try {
      cleanup();
      const m = todaySAST().slice(0, 7);
      const r = runBilling(m);
      if (r.created) audit(null, 'auto_billing', 'invoice', null, `${m}: ${r.created} created`);
    } catch (e) { console.error(e); }
    retryFailed().catch((e) => console.error('[join email retry]', e));
  };
  const t = setInterval(tick, 3600 * 1000); t.unref();
  const t0 = setTimeout(tick, 5000); t0.unref();
  server.on('close', () => { clearInterval(t); clearTimeout(t0); });
  return server;
}

module.exports = { createServer };
