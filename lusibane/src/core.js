'use strict';
const { q } = require('./db');

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const bad = (m) => new HttpError(400, m);

const now = () => Math.floor(Date.now() / 1000);
// South Africa is UTC+2 all year (no daylight saving).
const todaySAST = () => new Date(Date.now() + 2 * 3600 * 1000).toISOString().slice(0, 10);

const SERVICES = ['Household waste', 'Nappy & sanitary waste', 'Drain clearing', 'Garden & yard',
  'Paving & surfacing', 'Fencing & boundary', 'Painting', 'Cleaning', 'Once-off project'];

// Base prices in cents. "from" plans are confirmed by staff after a site visit.
const PLANS = {
  'Lusibane Home':      { cents: 15000, from: false, blurb: 'Waste collected once a week' },
  'Lusibane Home Plus': { cents: 50000, from: false, blurb: 'Waste plus yard care twice a week' },
  'Lusibane Church':    { cents: 40000, from: true,  blurb: 'Waste, yard and full cleaning' },
  'Lusibane School':    { cents: 30000, from: false, blurb: 'Weekly collection after school hours' },
  'Lusibane Business':  { cents: 20000, from: true,  blurb: 'Collection 1 to 3 times a week' },
};

const CONTRACT_KINDS = ['Monthly service', 'Fixed term', 'Once-off job'];

// ---------- validation ----------
const CTRL = /[\u0000-\u001f\u007f]/;
const CTRL_ML = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function text(v, name, { min = 1, max = 200, multiline = false, optional = false } = {}) {
  if (v === undefined || v === null || v === '') {
    if (optional) return '';
    throw bad(`${name} is required`);
  }
  if (typeof v !== 'string') throw bad(`${name} is invalid`);
  let s = v.normalize('NFC').trim();
  if (multiline) s = s.replace(/\r\n/g, '\n');
  if ((multiline ? CTRL_ML : CTRL).test(s)) throw bad(`${name} contains invalid characters`);
  if (s === '' && optional) return '';
  if (s.length < min) throw bad(`${name} is too short`);
  if (s.length > max) throw bad(`${name} is too long`);
  return s;
}
function email(v) {
  const s = text(v, 'Email', { max: 254 }).toLowerCase();
  if (!/^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(s)) throw bad('Enter a valid email address');
  return s;
}
function phone(v) {
  const s = text(v, 'Phone number', { max: 25 }).replace(/[\s()-]/g, '');
  if (!/^\+?\d{9,15}$/.test(s)) throw bad('Enter a valid phone number');
  return s;
}
function date(v, name = 'Date') {
  const s = text(v, name, { max: 10 });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) !== s) {
    throw bad(`${name} is invalid`);
  }
  return s;
}
function oneOf(v, list, name) {
  if (typeof v !== 'string' || !list.includes(v)) throw bad(`${name} is invalid`);
  return v;
}
function rand(v, name, { min = 0.01, max = 1000000, optional = false } = {}) {
  if ((v === undefined || v === null || v === '') && optional) return null;
  const n = typeof v === 'string' ? Number(v.replace(',', '.')) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max) throw bad(`${name} is invalid`);
  return Math.round(n * 100);
}
function id(v) {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 1) throw new HttpError(404, 'Not found');
  return n;
}

function audit(ctx, action, entity = '', entityId = null, detail = '') {
  q('INSERT INTO audit(ts,actor_id,action,entity,entity_id,detail,ip) VALUES(?,?,?,?,?,?,?)')
    .run(now(), ctx && ctx.user ? ctx.user.id : null, action, entity, entityId, String(detail).slice(0, 500), ctx ? ctx.ip : null);
}

const invoiceNo = (n) => 'LUS-' + String(n).padStart(6, '0');

function publicUser(u) {
  return { id: u.id, role: u.role, name: u.name, email: u.email, phone: u.phone, area: u.area,
    address: u.address, must_change_pw: !!u.must_change_pw };
}

module.exports = { HttpError, bad, now, todaySAST, SERVICES, PLANS, CONTRACT_KINDS,
  v: { text, email, phone, date, oneOf, rand, id }, audit, invoiceNo, publicUser };
