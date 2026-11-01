'use strict';
const fs = require('node:fs');
const path = require('node:path');
const cfg = require('../config');
const { q } = require('../db');
const { HttpError, now, v, audit } = require('../core');
const { limiter } = require('../session');

const IMG = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const VID = new Set(['.mp4', '.webm', '.m4v']);

// "03-fence-before-and-after.jpg" -> "Fence before and after". Digits at the start only control the order.
function caption(file) {
  const base = path.basename(file, path.extname(file)).replace(/^\d+[\s._-]*/, '').replace(/[-_]+/g, ' ').trim();
  return base ? base[0].toUpperCase() + base.slice(1) : '';
}

/** Lists the photos and videos in the media folder. No database, no upload form: just drop files in the folder. */
function listMedia() {
  let names;
  try { names = fs.readdirSync(cfg.mediaDir); } catch { return []; }
  const set = new Set(names);
  const out = [];
  for (const f of names.slice().sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))) {
    if (f.startsWith('.')) continue;
    const ext = path.extname(f).toLowerCase();
    const isImg = IMG.has(ext), isVid = VID.has(ext);
    if (!isImg && !isVid) continue;
    if (isImg && /\.poster\.[a-z]+$/i.test(f)) continue; // a poster belongs to a video
    let st; try { st = fs.statSync(path.join(cfg.mediaDir, f)); } catch { continue; }
    if (!st.isFile()) continue;
    const item = { kind: isVid ? 'video' : 'image', src: '/media/' + encodeURIComponent(f), caption: caption(f) };
    if (isVid) {
      const stem = path.basename(f, path.extname(f));
      const poster = ['jpg', 'jpeg', 'png', 'webp'].map((e) => `${stem}.poster.${e}`).find((p) => set.has(p));
      if (poster) item.poster = '/media/' + encodeURIComponent(poster);
    }
    out.push(item);
    if (out.length >= 200) break;
  }
  return out;
}

module.exports = (add) => {
  add('GET', '/api/media', { auth: null }, async () => ({ media: listMedia() }));

  // Contact form and once-off quote requests.
  add('POST', '/api/quotes', { auth: null }, async (ctx) => {
    if (!limiter.hit('quote:' + ctx.ip, 8, 3600e3)) throw new HttpError(429, 'Too many requests from this connection. Please call or WhatsApp us instead.');
    const b = ctx.body;
    const name = v.text(b.name, 'Name', { min: 2, max: 100 });
    const phone = v.phone(b.phone);
    const area = v.text(b.area, 'Area or street', { max: 120 });
    const service = v.text(b.service, 'Service', { max: 100, optional: true });
    const details = v.text(b.details, 'Details', { max: 1000, multiline: true, optional: true });
    const r = q('INSERT INTO quotes(user_id,name,phone,area,service,details,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(null, name, phone, area, service, details, now());
    audit(ctx, 'quote_request', 'quote', Number(r.lastInsertRowid), service);
    ctx.status = 201;
    return { ok: true, id: Number(r.lastInsertRowid) };
  });
};
