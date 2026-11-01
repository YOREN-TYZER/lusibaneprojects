'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cfg = require('./config');
const { HttpError } = require('./core');

const CSP = [
  "default-src 'none'",
  "script-src 'self'",                       // no inline scripts, ever
  "style-src 'self' https://fonts.googleapis.com",
  "style-src-attr 'unsafe-inline'",          // only style="" attributes on the marketing pages
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data:",
  "media-src 'self'",
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join('; ');

function securityHeaders(res) {
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  if (cfg.prod) res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
}

function send(res, status, body, headers = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

function readJson(req, limit = 100 * 1024) {
  return new Promise((resolve, reject) => {
    const ct = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (ct !== 'application/json') return reject(new HttpError(415, 'Content-Type must be application/json'));
    const declared = Number(req.headers['content-length']);
    if (declared > limit) return reject(new HttpError(413, 'Request too large'));
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, 'Request too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        const o = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
        if (o === null || typeof o !== 'object' || Array.isArray(o)) throw new Error();
        resolve(o);
      } catch { reject(new HttpError(400, 'Invalid JSON')); }
    });
    req.on('error', () => reject(new HttpError(400, 'Bad request')));
  });
}

function parseCookies(h) {
  const out = {};
  if (!h) return out;
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function sessionCookie(value, maxAgeSec) {
  return [`${cfg.cookieName}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSec}`,
    ...(cfg.prod ? ['Secure'] : [])].join('; ');
}

function clientIp(req) {
  if (cfg.trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) return String(xff).split(',').pop().trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

/** Reject cross-site state-changing requests. */
function originOk(req) {
  const expected = cfg.origin || `http://${req.headers.host}`;
  const origin = req.headers.origin;
  if (origin) return origin === expected;
  const site = req.headers['sec-fetch-site'];
  return site === 'same-origin' || site === 'none';
}

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json' };

// Clean addresses for the full pages.
const PAGES = { '/join': '/join.html', '/staff': '/staff.html' };
const VIDEO = new Set(['.mp4', '.m4v', '.webm']);
const MEDIA_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.mp4', '.m4v', '.webm']);

function serveStatic(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }); return res.end(); }
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { res.writeHead(400); return res.end(); }
  if (rel.includes('\0') || rel.includes('\\')) { res.writeHead(400); return res.end(); }
  if (rel === '/') rel = '/index.html';
  if (rel.length > 1 && rel.endsWith('/')) rel = rel.slice(0, -1);
  if (PAGES[rel]) rel = PAGES[rel];
  // /media/... comes from the media folder (which can live outside the code folder); everything else from /public.
  const isMedia = rel.startsWith('/media/');
  const root = isMedia ? cfg.mediaDir : cfg.publicDir;
  const full = path.join(root, path.normalize(isMedia ? rel.slice('/media/'.length) : rel));
  if (!full.startsWith(root + path.sep) || path.basename(full).startsWith('.')) { res.writeHead(404); return res.end('Not found'); }
  const ext = path.extname(full).toLowerCase();
  const type = MIME[ext];
  // The media folder only ever serves pictures and videos (never scripts, pages or SVG).
  if (!type || (isMedia && !MEDIA_EXT.has(ext))) { res.writeHead(404); return res.end('Not found'); }
  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    const headers = {
      'Content-Type': type,
      'Cache-Control': type.startsWith('text/html') ? 'no-cache' : 'public, max-age=3600',
    };
    let start = 0, end = st.size - 1, status = 200;
    // Browsers (Safari especially) ask for videos in byte ranges so they can play and skip around.
    if (VIDEO.has(ext)) headers['Accept-Ranges'] = 'bytes';
    const range = VIDEO.has(ext) ? req.headers.range : undefined;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!m || (m[1] === '' && m[2] === '')) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
      if (m[1] === '') { start = Math.max(0, st.size - Number(m[2])); }
      else { start = Number(m[1]); if (m[2] !== '') end = Math.min(end, Number(m[2])); }
      if (start > end || start >= st.size) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
      status = 206; headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
    }
    headers['Content-Length'] = end - start + 1;
    res.writeHead(status, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(full, { start, end }).on('error', () => res.destroy()).pipe(res);
  });
}

module.exports = { securityHeaders, send, readJson, parseCookies, sessionCookie, clientIp, originOk, serveStatic };
