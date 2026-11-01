'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lus-'));
process.env.DB_PATH = path.join(tmp, 'test.db');
process.env.MEDIA_DIR = path.join(tmp, 'media');
process.env.NODE_ENV = 'test';
process.env.TRUST_PROXY = '1'; // each test client gets its own fake IP via X-Forwarded-For
fs.mkdirSync(process.env.MEDIA_DIR);

const cfg = require('../src/config');
const { createServer } = require('../src/app');
const { q } = require('../src/db');
const sec = require('../src/security');
const { now } = require('../src/core');

let base, server;
test.before(async () => {
  server = createServer();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const pw = await sec.hashPassword('Admin-Passw0rd!');
  q("INSERT INTO users(role,name,email,phone,pw_hash,created_at) VALUES('admin','Boss','boss@lusibane.test','0815786526',?,?)").run(pw, now());
});
test.after(() => server.close());

// minimal cookie-jar client
class Client {
  static n = 0;
  constructor() { this.cookie = ''; this.csrf = ''; this.ip = `10.1.${Math.floor(Client.n / 250)}.${(Client.n++ % 250) + 1}`; }
  async req(method, url, body, extra = {}) {
    const headers = { Origin: base, 'X-Forwarded-For': this.ip, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...extra };
    if (this.cookie) headers.Cookie = this.cookie;
    if (this.csrf && !('X-CSRF-Token' in extra)) headers['X-CSRF-Token'] = this.csrf;
    const r = await fetch(base + url, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    const sc = r.headers.get('set-cookie');
    if (sc) this.cookie = sc.split(';')[0];
    let json = null; try { json = await r.json(); } catch { /* none */ }
    if (json && json.csrf) this.csrf = json.csrf;
    return { status: r.status, json, headers: r.headers };
  }
  get(u) { return this.req('GET', u); }
  post(u, b = {}, e) { return this.req('POST', u, b, e); }
}
const ADMIN = { email: 'boss@lusibane.test', password: 'Admin-Passw0rd!' };
// Logging in is rate limited per email, so most tests share one admin session (same cookie, same CSRF token).
let shared = null;
const adminClient = async ({ fresh = false } = {}) => {
  if (!fresh && shared) { const a = new Client(); a.cookie = shared.cookie; a.csrf = shared.csrf; return a; }
  const a = new Client(); assert.equal((await a.post('/api/auth/login', ADMIN)).status, 200);
  if (!fresh) shared = a;
  return a;
};
const tomorrow = () => new Date(Date.now() + 86400e3 + 7200e3).toISOString().slice(0, 10);
let phoneN = 0;
const form = (o = {}) => ({
  name: 'Thandi Nkosi', phone: '082' + String(1000000 + phoneN++), area: 'Schoemansdal', plan: 'Lusibane Home',
  contact_pref: 'WhatsApp', consent: true, ...o,
});
const waitFor = async (fn, ms = 3000) => { const t = Date.now(); for (;;) { const v = fn(); if (v) return v; if (Date.now() - t > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 25)); } };

// ---------------------------------------------------------------- a tiny fake SMTP server
function fakeSmtp() {
  const mails = [];
  const srv = net.createServer((s) => {
    let data = '', inData = false, cur = { raw: '' };
    s.write('220 fake ESMTP\r\n');
    let buf = '';
    s.on('data', (d) => {
      buf += d.toString('utf8');
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (inData) {
          if (line === '.') { inData = false; cur.raw = data; mails.push(cur); cur = { raw: '' }; data = ''; s.write('250 queued\r\n'); }
          else data += line + '\r\n';
        } else if (/^EHLO/i.test(line)) s.write('250-fake\r\n250 8BITMIME\r\n');
        else if (/^MAIL FROM/i.test(line)) { cur.from = line; s.write('250 ok\r\n'); }
        else if (/^RCPT TO/i.test(line)) { cur.to = line; s.write('250 ok\r\n'); }
        else if (/^DATA/i.test(line)) { inData = true; s.write('354 go\r\n'); }
        else if (/^QUIT/i.test(line)) { s.write('221 bye\r\n'); s.end(); }
        else s.write('250 ok\r\n');
      }
    });
    s.on('error', () => {});
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, mails, port: srv.address().port })));
}
const decodeBody = (raw) => Buffer.from(raw.split('\r\n\r\n')[1].replace(/\r\n/g, ''), 'base64').toString('utf8');
const header = (raw, name) => (new RegExp('^' + name + ': (.*)$', 'mi').exec(raw) || [])[1];

// ================================================================ security basics
test('security headers are present, and no inline script is allowed', async () => {
  const r = await fetch(base + '/api/session');
  const csp = r.headers.get('content-security-policy');
  assert.match(csp, /script-src 'self'(;|$)/);
  assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
  assert.match(csp, /media-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
});

test('customer accounts are gone: no sign-up, no customer endpoints', async () => {
  const c = new Client();
  assert.equal((await c.post('/api/auth/register', { name: 'X Y', email: 'x@example.com', phone: '0821234567', area: 'a', password: 'Sunny-Garden-42' })).status, 404);
  for (const u of ['/api/me/overview', '/api/me/bookings', '/api/me/invoices', '/api/me/subscription']) assert.equal((await c.get(u)).status, 404, u);
  assert.equal(q("SELECT COUNT(*) c FROM users WHERE email='x@example.com'").get().c, 0);
});

test('an old customer account cannot log in and an old customer session is dead', async () => {
  const pw = await sec.hashPassword('Sunny-Garden-42');
  const uid = Number(q("INSERT INTO users(role,name,email,phone,pw_hash,created_at) VALUES('customer','Old Customer','old@example.com','0821234567',?,?)").run(pw, now()).lastInsertRowid);
  const c = new Client();
  assert.equal((await c.post('/api/auth/login', { email: 'old@example.com', password: 'Sunny-Garden-42' })).status, 401);
  // a session row that survived from before the change
  const tok = sec.token();
  q('INSERT INTO sessions(id_hash,user_id,csrf,created_at,last_seen) VALUES(?,?,?,?,?)').run(sec.sha256(tok), uid, 'x', now(), now());
  const ghost = new Client(); ghost.cookie = `sid=${tok}`;
  assert.equal((await ghost.get('/api/session')).json.user, null);
  assert.equal((await ghost.get('/api/staff/jobs')).status, 401);
  // customers can no longer be given reset codes either
  const admin = await adminClient();
  assert.equal((await admin.post(`/api/admin/users/${uid}/reset-code`)).status, 404);
});

test('staff passwords are stored as scrypt hashes; sessions stored hashed', async () => {
  const row = q("SELECT pw_hash FROM users WHERE email='boss@lusibane.test'").get();
  assert.match(row.pw_hash, /^scrypt\$/);
  assert.ok(!row.pw_hash.includes('Admin-Passw0rd!'));
  await adminClient();
  assert.equal(q('SELECT id_hash FROM sessions LIMIT 1').get().id_hash.length, 64);
});

test('login: wrong password gives generic error, 5 failures lock the account', async () => {
  const admin = await adminClient();
  assert.equal((await admin.post('/api/admin/staff', { name: 'Lock Me', email: 'lock@lusibane.test', phone: '0829990000', password: 'Temp-Crew-Pass9' })).status, 201);
  const c2 = new Client();
  const unknown = await c2.post('/api/auth/login', { email: 'ghost@example.com', password: 'whatever-123' });
  const wrong = await c2.post('/api/auth/login', { email: 'lock@lusibane.test', password: 'wrong-password-1' });
  assert.equal(unknown.status, 401); assert.equal(wrong.status, 401);
  assert.equal(unknown.json.error, wrong.json.error);
  for (let i = 0; i < 4; i++) await c2.post('/api/auth/login', { email: 'lock@lusibane.test', password: 'wrong-password-1' });
  assert.equal((await c2.post('/api/auth/login', { email: 'lock@lusibane.test', password: 'Temp-Crew-Pass9' })).status, 429);
});

test('SQL injection strings are treated as plain data', async () => {
  const c = new Client();
  const r = await c.post('/api/auth/login', { email: "admin'--@x.co", password: "' OR '1'='1" });
  assert.ok([400, 401].includes(r.status));
  assert.equal((await c.post('/api/quotes', { name: "Robert'); DROP TABLE users;--", phone: '0821234567', area: 'x', service: '' })).status, 201);
  const j = await c.post('/api/join', form({ name: "Robert'); DROP TABLE join_requests;--" }));
  assert.equal(j.status, 201);
  assert.ok(q('SELECT COUNT(*) c FROM users').get().c > 0);
  assert.ok(q('SELECT COUNT(*) c FROM join_requests').get().c > 0);
});

test('CSRF: forged and cross-origin admin requests are rejected', async () => {
  const admin = await adminClient();
  const body = { name: 'Csrf Crew', email: 'csrf@lusibane.test', phone: '0821110000', password: 'Temp-Crew-Pass9' };
  assert.equal((await admin.req('POST', '/api/admin/staff', body, { 'X-CSRF-Token': 'wrong' })).status, 403);
  assert.equal((await admin.req('POST', '/api/admin/staff', body, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await admin.req('POST', '/api/admin/staff', body)).status, 201);
});

// ================================================================ the joining form
test('joining form: validates every field', async () => {
  const c = new Client();
  const bad = async (o, re) => { const r = await c.post('/api/join', form(o)); assert.equal(r.status, 400, JSON.stringify(o)); if (re) assert.match(r.json.error, re); };
  await bad({ name: '' }, /Full name/);
  await bad({ name: 'A' }, /too short/);
  await bad({ phone: 'abc' }, /phone/i);
  await bad({ area: '' }, /Area/);
  await bad({ email: 'nope' }, /email/i);
  await bad({ plan: 'Platinum' }, /Plan/);
  await bad({ contact_pref: 'Carrier pigeon' }, /Contact/);
  await bad({ contact_pref: 'Email' }, /email/i);
  await bad({ consent: false }, /tick the box/);
  await bad({ consent: 'yes' }, /tick the box/);
  await bad({ name: 'Line\r\nBcc: evil@example.com' }, /invalid characters/);
  await bad({ details: 'x'.repeat(1001) }, /too long/);
  assert.equal(q("SELECT COUNT(*) c FROM join_requests WHERE name LIKE 'Line%'").get().c, 0);
});

test('joining form: saves for the admin, gives a reference, and needs no account', async () => {
  const c = new Client();
  const r = await c.post('/api/join', form({ name: 'Sipho Dlamini', email: 'Sipho@Example.com', address: 'Next to the spaza', plan: 'Lusibane Home Plus',
    best_time: 'Mornings (08:00 to 12:00)', details: 'Two bins, big yard' }));
  assert.equal(r.status, 201);
  assert.match(r.json.reference, /^JOIN-\d{5}$/);
  assert.equal(r.headers.get('set-cookie'), null, 'no session or cookie is created');
  const row = q('SELECT * FROM join_requests WHERE id=?').get(Number(r.json.reference.slice(5)));
  assert.equal(row.name, 'Sipho Dlamini'); assert.equal(row.email, 'sipho@example.com'); assert.equal(row.plan, 'Lusibane Home Plus');
  assert.equal(row.status, 'new');
  assert.equal(q("SELECT COUNT(*) c FROM users WHERE name='Sipho Dlamini'").get().c, 0, 'no user account is created');
  // "not sure" is allowed, and so is leaving the plan out
  assert.equal((await new Client().post('/api/join', form({ plan: 'Not sure yet, please advise me' }))).status, 201);
  assert.equal((await new Client().post('/api/join', form({ plan: undefined, contact_pref: undefined }))).status, 201);
});

test('joining form: spam is blocked (hidden field, per-connection and per-phone limits)', async () => {
  const before = q('SELECT COUNT(*) c FROM join_requests').get().c;
  const bot = await new Client().post('/api/join', form({ website: 'http://spam.example' }));
  assert.equal(bot.status, 201, 'bots are told it worked');
  assert.equal(q('SELECT COUNT(*) c FROM join_requests').get().c, before, 'but nothing is saved');
  const c = new Client();
  const same = form();
  assert.equal((await c.post('/api/join', same)).status, 201);
  assert.equal((await c.post('/api/join', same)).status, 201);
  assert.equal((await c.post('/api/join', same)).status, 201);
  assert.equal((await c.post('/api/join', same)).status, 429, 'same phone 4th time in a day');
  const d = new Client();
  for (let i = 0; i < 6; i++) assert.equal((await d.post('/api/join', form())).status, 201);
  assert.equal((await d.post('/api/join', form())).status, 429, 'same connection 7th form in an hour');
});

test('joining form: without email settings the admin still gets it and is told email is not set up', async () => {
  const r = await new Client().post('/api/join', form({ name: 'No Mail Yet' }));
  const id = Number(r.json.reference.slice(5));
  const row = await waitFor(() => { const x = q('SELECT * FROM join_requests WHERE id=?').get(id); return x.email_status !== 'pending' && x; });
  assert.equal(row.email_status, 'not_configured');
  const admin = await adminClient();
  const list = (await admin.get('/api/admin/joins')).json.joins;
  assert.ok(list.find((j) => j.id === id));
});

test('joining form: is emailed to info@ at the same time, and can be re-sent when sending fails', async () => {
  const smtp = await fakeSmtp();
  const saved = { ...cfg.smtp }, savedFrom = cfg.mailFrom;
  try {
    Object.assign(cfg.smtp, { host: '127.0.0.1', port: smtp.port, secure: false, user: '', pass: '' });
    cfg.mailFrom = 'website@lusibaneprojects.co.za';
    const r = await new Client().post('/api/join', form({ name: 'Zanele Mokoena', email: 'zanele@example.com', plan: 'Lusibane Church', details: 'Yard is ~40m x 30m, R€ñ' }));
    assert.equal(r.status, 201);
    const id = Number(r.json.reference.slice(5));
    await waitFor(() => smtp.mails.length === 1);
    const m = smtp.mails[0];
    assert.match(m.to, /info@lusibaneprojects\.co\.za/);
    assert.match(m.from, /website@lusibaneprojects\.co\.za/);
    assert.equal(header(m.raw, 'Reply-To'), 'zanele@example.com');
    assert.match(header(m.raw, 'Subject'), /^New joining form: Zanele Mokoena \(Lusibane Church\)$/);
    const text = decodeBody(m.raw);
    for (const needle of ['Zanele Mokoena', 'zanele@example.com', 'Lusibane Church', 'Schoemansdal', 'R€ñ', r.json.reference]) assert.ok(text.includes(needle), needle);
    assert.equal(q('SELECT email_status s FROM join_requests WHERE id=?').get(id).s, 'sent');

    // mail server down -> request is still saved, flagged as failed, then re-sent from the admin side
    smtp.srv.close(); const dead = smtp.port;
    cfg.smtp.port = dead;
    const r2 = await new Client().post('/api/join', form({ name: 'Mail Down' }));
    const id2 = Number(r2.json.reference.slice(5));
    const row = await waitFor(() => { const x = q('SELECT * FROM join_requests WHERE id=?').get(id2); return x.email_status === 'failed' && x; });
    assert.ok(row.email_error.length > 0);
    const smtp2 = await fakeSmtp(); cfg.smtp.port = smtp2.port;
    const admin = await adminClient();
    assert.equal((await admin.post(`/api/admin/joins/${id2}/resend-email`)).json.result, 'sent');
    await waitFor(() => smtp2.mails.length === 1);
    assert.equal(q('SELECT email_status s FROM join_requests WHERE id=?').get(id2).s, 'sent');
    smtp2.srv.close();
  } finally { Object.assign(cfg.smtp, saved); cfg.mailFrom = savedFrom; try { smtp.srv.close(); } catch { /* closed */ } }
});

test('mailer refuses to send a password without TLS to a remote host', async () => {
  const mail = require('../src/mail');
  await assert.rejects(mail.send({ from: 'a@b.co', to: 'c@d.co', subject: 's', text: 't' }, { host: 'mail.example.invalid', port: 25, user: 'u', pass: 'p' }));
});

// ================================================================ admin side of joining
test('join inbox is admin only', async () => {
  const anon = new Client();
  assert.equal((await anon.get('/api/admin/joins')).status, 401);
  const admin = await adminClient();
  await admin.post('/api/admin/staff', { name: 'Crew One', email: 'crew1@lusibane.test', phone: '0829998888', password: 'Temp-Crew-Pass9' });
  const crew = new Client();
  await crew.post('/api/auth/login', { email: 'crew1@lusibane.test', password: 'Temp-Crew-Pass9' });
  await crew.post('/api/me/password', { current: 'Temp-Crew-Pass9', new_password: 'Crew-Real-Pass77' });
  assert.equal((await crew.get('/api/admin/joins')).status, 403);
  assert.equal((await crew.post('/api/admin/joins/1/acknowledge')).status, 403);
  assert.equal((await crew.get('/api/admin/summary')).status, 403);
});

test('admin acknowledges, contacts, and adds the applicant as a client (fixed-price plan)', async () => {
  const admin = await adminClient();
  const r = await new Client().post('/api/join', form({ name: 'Nomsa Khumalo', plan: 'Lusibane Home' }));
  const id = Number(r.json.reference.slice(5));
  const find = async () => (await admin.get('/api/admin/joins')).json.joins.find((j) => j.id === id);
  assert.equal((await find()).status, 'new');
  assert.equal((await admin.get('/api/admin/summary')).json.new_joins >= 1, true);

  assert.equal((await admin.post(`/api/admin/joins/${id}/acknowledge`)).status, 200);
  let j = await find();
  assert.equal(j.status, 'acknowledged'); assert.equal(j.acknowledged_by, 'Boss'); assert.ok(j.acknowledged_at);
  assert.equal((await admin.post(`/api/admin/joins/${id}/acknowledge`)).status, 409, 'cannot acknowledge twice');
  assert.equal((await admin.post(`/api/admin/joins/${id}/status`, { status: 'joined' })).status, 400, 'joined only via add-client');
  assert.equal((await admin.post(`/api/admin/joins/${id}/status`, { status: 'contacted' })).status, 200);
  assert.equal((await find()).status, 'contacted');

  const add = await admin.post(`/api/admin/joins/${id}/add-client`);
  assert.equal(add.status, 200);
  assert.match(add.json.note, /first invoice/);
  j = await find(); assert.equal(j.status, 'joined'); assert.equal(j.client_id, add.json.client_id);
  assert.equal((await admin.post(`/api/admin/joins/${id}/add-client`)).status, 409, 'cannot add twice');

  const cust = (await admin.get('/api/admin/customers')).json.customers.find((c) => c.id === add.json.client_id);
  assert.equal(cust.name, 'Nomsa Khumalo'); assert.equal(cust.plan, 'Lusibane Home'); assert.equal(cust.plan_status, 'active');
  assert.equal(cust.email, '', 'the placeholder address is never shown');
  assert.equal(cust.balance_cents, 15000, 'first invoice created');
  const row = q('SELECT role,pw_hash FROM users WHERE id=?').get(add.json.client_id);
  assert.equal(row.role, 'customer'); assert.equal(row.pw_hash, '!', 'a client record has no usable password');
  // and it really cannot log in
  const email = q('SELECT email FROM users WHERE id=?').get(add.json.client_id).email;
  assert.equal((await new Client().post('/api/auth/login', { email, password: '!' })).status, 401);
  const audit = (await admin.get('/api/admin/audit')).json.audit.map((a) => a.action);
  for (const a of ['join_submitted', 'join_acknowledged', 'join_contacted', 'join_added_client']) assert.ok(audit.includes(a), a);
});

test('quote-based plan: client starts as pending until the admin sets a price; decline and reopen work', async () => {
  const admin = await adminClient();
  const r = await new Client().post('/api/join', form({ name: 'Pastor Mahlangu', email: 'pastor@example.com', plan: 'Lusibane Church' }));
  const id = Number(r.json.reference.slice(5));
  const add = await admin.post(`/api/admin/joins/${id}/add-client`);
  assert.match(add.json.note, /monthly price/);
  const sub = (await admin.get('/api/admin/subscriptions')).json.subscriptions.find((s) => s.user_id === add.json.client_id);
  assert.equal(sub.status, 'pending');
  assert.equal((await admin.post(`/api/admin/subscriptions/${sub.id}/decide`, { action: 'approve', monthly_rand: 450 })).status, 200);
  const detail = (await admin.get(`/api/admin/customers/${add.json.client_id}`)).json;
  assert.equal(detail.user.email, 'pastor@example.com'); assert.equal(detail.invoices[0].amount_cents, 45000);

  const r2 = await new Client().post('/api/join', form({ name: 'Declined Person' }));
  const id2 = Number(r2.json.reference.slice(5));
  assert.equal((await admin.post(`/api/admin/joins/${id2}/status`, { status: 'declined' })).status, 200);
  assert.equal((await admin.post(`/api/admin/joins/${id2}/status`, { status: 'acknowledged' })).status, 200);
  assert.equal((await admin.post('/api/admin/joins/999999/acknowledge')).status, 404);
});

test('full business flow still works for clients: job -> assign -> crew -> proof; billing is idempotent', async () => {
  const admin = await adminClient();
  const r = await new Client().post('/api/join', form({ name: 'Flow Client', plan: 'Lusibane Home' }));
  const clientId = (await admin.post(`/api/admin/joins/${Number(r.json.reference.slice(5))}/add-client`)).json.client_id;

  // the plan started this month (first invoice already exists), so bill next month
  const nm = new Date(Date.now() + 7200e3); nm.setUTCDate(1); nm.setUTCMonth(nm.getUTCMonth() + 1);
  const month = nm.toISOString().slice(0, 7);
  assert.ok((await admin.post('/api/admin/billing/run', { month })).json.created >= 1);
  assert.equal((await admin.post('/api/admin/billing/run', { month })).json.created, 0, 'billing is idempotent');
  const inv = (await admin.get(`/api/admin/customers/${clientId}`)).json.invoices;
  assert.equal(inv.length, 2, 'first invoice when they joined, plus next month');
  const unpaid = inv.find((i) => i.status === 'unpaid');
  assert.equal((await admin.post(`/api/admin/invoices/${unpaid.id}/pay`, { method: 'EFT' })).status, 200);
  assert.equal((await admin.post(`/api/admin/invoices/${unpaid.id}/pay`, { method: 'EFT' })).status, 409);

  assert.equal((await admin.post('/api/admin/staff', { name: 'Sipho Crew', email: 'sipho@lusibane.test', phone: '0829998888', password: 'Temp-Crew-Pass9' })).status, 201);
  const crew = new Client();
  const login = await crew.post('/api/auth/login', { email: 'sipho@lusibane.test', password: 'Temp-Crew-Pass9' });
  assert.equal(login.json.user.must_change_pw, true);
  assert.equal((await crew.get('/api/staff/jobs')).status, 403);
  assert.equal((await crew.post('/api/me/password', { current: 'Temp-Crew-Pass9', new_password: 'Crew-Real-Pass77' })).status, 200);

  const job = await admin.post('/api/admin/jobs', { user_id: clientId, service: 'Garden & yard', date: tomorrow(), notes: 'Back yard' });
  assert.equal(job.status, 201);
  const crewId = (await admin.get('/api/admin/crew')).json.crew.find((x) => x.name === 'Sipho Crew').id;
  assert.equal((await crew.post(`/api/staff/jobs/${job.json.id}/advance`, {})).status, 404, 'unassigned crew cannot touch job');
  assert.equal((await admin.post(`/api/admin/jobs/${job.json.id}/assign`, { crew_id: crewId })).status, 200);
  const mine = (await crew.get('/api/staff/jobs')).json.jobs;
  assert.equal(mine.length, 1); assert.equal(mine[0].customer, 'Flow Client');
  assert.equal((await crew.post(`/api/staff/jobs/${job.json.id}/advance`, {})).json.status, 'on_the_way');
  assert.equal((await crew.post(`/api/staff/jobs/${job.json.id}/advance`, {})).status, 400, 'proof note required');
  assert.equal((await crew.post(`/api/staff/jobs/${job.json.id}/advance`, { proof: 'Cut grass, bagged waste' })).json.status, 'done');
  const audit = (await admin.get('/api/admin/audit')).json.audit.map((a) => a.action);
  for (const a of ['invoice_paid', 'job_assign', 'job_done', 'staff_create']) assert.ok(audit.includes(a), a);
});

test('admin API never leaks password hashes', async () => {
  const admin = await adminClient();
  const all = JSON.stringify([(await admin.get('/api/admin/customers')).json, (await admin.get('/api/admin/staff')).json, (await admin.get('/api/admin/joins')).json]);
  assert.ok(!all.includes('scrypt') && !all.includes('pw_hash') && !all.includes('no-email.invalid'));
});

test('admin reset code lets locked-out crew back in and kills old sessions', async () => {
  const admin = await adminClient();
  await admin.post('/api/admin/staff', { name: 'Reset Crew', email: 'reset@lusibane.test', phone: '0821112222', password: 'Temp-Crew-Pass9' });
  const crew = new Client();
  const reg = await crew.post('/api/auth/login', { email: 'reset@lusibane.test', password: 'Temp-Crew-Pass9' });
  const { code } = (await admin.post(`/api/admin/users/${reg.json.user.id}/reset-code`)).json;
  assert.match(code, /^[A-Z0-9]{5}-[A-Z0-9]{5}$/);
  const anon = new Client();
  assert.equal((await anon.post('/api/auth/reset', { email: 'reset@lusibane.test', code: 'AAAAA-BBBBB', new_password: 'Brand-New-Pass1' })).status, 400);
  assert.equal((await anon.post('/api/auth/reset', { email: 'reset@lusibane.test', code, new_password: 'Brand-New-Pass1' })).status, 200);
  assert.equal((await anon.post('/api/auth/reset', { email: 'reset@lusibane.test', code, new_password: 'Another-New-Pass1' })).status, 400, 'code is single use');
  assert.equal((await crew.get('/api/session')).json.user, null, 'old session was revoked');
  assert.equal((await anon.post('/api/auth/login', { email: 'reset@lusibane.test', password: 'Brand-New-Pass1' })).status, 200);
});

test('disabling crew ends their session immediately; logout destroys the session', async () => {
  const admin = await adminClient();
  await admin.post('/api/admin/staff', { name: 'Gone Crew', email: 'gone@lusibane.test', phone: '0821113333', password: 'Temp-Crew-Pass9' });
  const crew = new Client();
  const l = await crew.post('/api/auth/login', { email: 'gone@lusibane.test', password: 'Temp-Crew-Pass9' });
  assert.equal((await crew.get('/api/session')).json.user.email, 'gone@lusibane.test');
  await admin.post(`/api/admin/users/${l.json.user.id}/status`, { status: 'disabled' });
  assert.equal((await crew.get('/api/session')).json.user, null);

  const a2 = await adminClient({ fresh: true });
  const stolen = a2.cookie;
  await a2.post('/api/auth/logout');
  const thief = new Client(); thief.cookie = stolen;
  assert.equal((await thief.get('/api/admin/summary')).status, 401);
});

// ================================================================ gallery: photos and videos
test('media gallery lists photos and videos in order, with captions and posters, and nothing else', async () => {
  const dir = cfg.mediaDir;
  const jpg = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAAP/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64');
  fs.writeFileSync(path.join(dir, '10-paving-after.jpg'), jpg);
  fs.writeFileSync(path.join(dir, '02-yard_clearing.jpg'), jpg);
  fs.writeFileSync(path.join(dir, '03-new-fence.mp4'), Buffer.alloc(1000, 7));
  fs.writeFileSync(path.join(dir, '03-new-fence.poster.jpg'), jpg);
  fs.writeFileSync(path.join(dir, 'church clean & shine.webp'), jpg);
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'private');
  fs.writeFileSync(path.join(dir, '.hidden.jpg'), jpg);
  fs.writeFileSync(path.join(dir, 'script.js'), 'alert(1)');
  fs.writeFileSync(path.join(dir, 'whatever.svg'), '<svg onload=alert(1)>');
  const r = await new Client().get('/api/media');
  assert.equal(r.status, 200);
  const m = r.json.media;
  assert.deepEqual(m.map((x) => x.caption), ['Yard clearing', 'New fence', 'Paving after', 'Church clean & shine']);
  assert.deepEqual(m.map((x) => x.kind), ['image', 'video', 'image', 'image']);
  assert.equal(m[1].poster, '/media/03-new-fence.poster.jpg');
  assert.equal(m[3].src, '/media/church%20clean%20%26%20shine.webp');
  const all = JSON.stringify(m);
  assert.ok(!/notes|hidden|script|svg/.test(all));
  // every listed file is really served with the right type
  for (const x of m) { const f = await fetch(base + x.src); assert.equal(f.status, 200, x.src); }
  assert.equal((await fetch(base + m[0].src)).headers.get('content-type'), 'image/jpeg');
  assert.equal((await fetch(base + '/media/notes.txt')).status, 404);
  assert.equal((await fetch(base + '/media/.hidden.jpg')).status, 404);
  assert.equal((await fetch(base + '/media/script.js')).status, 404, 'scripts are never served from the media folder');
  assert.equal((await fetch(base + '/media/whatever.svg')).status, 404, 'neither is SVG');
});

test('videos support range requests so they play and seek on phones', async () => {
  const dir = cfg.mediaDir;
  const bytes = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));
  fs.writeFileSync(path.join(dir, '05-range-test.mp4'), bytes);
  const u = base + '/media/05-range-test.mp4';
  const full = await fetch(u);
  assert.equal(full.status, 200); assert.equal(full.headers.get('accept-ranges'), 'bytes'); assert.equal(full.headers.get('content-type'), 'video/mp4');
  assert.equal((await full.arrayBuffer()).byteLength, 1000);
  const part = await fetch(u, { headers: { Range: 'bytes=10-19' } });
  assert.equal(part.status, 206); assert.equal(part.headers.get('content-range'), 'bytes 10-19/1000');
  assert.deepEqual(Buffer.from(await part.arrayBuffer()), bytes.subarray(10, 20));
  const open = await fetch(u, { headers: { Range: 'bytes=990-' } });
  assert.equal(open.status, 206); assert.equal((await open.arrayBuffer()).byteLength, 10);
  const tail = await fetch(u, { headers: { Range: 'bytes=-5' } });
  assert.equal(tail.status, 206); assert.deepEqual(Buffer.from(await tail.arrayBuffer()), bytes.subarray(995));
  const over = await fetch(u, { headers: { Range: 'bytes=5000-6000' } });
  assert.equal(over.status, 416);
  assert.equal((await fetch(u, { headers: { Range: 'bytes=abc' } })).status, 416);
  assert.equal((await fetch(u, { method: 'HEAD' })).headers.get('content-length'), '1000');
});

test('an empty media folder gives an empty list, not an error', async () => {
  const saved = cfg.mediaDir; cfg.mediaDir = path.join(tmp, 'does-not-exist');
  try { const r = await new Client().get('/api/media'); assert.equal(r.status, 200); assert.deepEqual(r.json.media, []); } finally { cfg.mediaDir = saved; }
});

// ================================================================ pages, static files, limits
test('the join and staff pages are served at clean addresses', async () => {
  for (const [p, needle] of [['/join', 'Your joining form'], ['/staff', 'Staff console'], ['/', 'data-gallery'], ['/join/', 'Your joining form']]) {
    const r = await fetch(base + p); assert.equal(r.status, 200, p);
    assert.match(r.headers.get('content-type'), /text\/html/); assert.ok((await r.text()).includes(needle), p);
  }
  const home = await (await fetch(base + '/')).text();
  assert.ok(!/data-open|My Account|create account|Create account|portal\.js/.test(home), 'no account wording is left on the home page');
  assert.ok(home.includes('href="/join'), 'home page links to the joining form');
});

test('input limits: oversized body, wrong content type, bad JSON', async () => {
  const big = await fetch(base + '/api/join', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ x: 'a'.repeat(200000) }) });
  assert.equal(big.status, 413);
  const wrongType = await fetch(base + '/api/join', { method: 'POST', headers: { Origin: base, 'Content-Type': 'text/plain' }, body: 'hi' });
  assert.equal(wrongType.status, 415);
  const badJson = await fetch(base + '/api/join', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: '{nope' });
  assert.equal(badJson.status, 400);
  const cross = await fetch(base + '/api/join', { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: JSON.stringify(form()) });
  assert.equal(cross.status, 403, 'other websites cannot post the form');
});

test('static server: no path traversal, no hidden files, no data dir exposure', async () => {
  for (const p of ['/../server.js', '/..%2fserver.js', '/%2e%2e/src/db.js', '/assets/../../package.json', '/.env', '/data/lusibane.db', '/%00',
    '/media/../src/db.js', '/media/..%2f..%2fsrc%2fdb.js', '/media/%2e%2e/%2e%2e/package.json']) {
    const r = await fetch(base + p);
    assert.ok([400, 404].includes(r.status), `${p} -> ${r.status}`);
  }
});

test('public quote form stores the request; invalid phone is refused', async () => {
  const ok = await new Client().post('/api/quotes', { name: 'Visitor', phone: '+27 81 578 6526', area: 'Komatipoort', service: 'Fencing', details: '20m fence' });
  assert.equal(ok.status, 201);
  assert.equal((await new Client().post('/api/quotes', { name: 'V', phone: 'abc', area: 'x' })).status, 400);
});
