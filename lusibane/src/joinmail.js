'use strict';
// Emails a joining form to the company inbox and records whether it worked.
// The form is always saved in the database first, so a mail problem never loses a request.
const cfg = require('./config');
const { q } = require('./db');
const { now } = require('./core');
const mail = require('./mail');

function body(j) {
  const L = (k, v) => `${k.padEnd(18)}${v || '-'}`;
  return [
    'A new joining form was submitted on the Lusibane website.',
    '',
    L('Name:', j.name),
    L('Phone / WhatsApp:', j.phone),
    L('Email:', j.email),
    L('Area or street:', j.area),
    L('Address:', j.address),
    L('Joining:', j.plan),
    L('Prefers contact by:', j.contact_pref),
    L('Best time:', j.best_time),
    '',
    'Notes:',
    j.details || '-',
    '',
    `Received: ${new Date(j.created_at * 1000).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg' })} (SAST)`,
    `Reference: JOIN-${String(j.id).padStart(5, '0')}`,
    '',
    'The same request is waiting in the staff console under "Join requests".',
    'Open it there and press Acknowledge so the team knows it has been seen, then contact the applicant.',
  ].join('\n');
}

/** Sends (or re-sends) the email for one request and stores the outcome. Never throws. */
async function sendJoinEmail(id) {
  const j = q('SELECT * FROM join_requests WHERE id=?').get(id);
  if (!j) return 'missing';
  if (!mail.configured() || !cfg.mailFrom) {
    q("UPDATE join_requests SET email_status='not_configured', email_error='Email is not set up on the server yet (SMTP settings missing)', updated_at=? WHERE id=?").run(now(), id);
    return 'not_configured';
  }
  try {
    await mail.send({
      from: `"Lusibane Website" <${cfg.mailFrom}>`,
      to: cfg.mailTo,
      replyTo: j.email || undefined,
      subject: `New joining form: ${j.name}${j.plan ? ' (' + j.plan + ')' : ''}`,
      text: body(j),
    });
    q("UPDATE join_requests SET email_status='sent', email_error='', email_tries=email_tries+1, updated_at=? WHERE id=?").run(now(), id);
    return 'sent';
  } catch (e) {
    const msg = String(e && e.message ? e.message : e).slice(0, 300);
    console.error('[join email]', id, msg);
    q("UPDATE join_requests SET email_status='failed', email_error=?, email_tries=email_tries+1, updated_at=? WHERE id=?").run(msg, now(), id);
    return 'failed';
  }
}

/** Hourly: try again for forms whose email failed (at most 5 times, for 3 days). */
async function retryFailed() {
  if (!mail.configured()) return;
  const rows = q("SELECT id FROM join_requests WHERE email_status IN ('failed','not_configured') AND email_tries<5 AND created_at>? ORDER BY id LIMIT 20")
    .all(now() - 3 * 86400);
  for (const r of rows) await sendJoinEmail(r.id);
}

module.exports = { sendJoinEmail, retryFailed, body };
