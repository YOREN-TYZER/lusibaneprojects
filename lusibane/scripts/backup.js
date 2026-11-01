'use strict';
// Usage: node scripts/backup.js   (writes backups/lusibane-YYYY-MM-DD-HHMM.db, keeps the newest 30)
const fs = require('node:fs');
const path = require('node:path');
const { db } = require('../src/db');

const dir = path.join(__dirname, '..', 'backups');
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, (c) => (c === 'T' ? '-' : ''));
const file = path.join(dir, `lusibane-${stamp}.db`);
db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
fs.chmodSync(file, 0o600);
const all = fs.readdirSync(dir).filter((f) => f.endsWith('.db')).sort();
for (const old of all.slice(0, Math.max(0, all.length - 30))) fs.unlinkSync(path.join(dir, old));
console.log('Backup written:', file);
