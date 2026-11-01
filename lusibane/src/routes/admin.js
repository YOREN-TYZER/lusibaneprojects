'use strict';
const { q, tx } = require('../db');
const { HttpError, bad, now, todaySAST, SERVICES, PLANS, CONTRACT_KINDS, v, audit, invoiceNo } = require('../core');
const sec = require('../security');
const { runBilling, invoiceFor, addDays } = require('../billing');

const A = ['admin'];
const NO_EMAIL = '@no-email.invalid';
const shown = (e) => (String(e).endsWith(NO_EMAIL) ? '' : e);

module.exports = (add) => {
  // ----- overview -----
  add('GET', '/api/admin/summary', { auth: A }, async () => {
    const month = todaySAST().slice(0, 7);
    const c = (sql, ...p) => q(sql).get(...p).c;
    return {
      customers: c("SELECT COUNT(*) c FROM users WHERE role='customer'"),
      active_plans: c("SELECT COUNT(*) c FROM subscriptions WHERE status IN ('active','cancel_requested')"),
      plan_requests: c("SELECT COUNT(*) c FROM subscriptions WHERE status IN ('pending','cancel_requested') OR pending_plan IS NOT NULL"),
      monthly_cents: c("SELECT COALESCE(SUM(monthly_cents),0) c FROM subscriptions WHERE status IN ('active','cancel_requested')"),
      jobs_today: c("SELECT COUNT(*) c FROM bookings WHERE date=? AND status<>'cancelled'", todaySAST()),
      jobs_open: c("SELECT COUNT(*) c FROM bookings WHERE status IN ('booked','assigned','on_the_way')"),
      unassigned: c("SELECT COUNT(*) c FROM bookings WHERE status='booked'"),
      unpaid_cents: c("SELECT COALESCE(SUM(amount_cents),0) c FROM invoices WHERE status='unpaid'"),
      paid_month_cents: c("SELECT COALESCE(SUM(amount_cents),0) c FROM invoices WHERE status='paid' AND strftime('%Y-%m', paid_at, 'unixepoch', '+2 hours')=?", month),
      new_quotes: c("SELECT COUNT(*) c FROM quotes WHERE status='new'"),
      new_joins: c("SELECT COUNT(*) c FROM join_requests WHERE status='new'"),
      open_joins: c("SELECT COUNT(*) c FROM join_requests WHERE status IN ('new','acknowledged')"),
    };
  });

  // ----- customers -----
  add('GET', '/api/admin/customers', { auth: A }, async () => ({
    customers: q(`SELECT u.id,u.name,u.email,u.phone,u.area,u.status,u.created_at,u.last_login,
        s.plan,s.status AS plan_status,
        (SELECT COALESCE(SUM(amount_cents),0) FROM invoices i WHERE i.user_id=u.id AND i.status='unpaid') AS balance_cents
      FROM users u LEFT JOIN subscriptions s ON s.user_id=u.id WHERE u.role='customer' ORDER BY u.id DESC LIMIT 1000`).all()
      .map((c) => ({ ...c, email: shown(c.email) })),
  }));

  add('GET', '/api/admin/customers/:id', { auth: A }, async (ctx) => {
    const id = v.id(ctx.params.id);
    const user = q(`SELECT id,name,email,phone,area,address,status,created_at,last_login FROM users WHERE id=? AND role='customer'`).get(id);
    if (!user) throw new HttpError(404, 'Customer not found');
    user.email = shown(user.email);
    return {
      user,
      subscription: q('SELECT id,plan,pending_plan,status,monthly_cents FROM subscriptions WHERE user_id=?').get(id) || null,
      bookings: q('SELECT id,service,date,status,proof FROM bookings WHERE user_id=? ORDER BY date DESC,id DESC LIMIT 50').all(id),
      invoices: q('SELECT id,description,amount_cents,status,due_date FROM invoices WHERE user_id=? ORDER BY id DESC LIMIT 50').all(id)
        .map((r) => ({ ...r, number: invoiceNo(r.id) })),
    };
  });

  add('POST', '/api/admin/users/:id/status', { auth: A }, async (ctx) => {
    const id = v.id(ctx.params.id);
    const status = v.oneOf(ctx.body.status, ['active', 'disabled'], 'Status');
    if (id === ctx.user.id) throw bad('You cannot disable your own account');
    const r = q('UPDATE users SET status=? WHERE id=?').run(status, id);
    if (!r.changes) throw new HttpError(404, 'User not found');
    if (status === 'disabled') q('DELETE FROM sessions WHERE user_id=?').run(id);
    audit(ctx, 'user_' + status, 'user', id);
    return { ok: true };
  });

  add('POST', '/api/admin/users/:id/reset-code', { auth: A }, async (ctx) => {
    const id = v.id(ctx.params.id);
    const u = q("SELECT id,name FROM users WHERE id=? AND role IN ('staff','admin')").get(id);
    if (!u) throw new HttpError(404, 'User not found');
    const code = sec.resetCode();
    tx(() => {
      q('DELETE FROM reset_codes WHERE user_id=?').run(id);
      q('INSERT INTO reset_codes(user_id,code_hash,expires_at) VALUES(?,?,?)')
        .run(id, sec.sha256(code.replace('-', '')), now() + 2 * 3600);
      q('UPDATE users SET failed_logins=0, locked_until=0 WHERE id=?').run(id);
    });
    audit(ctx, 'reset_code_issued', 'user', id);
    return { code, expires_in_minutes: 120, name: u.name };
  });

  // ----- plans -----
  add('GET', '/api/admin/subscriptions', { auth: A }, async () => ({
    subscriptions: q(`SELECT s.id,s.plan,s.pending_plan,s.status,s.monthly_cents,s.updated_at,u.id AS user_id,u.name,u.phone,u.area
      FROM subscriptions s JOIN users u ON u.id=s.user_id
      ORDER BY CASE s.status WHEN 'pending' THEN 0 WHEN 'cancel_requested' THEN 1 ELSE 2 END, s.updated_at DESC LIMIT 1000`).all(),
  }));

  add('POST', '/api/admin/subscriptions/:id/decide', { auth: A }, async (ctx) => {
    const id = v.id(ctx.params.id);
    const action = v.oneOf(ctx.body.action, ['approve', 'decline', 'pause', 'resume', 'end', 'price'], 'Action');
    const s = q('SELECT * FROM subscriptions WHERE id=?').get(id);
    if (!s) throw new HttpError(404, 'Plan not found');
    const t = now();
    const price = v.rand(ctx.body.monthly_rand, 'Monthly price', { min: 1, max: 100000, optional: true });
    if (action === 'approve') {
      if (s.status === 'pending') {
        const cents = price ?? PLANS[s.plan].cents;
        q("UPDATE subscriptions SET status='active', monthly_cents=?, updated_at=? WHERE id=?").run(cents, t, id);
        invoiceFor(s.user_id, s.plan, cents, todaySAST().slice(0, 7), addDays(todaySAST(), 7));
      } else if (s.pending_plan) {
        q('UPDATE subscriptions SET plan=?, pending_plan=NULL, monthly_cents=?, updated_at=? WHERE id=?')
          .run(s.pending_plan, price ?? PLANS[s.pending_plan].cents, t, id);
      } else throw new HttpError(409, 'Nothing to approve');
    } else if (action === 'decline') {
      if (s.status === 'pending') q("UPDATE subscriptions SET status='ended', updated_at=? WHERE id=?").run(t, id);
      else if (s.pending_plan) q('UPDATE subscriptions SET pending_plan=NULL, updated_at=? WHERE id=?').run(t, id);
      else if (s.status === 'cancel_requested') q("UPDATE subscriptions SET status='active', updated_at=? WHERE id=?").run(t, id);
      else throw new HttpError(409, 'Nothing to decline');
    } else if (action === 'pause') {
      if (s.status !== 'active') throw new HttpError(409, 'Only active plans can be paused');
      q("UPDATE subscriptions SET status='paused', updated_at=? WHERE id=?").run(t, id);
    } else if (action === 'resume') {
      if (s.status !== 'paused') throw new HttpError(409, 'Only paused plans can be resumed');
      q("UPDATE subscriptions SET status='active', updated_at=? WHERE id=?").run(t, id);
    } else if (action === 'end') {
      q("UPDATE subscriptions SET status='ended', pending_plan=NULL, updated_at=? WHERE id=?").run(t, id);
    } else if (action === 'price') {
      if (price == null) throw bad('Enter the monthly price');
      q('UPDATE subscriptions SET monthly_cents=?, updated_at=? WHERE id=?').run(price, t, id);
    }
    audit(ctx, 'plan_' + action, 'subscription', id, price ? `R${price / 100}` : '');
    return { ok: true };
  });

  // ----- jobs -----
  add('GET', '/api/admin/crew', { auth: A }, async () => ({
    crew: q("SELECT id,name FROM users WHERE role IN ('staff','admin') AND status='active' ORDER BY name").all(),
  }));

  add('POST', '/api/admin/jobs', { auth: A }, async (ctx) => {
    const uid = v.id(ctx.body.user_id);
    const cust = q("SELECT id,area FROM users WHERE id=? AND role='customer' AND status='active'").get(uid);
    if (!cust) throw bad('Choose an active customer');
    const service = v.oneOf(ctx.body.service, SERVICES, 'Service');
    const date = v.date(ctx.body.date, 'Date');
    const notes = v.text(ctx.body.notes, 'Notes', { max: 500, multiline: true, optional: true });
    const r = q('INSERT INTO bookings(user_id,service,date,notes,area,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
      .run(uid, service, date, notes, cust.area, now(), now());
    audit(ctx, 'job_create', 'booking', Number(r.lastInsertRowid), `${service} ${date}`);
    ctx.status = 201;
    return { id: Number(r.lastInsertRowid) };
  });

  add('POST', '/api/admin/jobs/:id/assign', { auth: A }, async (ctx) => {
    const id = v.id(ctx.params.id);
    const crewId = v.id(ctx.body.crew_id);
    const crew = q("SELECT id FROM users WHERE id=? AND role IN ('staff','admin') AND status='active'").get(crewId);
    if (!crew) throw bad('Choose an active crew member');
    const r = q(`UPDATE bookings SET crew_id=?, status=CASE WHEN status='booked' THEN 'assigned' ELSE status END, updated_at=?
                 WHERE id=? AND status IN ('booked','assigned','on_the_way')`).run(crewId, now(), id);
    if (!r.changes) throw new HttpError(409, 'This job can no longer be assigned');
    audit(ctx, 'job_assign', 'booking', id, 'crew ' + crewId);
    return { ok: true };
  });

  add('POST', '/api/admin/jobs/:id/cancel', { auth: A }, async (ctx) => {
    const id = v.id(ctx.params.id);
    const r = q("UPDATE bookings SET status='cancelled', updated_at=? WHERE id=? AND status IN ('booked','assigned','on_the_way')").run(now(), id);
    if (!r.changes) throw new HttpError(409, 'This job cannot be cancelled');
    audit(ctx, 'job_cancel', 'booking', id);
    return { ok: true };
  });

  // ----- invoices -----
  add('GET', '/api/admin/invoices', { auth: A }, async () => ({
    invoices: q(`SELECT i.id,i.description,i.amount_cents,i.due_date,i.status,i.method,i.paid_at,u.id AS user_id,u.name
      FROM invoices i JOIN users u ON u.id=i.user_id ORDER BY (i.status='unpaid') DESC, i.id DESC LIMIT 1000`).all()
      .map((r) => ({ ...r, number: invoiceNo(r.id) })),
  }));

  add('POST', '/api/admin/invoices', { auth: A }, async (ctx) => {
    const uid = v.id(ctx.body.user_id);
    if (!q("SELECT 1 FROM users WHERE id=? AND role='customer'").get(uid)) throw bad('Choose a customer');
    const description = v.text(ctx.body.description, 'Description', { max: 200 });
    const cents = v.rand(ctx.body.amount_rand, 'Amount');
    const due = v.date(ctx.body.due_date, 'Due date');
    const r = q('INSERT INTO invoices(user_id,description,amount_cents,due_date,created_at) VALUES(?,?,?,?,?)')
      .run(uid, description, cents, due, now());
    audit(ctx, 'invoice_create', 'invoice', Number(r.lastInsertRowid), `R${cents / 100}`);
    ctx.status = 201;
    return { id: Number(r.lastInsertRowid) };
  });

  add('POST', '/api/admin/invoices/:id/pay', { auth: A }, async (ctx) => {
    const id = v.id(ctx.params.id);
    const method = v.oneOf(ctx.body.method, ['EFT', 'Cash', 'Other'], 'Payment method');
    const r = q("UPDATE invoices SET status='paid', method=?, paid_at=? WHERE id=? AND status='unpaid'").run(method, now(), id);
    if (!r.changes) throw new HttpError(409, 'Only unpaid invoices can be marked as paid');
    audit(ctx, 'invoice_paid', 'invoice', id, method);
    return { ok: true };
  });

  add('POST', '/api/admin/invoices/:id/void', { auth: A }, async (ctx) => {
    const id = v.id(ctx.params.id);
    const r = q("UPDATE invoices SET status='void' WHERE id=? AND status='unpaid'").run(id);
    if (!r.changes) throw new HttpError(409, 'Only unpaid invoices can be voided');
    audit(ctx, 'invoice_void', 'invoice', id);
    return { ok: true };
  });

  // One invoice per active plan per month. Safe to press twice: duplicates are blocked by a unique index.
  add('POST', '/api/admin/billing/run', { auth: A }, async (ctx) => {
    const month = v.text(ctx.body.month, 'Month', { max: 7 });
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw bad('Month must look like 2026-11');
    const r = runBilling(month);
    audit(ctx, 'billing_run', 'invoice', null, `${month}: ${r.created} created`);
    return r;
  });

  // ----- quotes inbox -----
  add('GET', '/api/admin/quotes', { auth: A }, async () => ({
    quotes: q('SELECT id,user_id,name,phone,area,service,details,status,created_at FROM quotes ORDER BY (status=\'new\') DESC, id DESC LIMIT 500').all(),
  }));
  add('POST', '/api/admin/quotes/:id/status', { auth: A }, async (ctx) => {
    const id = v.id(ctx.params.id);
    const status = v.oneOf(ctx.body.status, ['new', 'contacted', 'won', 'lost'], 'Status');
    if (!q('UPDATE quotes SET status=? WHERE id=?').run(status, id).changes) throw new HttpError(404, 'Quote not found');
    audit(ctx, 'quote_' + status, 'quote', id);
    return { ok: true };
  });

  // ----- contracts -----
  add('GET', '/api/admin/contracts', { auth: A }, async () => ({
    contracts: q(`SELECT c.id,c.kind,c.start_date,c.status,u.id AS user_id,u.name FROM contracts c JOIN users u ON u.id=c.user_id ORDER BY c.id DESC LIMIT 500`).all(),
    kinds: CONTRACT_KINDS,
  }));
  add('POST', '/api/admin/contracts', { auth: A }, async (ctx) => {
    const uid = v.id(ctx.body.user_id);
    if (!q("SELECT 1 FROM users WHERE id=? AND role='customer'").get(uid)) throw bad('Choose a customer');
    const kind = v.oneOf(ctx.body.kind, CONTRACT_KINDS, 'Type');
    const start = v.date(ctx.body.start_date, 'Start date');
    const r = q('INSERT INTO contracts(user_id,kind,start_date,created_at) VALUES(?,?,?,?)').run(uid, kind, start, now());
    audit(ctx, 'contract_create', 'contract', Number(r.lastInsertRowid), kind);
    ctx.status = 201;
    return { id: Number(r.lastInsertRowid) };
  });
  add('POST', '/api/admin/contracts/:id/toggle', { auth: A }, async (ctx) => {
    const id = v.id(ctx.params.id);
    const r = q("UPDATE contracts SET status=CASE status WHEN 'active' THEN 'ended' ELSE 'active' END WHERE id=?").run(id);
    if (!r.changes) throw new HttpError(404, 'Contract not found');
    audit(ctx, 'contract_toggle', 'contract', id);
    return { ok: true };
  });

  // ----- tenders -----
  add('GET', '/api/admin/tenders', { auth: A }, async () => ({
    tenders: q('SELECT id,title,client,closing_date,value_cents,stage FROM tenders ORDER BY closing_date LIMIT 500').all(),
  }));
  add('POST', '/api/admin/tenders', { auth: A }, async (ctx) => {
    const title = v.text(ctx.body.title, 'Tender', { max: 200 });
    const client = v.text(ctx.body.client, 'Client', { max: 150 });
    const due = v.date(ctx.body.closing_date, 'Closing date');
    const cents = v.rand(ctx.body.value_rand, 'Value', { min: 0, max: 1e9, optional: true }) || 0;
    const r = q('INSERT INTO tenders(title,client,closing_date,value_cents,created_at) VALUES(?,?,?,?,?)').run(title, client, due, cents, now());
    audit(ctx, 'tender_create', 'tender', Number(r.lastInsertRowid), title);
    ctx.status = 201;
    return { id: Number(r.lastInsertRowid) };
  });
  add('POST', '/api/admin/tenders/:id/stage', { auth: A }, async (ctx) => {
    const id = v.id(ctx.params.id);
    const stage = v.oneOf(ctx.body.stage, ['spotted', 'preparing', 'submitted', 'won', 'lost'], 'Stage');
    if (!q('UPDATE tenders SET stage=? WHERE id=?').run(stage, id).changes) throw new HttpError(404, 'Tender not found');
    audit(ctx, 'tender_stage', 'tender', id, stage);
    return { ok: true };
  });

  // ----- staff accounts -----
  add('GET', '/api/admin/staff', { auth: A }, async () => ({
    staff: q("SELECT id,name,email,phone,role,status,last_login FROM users WHERE role IN ('staff','admin') ORDER BY role,name").all(),
  }));
  add('POST', '/api/admin/staff', { auth: A }, async (ctx) => {
    const name = v.text(ctx.body.name, 'Name', { min: 2, max: 100 });
    const email = v.email(ctx.body.email);
    const phone = v.phone(ctx.body.phone);
    const problem = sec.passwordProblem(ctx.body.password, email);
    if (problem) throw bad(problem.replace('Password', 'Temporary password'));
    if (q('SELECT 1 FROM users WHERE email=?').get(email)) throw new HttpError(409, 'That email is already in use');
    const pw = await sec.hashPassword(ctx.body.password);
    const r = q("INSERT INTO users(role,name,email,phone,pw_hash,must_change_pw,created_at) VALUES('staff',?,?,?,?,1,?)")
      .run(name, email, phone, pw, now());
    audit(ctx, 'staff_create', 'user', Number(r.lastInsertRowid), email);
    ctx.status = 201;
    return { id: Number(r.lastInsertRowid) };
  });

  // ----- audit trail -----
  add('GET', '/api/admin/audit', { auth: A }, async () => ({
    audit: q(`SELECT a.id,a.ts,a.action,a.entity,a.entity_id,a.detail,a.ip,u.name AS actor
      FROM audit a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.id DESC LIMIT 300`).all(),
  }));
};
