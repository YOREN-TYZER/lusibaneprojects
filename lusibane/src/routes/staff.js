'use strict';
const { q } = require('../db');
const { HttpError, bad, now, v, audit } = require('../core');

const STAFF = ['staff', 'admin'];
const NEXT = { assigned: 'on_the_way', on_the_way: 'done' };

const JOB_SQL = `SELECT b.id,b.service,b.date,b.notes,b.status,b.proof,b.area,b.crew_id,c.name AS crew_name,
    u.id AS user_id,u.name AS customer,u.phone,u.address
  FROM bookings b JOIN users u ON u.id=b.user_id LEFT JOIN users c ON c.id=b.crew_id`;

module.exports = (add) => {
  // Crew see only the jobs assigned to them. Admins see everything.
  add('GET', '/api/staff/jobs', { auth: STAFF }, async (ctx) => {
    const rows = ctx.user.role === 'admin'
      ? q(`${JOB_SQL} WHERE b.status<>'cancelled' ORDER BY (b.status='done'), b.date, b.id LIMIT 500`).all()
      : q(`${JOB_SQL} WHERE b.crew_id=? AND b.status<>'cancelled' ORDER BY (b.status='done'), b.date, b.id LIMIT 500`).all(ctx.user.id);
    return { jobs: rows };
  });

  add('POST', '/api/staff/jobs/:id/advance', { auth: STAFF }, async (ctx) => {
    const id = v.id(ctx.params.id);
    const job = q('SELECT id,status,crew_id FROM bookings WHERE id=?').get(id);
    if (!job || (ctx.user.role !== 'admin' && job.crew_id !== ctx.user.id)) throw new HttpError(404, 'Job not found');
    const next = NEXT[job.status];
    if (!next) throw new HttpError(409, job.status === 'booked' ? 'Assign a crew member to this job first' : 'This job cannot be moved on');
    let proof = '';
    if (next === 'done') proof = v.text(ctx.body.proof, 'Proof of service note', { min: 3, max: 300 });
    const r = q('UPDATE bookings SET status=?, proof=CASE WHEN ?<>\'\' THEN ? ELSE proof END, updated_at=? WHERE id=? AND status=?')
      .run(next, proof, proof, now(), id, job.status);
    if (r.changes === 0) throw new HttpError(409, 'This job was just updated by someone else. Refresh and try again.');
    audit(ctx, 'job_' + next, 'booking', id, proof);
    return { status: next };
  });
};
