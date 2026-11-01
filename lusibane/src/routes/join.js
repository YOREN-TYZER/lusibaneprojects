'use strict';
const { q, tx } = require('../db');
const { HttpError, bad, now, PLANS, v, audit } = require('../core');
const { limiter } = require('../session');
const { startPlan } = require('../billing');
const { sendJoinEmail } = require('../joinmail');

const A = ['admin'];
const NOT_SURE = 'Not sure yet, please advise me';
const PLAN_CHOICES = [...Object.keys(PLANS), NOT_SURE];
const CONTACT = ['WhatsApp', 'Phone call', 'Email'];
const NO_EMAIL = '@no-email.invalid'; // placeholder for clients who gave no email (never shown)
const ref = (id) => 'JOIN-' + String(id).padStart(5, '0');

module.exports = (add) => {
  // ---------- public: the joining form ----------
  add('POST', '/api/join', { auth: null }, async (ctx) => {
    const b = ctx.body;
    // Hidden field that real people never see. Bots fill it, so we quietly pretend it worked.
    if (typeof b.website === 'string' && b.website.trim() !== '') { ctx.status = 201; return { ok: true, reference: ref(0) }; }

    const name = v.text(b.name, 'Full name', { min: 2, max: 100 });
    const phone = v.phone(b.phone);
    const email = b.email ? v.email(b.email) : '';
    const area = v.text(b.area, 'Area or street', { max: 120 });
    const address = v.text(b.address, 'Address', { max: 200, optional: true });
    const plan = b.plan ? v.oneOf(b.plan, PLAN_CHOICES, 'Plan') : NOT_SURE;
    const contact = b.contact_pref ? v.oneOf(b.contact_pref, CONTACT, 'Contact method') : 'WhatsApp';
    if (contact === 'Email' && !email) throw bad('Add your email address, or choose WhatsApp or Phone call');
    const bestTime = v.text(b.best_time, 'Best time to contact you', { max: 60, optional: true });
    const details = v.text(b.details, 'Notes', { max: 1000, multiline: true, optional: true });
    if (b.consent !== true) throw bad('Please tick the box to let us use your details to contact you');
    // Only forms that are actually valid count towards the limits, so someone fixing a typo is never blocked.
    if (!limiter.hit('join:' + ctx.ip, 6, 3600e3)) {
      throw new HttpError(429, 'Too many forms from this connection. Please call or WhatsApp us on 081 578 6526 instead.');
    }
    if (!limiter.hit('join-ph:' + phone, 3, 24 * 3600e3)) {
      throw new HttpError(429, 'We already have your details and will contact you soon. Please do not send the form again.');
    }

    const t = now();
    const r = q(`INSERT INTO join_requests(name,phone,email,area,address,plan,contact_pref,best_time,details,created_at,updated_at)
                 VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(name, phone, email, area, address, plan, contact, bestTime, details, t, t);
    const id = Number(r.lastInsertRowid);
    audit(ctx, 'join_submitted', 'join', id, plan);
    // The admin inbox already has it. The email to info@ goes out now, in parallel, without making the visitor wait.
    sendJoinEmail(id).catch((e) => console.error('[join email]', e));
    ctx.status = 201;
    return { ok: true, reference: ref(id) };
  });

  // ---------- admin: the joining inbox ----------
  add('GET', '/api/admin/joins', { auth: A }, async () => ({
    joins: q(`SELECT j.id,j.name,j.phone,j.email,j.area,j.address,j.plan,j.contact_pref,j.best_time,j.details,j.status,
        j.email_status,j.email_error,j.acknowledged_at,j.client_id,j.created_at,u.name AS acknowledged_by
      FROM join_requests j LEFT JOIN users u ON u.id=j.acknowledged_by
      ORDER BY CASE j.status WHEN 'new' THEN 0 WHEN 'acknowledged' THEN 1 WHEN 'contacted' THEN 2 ELSE 3 END, j.id DESC LIMIT 500`).all()
      .map((r) => ({ ...r, reference: ref(r.id) })),
  }));

  const open = (id) => {
    const j = q('SELECT * FROM join_requests WHERE id=?').get(id);
    if (!j) throw new HttpError(404, 'Joining form not found');
    return j;
  };
  const ackSql = "acknowledged_at=COALESCE(acknowledged_at,?), acknowledged_by=COALESCE(acknowledged_by,?)";

  add('POST', '/api/admin/joins/:id/acknowledge', { auth: A }, async (ctx) => {
    const id = v.id(ctx.params.id); const j = open(id);
    if (j.status !== 'new') throw new HttpError(409, 'This form has already been acknowledged');
    q(`UPDATE join_requests SET status='acknowledged', ${ackSql}, updated_at=? WHERE id=?`).run(now(), ctx.user.id, now(), id);
    audit(ctx, 'join_acknowledged', 'join', id);
    return { ok: true };
  });

  add('POST', '/api/admin/joins/:id/status', { auth: A }, async (ctx) => {
    const id = v.id(ctx.params.id); const j = open(id);
    const status = v.oneOf(ctx.body.status, ['acknowledged', 'contacted', 'declined'], 'Status');
    if (j.status === 'joined') throw new HttpError(409, 'This person has already joined');
    q(`UPDATE join_requests SET status=?, ${ackSql}, updated_at=? WHERE id=?`).run(status, now(), ctx.user.id, now(), id);
    audit(ctx, 'join_' + status, 'join', id);
    return { ok: true };
  });

  add('POST', '/api/admin/joins/:id/resend-email', { auth: A }, async (ctx) => {
    const id = v.id(ctx.params.id); open(id);
    const result = await sendJoinEmail(id);
    audit(ctx, 'join_email_resend', 'join', id, result);
    return { result };
  });

  // Turns an applicant into a client record (no login) so jobs, invoices and plans can be managed for them.
  add('POST', '/api/admin/joins/:id/add-client', { auth: A }, async (ctx) => {
    const id = v.id(ctx.params.id); const j = open(id);
    if (j.status === 'joined' && j.client_id) throw new HttpError(409, 'Already added as a client');
    const email = j.email || `join-${j.id}${NO_EMAIL}`;
    const planName = PLANS[j.plan] ? j.plan : null;
    let clientId;
    tx(() => {
      const existing = q("SELECT id,role FROM users WHERE email=?").get(email);
      if (existing && existing.role !== 'customer') throw new HttpError(409, 'That email belongs to a staff account. Edit the form email first.');
      if (existing) clientId = existing.id;
      else {
        clientId = Number(q(`INSERT INTO users(role,name,email,phone,area,address,pw_hash,created_at)
          VALUES('customer',?,?,?,?,?,'!',?)`).run(j.name, email, j.phone, j.area, j.address, now()).lastInsertRowid);
      }
      q(`UPDATE join_requests SET status='joined', client_id=?, ${ackSql}, updated_at=? WHERE id=?`).run(clientId, now(), ctx.user.id, now(), id);
    });
    let planNote = '';
    if (planName && !q('SELECT 1 FROM subscriptions WHERE user_id=? AND status<>\'ended\'').get(clientId)) {
      if (PLANS[planName].from) {
        q("DELETE FROM subscriptions WHERE user_id=? AND status='ended'").run(clientId);
        q("INSERT INTO subscriptions(user_id,plan,status,created_at,updated_at) VALUES(?,?,'pending',?,?)").run(clientId, planName, now(), now());
        planNote = 'Set the monthly price under Plans.';
      } else {
        startPlan(clientId, planName, PLANS[planName].cents);
        planNote = 'Plan started and first invoice created.';
      }
    }
    audit(ctx, 'join_added_client', 'join', id, `client ${clientId}${planName ? ', ' + planName : ''}`);
    return { client_id: clientId, note: planNote };
  });
};

module.exports.NO_EMAIL = NO_EMAIL;
