'use strict';
const { q, tx } = require('./db');
const { now, todaySAST } = require('./core');

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const label = (m) => `${MONTHS[Number(m.slice(5)) - 1]} ${m.slice(0, 4)}`;
const addDays = (iso, n) => new Date(new Date(iso + 'T00:00:00Z').getTime() + n * 86400e3).toISOString().slice(0, 10);

/** One invoice per customer per month. The unique index makes a second attempt do nothing. */
function invoiceFor(userId, plan, cents, month, due) {
  return q(`INSERT OR IGNORE INTO invoices(user_id,description,amount_cents,due_date,period,created_at) VALUES(?,?,?,?,?,?)`)
    .run(userId, `${plan}, ${label(month)}`, cents, due, month, now()).changes;
}

/** Activates a plan straight away and issues this month's first invoice (due in 7 days). */
function startPlan(userId, plan, cents) {
  const t = now(), today = todaySAST();
  tx(() => {
    if (q('SELECT 1 FROM subscriptions WHERE user_id=?').get(userId)) {
      q("UPDATE subscriptions SET plan=?, pending_plan=NULL, status='active', monthly_cents=?, updated_at=? WHERE user_id=?").run(plan, cents, t, userId);
    } else {
      q("INSERT INTO subscriptions(user_id,plan,status,monthly_cents,created_at,updated_at) VALUES(?,?,'active',?,?,?)").run(userId, plan, cents, t, t);
    }
    invoiceFor(userId, plan, cents, today.slice(0, 7), addDays(today, 7));
  });
}

/** Bills every active plan for the month. Safe to run any number of times. */
function runBilling(month) {
  const today = todaySAST();
  let due = `${month}-05`;
  if (due < today) due = addDays(today, 7);
  const subs = q("SELECT user_id,plan,monthly_cents FROM subscriptions WHERE status IN ('active','cancel_requested') AND monthly_cents > 0").all();
  let created = 0;
  tx(() => { for (const s of subs) created += invoiceFor(s.user_id, s.plan, s.monthly_cents, month, due); });
  return { created, skipped: subs.length - created };
}

module.exports = { invoiceFor, startPlan, runBilling, label, addDays };
