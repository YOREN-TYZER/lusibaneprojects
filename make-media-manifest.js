'use strict';
// Builds site/media/media.json from the pictures and videos in site/media/.
// Runs automatically on every deploy (see .github/workflows/pages.yml). You can also run: node scripts/make-media-manifest.js
const fs = require('node:fs');
const path = require('node:path');
const dir = path.join(__dirname, '..', 'site', 'media');
const IMG = new Set(['.jpg', '.jpeg', '.png', '.webp']), VID = new Set(['.mp4', '.m4v', '.webm']);
const caption = (f) => {
  const b = path.basename(f, path.extname(f)).replace(/^\d+[\s._-]*/, '').replace(/[-_]+/g, ' ').trim();
  return b ? b[0].toUpperCase() + b.slice(1) : '';
};
fs.mkdirSync(dir, { recursive: true });
const names = fs.readdirSync(dir).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
const set = new Set(names), media = [];
for (const f of names) {
  if (f.startsWith('.')) continue;
  const ext = path.extname(f).toLowerCase();
  const vid = VID.has(ext);
  if (!vid && !IMG.has(ext)) continue;
  if (!vid && /\.poster\.[a-z]+$/i.test(f)) continue;
  const item = { kind: vid ? 'video' : 'image', src: 'media/' + encodeURIComponent(f), caption: caption(f) };
  if (vid) {
    const stem = path.basename(f, ext);
    const p = ['jpg', 'jpeg', 'png', 'webp'].map((e) => `${stem}.poster.${e}`).find((x) => set.has(x));
    if (p) item.poster = 'media/' + encodeURIComponent(p);
  }
  media.push(item);
}
fs.writeFileSync(path.join(dir, 'media.json'), JSON.stringify({ media }, null, 1) + '\n');
console.log(`media.json: ${media.length} item(s)`);
