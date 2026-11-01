(function () {
  'use strict';
  // Everything on screen is built with createElement/textContent. Server data is never parsed as HTML.
  const $ = (id) => document.getElementById(id);
  const WA = '27815786526';
  const S = { user: null, csrf: '', config: { services: [], plans: [] }, mode: 'login', tab: '', token: 0, detail: 0, loaded: false };
  let root;
  const ABORT = new Error('aborted');

  function h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (v === true) e.setAttribute(k, '');
      else e.setAttribute(k, v);
    }
    for (const kid of kids.flat(Infinity)) {
      if (kid == null || kid === false) continue;
      e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return e;
  }

  // ---------- formatting ----------
  const R = (c) => 'R' + (c / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const fmtDate = (iso) => new Date(iso + 'T00:00:00').toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: 'numeric' });
  const fmtTs = (t) => (t ? new Date(t * 1000).toLocaleString('en-ZA', { dateStyle: 'medium', timeStyle: 'short' }) : '—');
  const today = () => new Date(Date.now() + 2 * 3600e3).toISOString().slice(0, 10);
  const STATUS = { booked: 'Booked', assigned: 'Assigned', on_the_way: 'On the way', done: 'Done', cancelled: 'Cancelled',
    unpaid: 'Unpaid', paid: 'Paid', void: 'Void', pending: 'Awaiting confirmation', active: 'Active', paused: 'Paused',
    cancel_requested: 'Cancellation requested', ended: 'Ended', new: 'New', contacted: 'Contacted', won: 'Won', lost: 'Lost',
    disabled: 'Disabled', acknowledged: 'Acknowledged', joined: 'Joined', declined: 'Declined' };
  const pill = (s) => h('span', { class: 'pill ' + s }, STATUS[s] || s);
  const roleLabel = (r) => ({ staff: 'Crew', admin: 'Admin' }[r] || r);
  const NO_EMAIL = '@no-email.invalid';
  function waPhone(p) {
    p = String(p || '').replace(/[^\d+]/g, '');
    if (p.startsWith('+')) return p.slice(1);
    if (p.startsWith('00')) return p.slice(2);
    if (p.startsWith('0')) return '27' + p.slice(1);
    return p;
  }
  const waLink = (phone, text) => 'https://wa.me/' + waPhone(phone) + '?text=' + encodeURIComponent(text);

  // ---------- api ----------
  async function api(method, url, body) {
    let r;
    try {
      r = await fetch(url, {
        method, credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', ...(S.csrf ? { 'X-CSRF-Token': S.csrf } : {}) },
        body: method === 'GET' ? undefined : JSON.stringify(body || {}),
      });
    } catch { throw new Error('Cannot reach the server. Check your connection and try again.'); }
    let j = null; try { j = await r.json(); } catch { /* empty */ }
    if (!r.ok) {
      if (r.status === 401 && S.user && !url.startsWith('/api/auth/')) { expire(); throw new Error('Your session expired. Please log in again.'); }
      const err = new Error((j && j.error) || 'Something went wrong. Please try again.');
      err.status = r.status; throw err;
    }
    return j || {};
  }
  function expire() { S.user = null; S.csrf = ''; S.mode = 'login'; shell(); flash('Your session expired. Please log in again.', false); }
  function flash(msg, good) {
    const el = $('pflash'); if (!el) return;
    el.textContent = msg || '';
    el.className = 'flash' + (msg ? ' show ' + (good ? 'good' : 'bad') : '');
    if (msg) root.scrollTo({ top: 0 });
  }

  // ---------- form + table helpers ----------
  function field(f) {
    let input;
    if (f.type === 'select') {
      input = h('select', { name: f.name, required: f.required !== false },
        f.options.map((o) => { const [v, l] = Array.isArray(o) ? o : [o, o]; return h('option', { value: v, selected: String(v) === String(f.value) }, l); }));
    } else if (f.type === 'textarea') {
      input = h('textarea', { name: f.name, rows: 3, maxlength: f.max, placeholder: f.placeholder, required: f.required !== false }, f.value || '');
    } else {
      input = h('input', { name: f.name, type: f.type || 'text', value: f.value, required: f.required !== false, placeholder: f.placeholder,
        autocomplete: f.auto, min: f.min, max: f.maxv, maxlength: f.max, minlength: f.minlength, step: f.step });
    }
    return h('label', { class: f.wide ? 'wide' : '' }, f.label, input);
  }
  function form(fields, label, onSubmit, opts = {}) {
    const btn = h('button', { class: 'b', type: 'submit' }, label);
    const f = h('form', { class: 'f' + (opts.stack ? ' stack' : ''), onsubmit: async (e) => {
      e.preventDefault();
      const data = {}; new FormData(f).forEach((v, k) => { data[k] = v; });
      btn.disabled = true; flash('');
      try { await onSubmit(data, f); } catch (err) { flash(err.message, false); } finally { btn.disabled = false; }
    } }, fields.map(field), btn);
    return f;
  }
  function table(heads, rows, empty) {
    if (!rows.length) return h('p', { class: 'em' }, empty || 'Nothing here yet.');
    return h('div', { class: 'sc' }, h('table', {}, h('thead', {}, h('tr', {}, heads.map((x) => h('th', {}, x)))),
      h('tbody', {}, rows.map((r) => h('tr', {}, r.map((c) => h('td', {}, c)))))));
  }
  const reload = () => loadView();
  function btn(label, fn, cls = 'b2') {
    const b = h('button', { class: cls, type: 'button' }, label);
    b.addEventListener('click', async () => {
      b.disabled = true;
      try { await fn(); b.disabled = false; } catch (e) { if (e !== ABORT) flash(e.message, false); b.disabled = false; }
    });
    return b;
  }
  const stat = (big, label) => h('div', { class: 'card' }, h('div', { class: 'big' }, big), h('p', {}, label));
  const sel = (opts, value) => h('select', {}, opts.map((o) => { const [v, l] = Array.isArray(o) ? o : [o, o]; return h('option', { value: v, selected: String(v) === String(value) }, l); }));

  // ---------- shell ----------
  const TABS = {
    staff: [['jobs', 'My jobs'], ['routes', 'Routes'], ['profile', 'Profile']],
    admin: [['joins', 'Join requests'], ['overview', 'Overview'], ['jobs', 'Jobs'], ['routes', 'Routes'], ['customers', 'Clients'], ['plans', 'Plans'], ['invoices', 'Invoices'],
      ['quotes', 'Quotes'], ['contracts', 'Contracts'], ['tenders', 'Tenders'], ['team', 'Team'], ['audit', 'Audit log'], ['profile', 'Profile']],
  };
  function go(tab) { S.tab = tab; S.detail = 0; shell(); }

  function shell() {
    const u = S.user;
    root.replaceChildren();
    root.classList.toggle('adm', !!u);
    const tabs = u && !u.must_change_pw ? TABS[u.role] : null;
    root.append(
      h('div', { class: 'ptop' }, h('div', { class: 'pin' },
        h('div', { class: 'brand' }, 'Lusibane One',
          h('small', {}, u ? `${u.name} · ${roleLabel(u.role)}` : 'Staff sign-in'),
          u ? h('button', { class: 'b2 x', type: 'button', onclick: logout }, 'Log out') : null,
          h('a', { class: 'b2 ' + (u ? 'bk' : 'x'), href: '/' }, 'Back to website')),
        tabs ? h('div', { class: 'ws', role: 'tablist' }, tabs.map(([k, l]) =>
          h('button', { type: 'button', 'aria-pressed': String(S.tab === k), onclick: () => go(k) }, l))) : null)),
      h('div', { class: 'ptape' }),
      h('div', { id: 'pflash', class: 'flash', role: 'alert' }),
      h('main', { id: 'pmain' }));
    loadView();
    if (u && u.role === 'admin' && !u.must_change_pw) badge();
  }
  // little count on the Join requests tab so new forms are impossible to miss
  async function badge() {
    try {
      const s = await api('GET', '/api/admin/summary');
      const b = root.querySelector('.ws button'); if (!b || !s.new_joins) return;
      b.append(h('span', { class: 'cnt', 'aria-label': `${s.new_joins} new` }, s.new_joins));
    } catch { /* not important */ }
  }

  async function loadView() {
    const token = ++S.token;
    const main = $('pmain'); if (!main) return;
    main.replaceChildren(h('p', { class: 'em' }, 'Loading…'));
    try {
      let node;
      if (!S.user) node = authView();
      else if (S.user.must_change_pw) node = forcePwView();
      else node = await VIEWS[S.user.role][S.tab]();
      if (token !== S.token) return;
      main.replaceChildren(node);
      const first = main.querySelector('input,select,textarea');
      if (!S.user && first) first.focus();
    } catch (e) {
      if (token !== S.token) return;
      main.replaceChildren();
      flash(e.message, false);
    }
  }

  // ---------- start / sign in ----------
  async function start() {
    root.hidden = false;
    try {
      const s = await api('GET', '/api/session');
      S.user = s.user; S.csrf = s.csrf || ''; S.config = s.config; S.loaded = true;
    } catch (e) { /* shown below */ }
    if (S.user) S.tab = TABS[S.user.role][0][0];
    shell();
    if (!S.loaded) flash('Cannot reach the server. Please try again shortly.', false);
  }
  async function logout() {
    try { await api('POST', '/api/auth/logout'); } catch { /* ignore */ }
    S.user = null; S.csrf = ''; S.mode = 'login'; S.tab = '';
    shell();
  }
  function signedIn(res) {
    S.user = res.user; S.csrf = res.csrf; S.tab = TABS[res.user.role][0][0];
    shell();
  }

  function authView() {
    if (S.mode === 'reset') return resetView();
    return h('div', {},
      h('h2', {}, 'Staff sign-in'),
      h('p', { class: 'tab-hint' }, 'Crew and admin accounts are created by the Lusibane administrator. Customers do not need an account: they join with the form on the website.'),
      form([
        { name: 'email', label: 'Email', type: 'email', auto: 'username', max: 254 },
        { name: 'password', label: 'Password', type: 'password', auto: 'current-password', max: 200 },
      ], 'Log in', async (d) => { signedIn(await api('POST', '/api/auth/login', d)); }),
      h('p', { class: 'note' }, h('button', { class: 'link', type: 'button', onclick: () => { S.mode = 'reset'; shell(); } }, 'Forgot your password?')));
  }
  function resetView() {
    return h('div', {},
      h('h2', {}, 'Reset your password'),
      h('p', { class: 'tab-hint' }, 'Ask the administrator for a one-time reset code, then enter it below.'),
      form([
        { name: 'email', label: 'Account email', type: 'email', auto: 'username' },
        { name: 'code', label: 'Reset code', placeholder: 'ABCDE-12345', max: 20 },
        { name: 'new_password', label: 'New password (10+ characters)', type: 'password', auto: 'new-password', minlength: 10 },
      ], 'Set new password', async (d) => { await api('POST', '/api/auth/reset', d); S.mode = 'login'; shell(); flash('Password updated. Please log in.', true); }),
      h('p', { class: 'note' }, h('button', { class: 'link', type: 'button', onclick: () => { S.mode = 'login'; shell(); } }, 'Back to log in')));
  }
  function forcePwView() {
    return h('div', {}, h('h2', {}, 'Choose a new password'),
      h('p', { class: 'tab-hint' }, 'Your account was set up with a temporary password. Choose your own to continue.'),
      form([
        { name: 'current', label: 'Temporary password', type: 'password', auto: 'current-password' },
        { name: 'new_password', label: 'New password (10+ characters)', type: 'password', auto: 'new-password', minlength: 10 },
      ], 'Save password', async (d) => { await api('POST', '/api/me/password', d); S.user.must_change_pw = false; S.tab = TABS[S.user.role][0][0]; shell(); flash('Password saved.', true); }, { stack: true }));
  }

  function profileView() {
    const u = S.user;
    return h('div', {}, h('h2', {}, 'Profile'),
      form([
        { name: 'name', label: 'Full name', value: u.name, max: 100 },
        { name: 'phone', label: 'Phone / WhatsApp', type: 'tel', value: u.phone, max: 25 },
        { name: 'area', label: 'Area or street', value: u.area, required: false, max: 120 },
        { name: 'address', label: 'Address', value: u.address, required: false, max: 200 },
      ], 'Save details', async (d) => { const r = await api('PATCH', '/api/me', d); S.user = { ...S.user, ...r.user }; flash('Details saved.', true); }),
      h('p', { class: 'note' }, 'Email: ' + u.email),
      h('h3', { style: 'margin-top:24px' }, 'Change password'),
      form([
        { name: 'current', label: 'Current password', type: 'password', auto: 'current-password' },
        { name: 'new_password', label: 'New password (10+ characters)', type: 'password', auto: 'new-password', minlength: 10 },
      ], 'Change password', async (d, f) => { await api('POST', '/api/me/password', d); f.reset(); flash('Password changed. Other devices were logged out.', true); }));
  }

  // ---------- staff + admin: jobs ----------
  const VIEWS = { staff: {}, admin: {} };
  const T = VIEWS.staff, A = VIEWS.admin;
  T.profile = A.profile = async () => profileView();

  function proofCell(job) {
    const cell = h('div', { class: 'acts' });
    const start = () => {
      cell.replaceChildren(btn('Mark done', () => {
        const input = h('input', { placeholder: 'What was done?', maxlength: '300', 'aria-label': 'Proof of service note' });
        cell.replaceChildren(input,
          btn('Save', async () => {
            await api('POST', `/api/staff/jobs/${job.id}/advance`, { proof: input.value });
            flash('Job completed and your note was saved.', true); reload();
          }, 'b'),
          btn('Back', async () => start()));
        input.focus();
        return Promise.resolve();
      }, 'b'));
    };
    if (job.status === 'assigned') {
      cell.append(btn('Start trip', async () => { await api('POST', `/api/staff/jobs/${job.id}/advance`, {}); flash('Trip started.', true); reload(); }, 'b'));
    } else if (job.status === 'on_the_way') start();
    return cell;
  }

  function jobsTable(jobs, admin, crew) {
    return table(['Date', 'Client', 'Service', 'Status', admin ? 'Crew' : 'Where', 'Action'], jobs.map((j) => {
      const who = h('span', {}, j.customer, h('span', { class: 'small' }, h('a', { class: 'link', href: 'tel:' + j.phone }, j.phone)));
      const where = h('span', {}, j.address || j.area || '—');
      const acts = h('div', { class: 'acts' });
      if (j.status === 'done') acts.append(h('span', { class: 'small' }, j.proof || ''));
      else {
        if (!admin || j.crew_id) acts.append(proofCell(j));
        if (admin && ['booked', 'assigned', 'on_the_way'].includes(j.status)) {
          const pick = sel([['', 'Assign crew…'], ...crew.map((c) => [c.id, c.name])], j.crew_id || '');
          acts.append(pick, btn('Assign', async () => {
            if (!pick.value) throw new Error('Choose a crew member first');
            await api('POST', `/api/admin/jobs/${j.id}/assign`, { crew_id: Number(pick.value) }); flash('Crew assigned.', true); reload();
          }), btn('Cancel job', async () => {
            if (!confirm('Cancel this job?')) throw ABORT;
            await api('POST', `/api/admin/jobs/${j.id}/cancel`); flash('Job cancelled.', true); reload();
          }, 'b2 danger'));
        }
      }
      return [fmtDate(j.date), who, h('span', {}, j.service, j.notes ? h('span', { class: 'small' }, j.notes) : null), pill(j.status),
        admin ? (j.crew_name || '—') : where, acts];
    }), 'No jobs to show.');
  }

  T.jobs = async () => {
    const { jobs } = await api('GET', '/api/staff/jobs');
    return h('div', {}, h('h2', {}, 'My jobs'), h('p', { class: 'tab-hint' }, 'Start the trip when you leave, then mark the job done with a short note of what was done.'), jobsTable(jobs, false, []));
  };

  A.jobs = async () => {
    const [{ jobs }, { crew }, { customers }] = await Promise.all([api('GET', '/api/staff/jobs'), api('GET', '/api/admin/crew'), api('GET', '/api/admin/customers')]);
    const active = customers.filter((c) => c.status === 'active');
    return h('div', {}, h('h2', {}, 'Jobs'),
      h('div', { class: 'card' }, h('h3', {}, 'Add a job for a client'),
        active.length ? form([
          { name: 'user_id', label: 'Client', type: 'select', options: active.map((c) => [c.id, `${c.name} (${c.area || c.phone})`]) },
          { name: 'service', label: 'Service', type: 'select', options: S.config.services },
          { name: 'date', label: 'Date', type: 'date', value: today(), min: today() },
          { name: 'notes', label: 'Notes', required: false, max: 500 },
        ], 'Add job', async (d) => { await api('POST', '/api/admin/jobs', { ...d, user_id: Number(d.user_id) }); flash('Job added.', true); reload(); }) : h('p', { class: 'em' }, 'No clients yet. Add one from Join requests.')),
      jobsTable(jobs, true, crew));
  };

  function routeGroups(jobs) {
    const open = jobs.filter((j) => ['booked', 'assigned', 'on_the_way'].includes(j.status));
    const byDate = {};
    for (const j of open) ((byDate[j.date] = byDate[j.date] || {})[j.area || 'No area given'] = (byDate[j.date] && byDate[j.date][j.area || 'No area given']) || []).push(j);
    return h('div', {}, Object.keys(byDate).sort().map((d) => h('div', { class: 'card' }, h('div', { class: 'grp' }, fmtDate(d) + (d === today() ? ' (today)' : '')),
      Object.keys(byDate[d]).sort().map((area) => h('div', {}, h('h3', {}, area),
        h('ol', {}, byDate[d][area].map((j) => h('li', {}, `${j.customer}, ${j.service}`, ' ', pill(j.status), h('span', { class: 'small' }, `${j.address || ''} ${j.phone}`.trim())))))))),
      open.length ? null : h('p', { class: 'em' }, 'No open jobs to route.'));
  }
  T.routes = async () => h('div', {}, h('h2', {}, 'Routes'), h('p', { class: 'tab-hint' }, 'Your open jobs grouped by day and area so you can plan the drive.'), routeGroups((await api('GET', '/api/staff/jobs')).jobs));
  A.routes = async () => h('div', {}, h('h2', {}, 'Routes'), h('p', { class: 'tab-hint' }, 'All open jobs grouped by day and area.'), routeGroups((await api('GET', '/api/staff/jobs')).jobs));

  // ---------- admin ----------
  // ---------- admin: join requests (the inbox) ----------
  const emailLine = (j, refresh) => {
    const out = h('div', { class: 'em-line' });
    if (j.email_status === 'sent') out.append(h('span', { class: 'pill em-ok' }, 'Also emailed to info@'));
    else if (j.email_status === 'pending') out.append(h('span', { class: 'pill em-wait' }, 'Email sending…'));
    else {
      out.append(h('span', { class: 'pill ' + (j.email_status === 'failed' ? 'em-bad' : 'em-wait') }, j.email_status === 'failed' ? 'Email to info@ failed' : 'Email not set up'),
        h('span', { class: 'small' }, j.email_error || ''),
        btn('Try email again', async () => {
          const r = await api('POST', `/api/admin/joins/${j.id}/resend-email`);
          flash(r.result === 'sent' ? 'Email sent.' : r.result === 'not_configured' ? 'Email is not set up on the server yet.' : 'Email still failing. See the note on the form.', r.result === 'sent');
          refresh();
        }));
    }
    return out;
  };

  A.joins = async () => {
    const { joins } = await api('GET', '/api/admin/joins');
    const FILTERS = [['open', 'To deal with', (j) => j.status === 'new' || j.status === 'acknowledged'], ['contacted', 'Contacted', (j) => j.status === 'contacted'],
      ['done', 'Joined / declined', (j) => j.status === 'joined' || j.status === 'declined'], ['all', 'All', () => true]];
    S.joinFilter = S.joinFilter || 'open';
    const f = FILTERS.find((x) => x[0] === S.joinFilter) || FILTERS[0];
    const list = joins.filter(f[2]);
    const fresh = joins.filter((j) => j.status === 'new').length;
    const card = (j) => {
      const acts = h('div', { class: 'acts' });
      const set = (status, ok, cls) => (label) => btn(label, async () => {
        await api('POST', `/api/admin/joins/${j.id}/status`, { status }); flash(ok, true); reload();
      }, cls);
      if (j.status === 'new') acts.append(btn('Acknowledge', async () => { await api('POST', `/api/admin/joins/${j.id}/acknowledge`); flash('Acknowledged. Now contact them.', true); reload(); }, 'b'));
      if (j.status === 'new' || j.status === 'acknowledged') acts.append(set('contacted', 'Marked as contacted.')('I have contacted them'));
      if (j.status !== 'joined') acts.append(btn('Add as client', async () => {
        if (!confirm(`Add ${j.name} as a client${/^Lusibane /.test(j.plan) ? ' on ' + j.plan : ''}?`)) throw ABORT;
        const r = await api('POST', `/api/admin/joins/${j.id}/add-client`); flash('Added as a client. ' + (r.note || ''), true); reload();
      }, j.status === 'contacted' ? 'b' : 'b2'));
      if (j.status === 'new' || j.status === 'acknowledged' || j.status === 'contacted') acts.append(btn('Decline', async () => {
        if (!confirm('Decline this joining form?')) throw ABORT;
        await api('POST', `/api/admin/joins/${j.id}/status`, { status: 'declined' }); flash('Declined.', true); reload();
      }, 'b2 danger'));
      if (j.status === 'declined') acts.append(set('acknowledged', 'Reopened.')('Reopen'));
      if (j.status === 'joined' && j.client_id) acts.append(btn('Open client', () => { S.detail = j.client_id; go('customers'); return Promise.resolve(); }));
      return h('div', { class: 'card join ' + j.status },
        h('div', { class: 'jh' }, h('h3', {}, j.name), pill(j.status), h('span', { class: 'small' }, `${j.reference} · received ${fmtTs(j.created_at)}`)),
        h('dl', { class: 'kv' },
          h('dt', {}, 'Phone'), h('dd', {}, h('a', { class: 'link', href: 'tel:' + j.phone }, j.phone), ' ',
            h('a', { class: 'link', target: '_blank', rel: 'noopener', href: waLink(j.phone, `Hello ${j.name}, this is Lusibane. Thank you for your joining form (${j.reference}).`) }, 'WhatsApp')),
          h('dt', {}, 'Email'), h('dd', {}, j.email ? h('a', { class: 'link', href: 'mailto:' + j.email }, j.email) : '—'),
          h('dt', {}, 'Area'), h('dd', {}, j.area),
          h('dt', {}, 'Address'), h('dd', {}, j.address || '—'),
          h('dt', {}, 'Joining'), h('dd', {}, j.plan || '—'),
          h('dt', {}, 'Contact by'), h('dd', {}, `${j.contact_pref}, ${j.best_time || 'any time'}`),
          h('dt', {}, 'Notes'), h('dd', {}, j.details || '—'),
          j.acknowledged_at ? h('dt', {}, 'Acknowledged') : null,
          j.acknowledged_at ? h('dd', {}, `${fmtTs(j.acknowledged_at)}${j.acknowledged_by ? ' by ' + j.acknowledged_by : ''}`) : null),
        emailLine(j, reload), acts);
    };
    return h('div', {}, h('h2', {}, 'Join requests'),
      h('p', { class: 'tab-hint' }, 'Every joining form lands here and is emailed to info@ at the same time. Acknowledge it, then contact the person.'),
      fresh ? h('div', { class: 'chip' }, h('b', {}, String(fresh)), fresh === 1 ? ' new form waiting to be acknowledged' : ' new forms waiting to be acknowledged') : null,
      h('div', { class: 'psub', style: 'padding:0 0 14px' }, FILTERS.map(([k, l, fn]) => h('button', { type: 'button', 'aria-pressed': String(S.joinFilter === k),
        onclick: () => { S.joinFilter = k; reload(); } }, `${l} (${joins.filter(fn).length})`))),
      list.length ? h('div', {}, list.map(card)) : h('p', { class: 'em' }, S.joinFilter === 'open' ? 'Nothing waiting. New joining forms will appear here.' : 'Nothing here yet.'));
  };

  A.overview = async () => {
    const s = await api('GET', '/api/admin/summary');
    return h('div', {}, h('h2', {}, 'Overview'),
      h('div', { class: 'stats' }, stat(String(s.new_joins), 'New join requests'), stat(String(s.customers), 'Clients'), stat(String(s.active_plans), 'Active plans'), stat(R(s.monthly_cents), 'Monthly recurring'),
        stat(String(s.jobs_today), 'Jobs today'), stat(String(s.jobs_open), 'Open jobs'), stat(String(s.unassigned), 'Need a crew'),
        stat(R(s.unpaid_cents), 'Unpaid invoices'), stat(R(s.paid_month_cents), 'Paid this month'), stat(String(s.new_quotes), 'New quote requests'), stat(String(s.plan_requests), 'Plans to price')),
      h('div', { class: 'acts' }, s.open_joins ? btn('Open join requests', () => go('joins'), 'b') : null, s.unassigned ? btn('Assign crews', () => go('jobs'), 'b') : null, s.plan_requests ? btn('Review plans', () => go('plans')) : null, s.new_quotes ? btn('Open quotes', () => go('quotes')) : null));
  };

  function resetBox(userId, name, phone) {
    const out = h('div', {});
    const b = btn('Issue reset code', async () => {
      const r = await api('POST', `/api/admin/users/${userId}/reset-code`);
      out.replaceChildren(h('div', { class: 'card' }, h('p', {}, `One-time code for ${name} (valid ${r.expires_in_minutes} minutes):`), h('div', { class: 'code' }, r.code),
        phone ? h('a', { class: 'b2', target: '_blank', rel: 'noopener', href: waLink(phone, `Hello ${name}, your Lusibane reset code is ${r.code}. Open Lusibane One, choose Forgot password and enter it. It expires in 2 hours.`) }, 'Send on WhatsApp') : null));
    });
    return h('div', {}, b, out);
  }

  A.customers = async () => {
    if (S.detail) {
      const d = await api('GET', `/api/admin/customers/${S.detail}`);
      const u = d.user;
      return h('div', {}, btn('← All clients', () => { S.detail = 0; reload(); }), h('h2', { style: 'margin-top:12px' }, u.name, ' ', pill(u.status)),
        h('div', { class: 'split' },
          h('div', { class: 'card' }, h('dl', { class: 'kv' }, h('dt', {}, 'Email'), h('dd', {}, u.email || '—'), h('dt', {}, 'Phone'), h('dd', {}, h('a', { class: 'link', href: 'tel:' + u.phone }, u.phone)),
            h('dt', {}, 'Area'), h('dd', {}, u.area || '—'), h('dt', {}, 'Address'), h('dd', {}, u.address || '—'), h('dt', {}, 'Added'), h('dd', {}, fmtTs(u.created_at)),
            h('dt', {}, 'Plan'), h('dd', {}, d.subscription ? h('span', {}, d.subscription.plan, ' ', pill(d.subscription.status), d.subscription.monthly_cents ? ' ' + R(d.subscription.monthly_cents) : '') : 'None')),
            h('div', { class: 'acts', style: 'margin-top:14px' },
              btn(u.status === 'active' ? 'Deactivate client' : 'Reactivate client', async () => {
                if (u.status === 'active' && !confirm('Deactivate this client? You will not be able to add new jobs for them.')) throw ABORT;
                await api('POST', `/api/admin/users/${u.id}/status`, { status: u.status === 'active' ? 'disabled' : 'active' }); flash('Client updated.', true); reload();
              }, u.status === 'active' ? 'b2 danger' : 'b'),
              h('a', { class: 'b2', target: '_blank', rel: 'noopener', href: waLink(u.phone, `Hello ${u.name}, this is Lusibane.`) }, 'WhatsApp'))),
          h('div', {}, h('h3', {}, 'Recent bookings'), table(['Date', 'Service', 'Status', 'Proof'], d.bookings.map((b) => [fmtDate(b.date), b.service, pill(b.status), b.proof || '—']), 'No bookings.'),
            h('h3', { style: 'margin-top:16px' }, 'Invoices'), table(['No.', 'Description', 'Amount', 'Status'], d.invoices.map((i) => [i.number, i.description, R(i.amount_cents), pill(i.status)]), 'No invoices.'))));
    }
    const { customers } = await api('GET', '/api/admin/customers');
    return h('div', {}, h('h2', {}, 'Clients'), h('p', { class: 'tab-hint' }, 'People who have joined. Clients do not log in: you manage their jobs, plans and invoices here.'),
      table(['Name', 'Contact', 'Area', 'Plan', 'Balance', 'Status', ''], customers.map((c) => [c.name, h('span', {}, c.phone, c.email ? h('span', { class: 'small' }, c.email) : null), c.area || '—',
        c.plan ? h('span', {}, c.plan, ' ', pill(c.plan_status)) : '—', c.balance_cents ? R(c.balance_cents) : '—', pill(c.status),
        btn('Open', () => { S.detail = c.id; reload(); return Promise.resolve(); })]), 'No clients yet. When someone joins, add them from Join requests.'));
  };

  A.plans = async () => {
    const { subscriptions } = await api('GET', '/api/admin/subscriptions');
    const base = Object.fromEntries(S.config.plans.map((p) => [p.name, p.cents]));
    const row = (s) => {
      const price = h('input', { type: 'number', step: '0.01', min: '1', 'aria-label': 'Monthly price in rand', value: ((s.monthly_cents || base[s.pending_plan && s.status !== 'pending' ? s.pending_plan : s.plan] || 0) / 100).toFixed(2) });
      const decide = (action, msg) => btn(msg.label, async () => {
        if (msg.confirm && !confirm(msg.confirm)) throw ABORT;
        await api('POST', `/api/admin/subscriptions/${s.id}/decide`, { action, monthly_rand: price.value }); flash(msg.done, true); reload();
      }, msg.cls || 'b2');
      const acts = h('div', { class: 'acts' });
      if (s.status === 'pending') acts.append(price, decide('approve', { label: 'Approve', done: 'Plan approved.', cls: 'b' }), decide('decline', { label: 'Decline', done: 'Request declined.', cls: 'b2 danger' }));
      else if (s.status === 'cancel_requested') acts.append(decide('end', { label: 'Confirm cancellation', done: 'Plan ended.', cls: 'b' }), decide('decline', { label: 'Keep plan', done: 'Plan kept.' }));
      else if (s.status === 'active' || s.status === 'paused') {
        if (s.pending_plan) acts.append(price, decide('approve', { label: 'Approve change', done: 'Plan changed.', cls: 'b' }), decide('decline', { label: 'Decline change', done: 'Change declined.' }));
        else acts.append(price, decide('price', { label: 'Set price', done: 'Price updated.' }));
        acts.append(s.status === 'active' ? decide('pause', { label: 'Pause', done: 'Plan paused.' }) : decide('resume', { label: 'Resume', done: 'Plan resumed.' }),
          decide('end', { label: 'End', done: 'Plan ended.', cls: 'b2 danger', confirm: 'End this plan?' }));
      }
      return [h('span', {}, s.name, h('span', { class: 'small' }, s.phone)), s.area || '—', s.plan, s.pending_plan ? '→ ' + s.pending_plan : '—', pill(s.status), s.monthly_cents ? R(s.monthly_cents) : '—', acts];
    };
    return h('div', {}, h('h2', {}, 'Plans'), h('p', { class: 'tab-hint' }, 'Approve new plans (set the agreed monthly price), handle changes and cancellations.'),
      table(['Client', 'Area', 'Plan', 'Change to', 'Status', 'Monthly', 'Actions'], subscriptions.map(row), 'No plans yet.'));
  };

  A.invoices = async () => {
    const [{ invoices }, { customers }] = await Promise.all([api('GET', '/api/admin/invoices'), api('GET', '/api/admin/customers')]);
    const month = today().slice(0, 7);
    return h('div', {}, h('h2', {}, 'Invoices'),
      h('div', { class: 'split' },
        h('div', { class: 'card' }, h('h3', {}, 'Run monthly billing'), h('p', { class: 'small' }, 'Creates one invoice for every active plan. Safe to run twice: nobody is billed twice for the same month.'),
          form([{ name: 'month', label: 'Month', type: 'month', value: month }], 'Create invoices', async (d) => {
            const r = await api('POST', '/api/admin/billing/run', d); flash(`${r.created} invoice(s) created, ${r.skipped} already existed.`, true); reload();
          })),
        h('div', { class: 'card' }, h('h3', {}, 'New invoice'), customers.length ? form([
          { name: 'user_id', label: 'Client', type: 'select', options: customers.map((c) => [c.id, c.name]) },
          { name: 'description', label: 'Description', max: 200 },
          { name: 'amount_rand', label: 'Amount (R)', type: 'number', step: '0.01', min: '0.01' },
          { name: 'due_date', label: 'Due date', type: 'date', value: today() },
        ], 'Create invoice', async (d) => { await api('POST', '/api/admin/invoices', { ...d, user_id: Number(d.user_id) }); flash('Invoice created.', true); reload(); }) : h('p', { class: 'em' }, 'No clients yet.'))),
      table(['No.', 'Client', 'Description', 'Amount', 'Due', 'Status', ''], invoices.map((i) => {
        const method = sel(['EFT', 'Cash', 'Other'], 'EFT');
        return [i.number, i.name, i.description, R(i.amount_cents), fmtDate(i.due_date),
          h('span', {}, pill(i.status), i.paid_at ? h('span', { class: 'small' }, `${i.method} ${fmtTs(i.paid_at)}`) : null),
          i.status === 'unpaid' ? h('div', { class: 'acts' }, method,
            btn('Mark paid', async () => { await api('POST', `/api/admin/invoices/${i.id}/pay`, { method: method.value }); flash('Payment recorded.', true); reload(); }, 'b'),
            btn('Void', async () => { if (!confirm('Void this invoice?')) throw ABORT; await api('POST', `/api/admin/invoices/${i.id}/void`); flash('Invoice voided.', true); reload(); }, 'b2 danger')) : ''];
      }), 'No invoices yet.'));
  };

  A.quotes = async () => {
    const { quotes } = await api('GET', '/api/admin/quotes');
    return h('div', {}, h('h2', {}, 'Quote requests'),
      table(['Received', 'Name', 'Contact', 'Area', 'Request', 'Status'], quotes.map((q) => {
        const st = sel([['new', 'New'], ['contacted', 'Contacted'], ['won', 'Won'], ['lost', 'Lost']], q.status);
        st.addEventListener('change', async () => { try { await api('POST', `/api/admin/quotes/${q.id}/status`, { status: st.value }); flash('Status updated.', true); } catch (e) { flash(e.message, false); } });
        return [fmtTs(q.created_at), q.name, h('span', {}, h('a', { class: 'link', href: 'tel:' + q.phone }, q.phone),
          h('a', { class: 'link small', target: '_blank', rel: 'noopener', href: waLink(q.phone, `Hello ${q.name}, this is Lusibane about your quote request.`) }, 'WhatsApp')),
          q.area, h('span', {}, q.service || '—', q.details ? h('span', { class: 'small' }, q.details) : null), st];
      }), 'No quote requests yet.'));
  };

  A.contracts = async () => {
    const [{ contracts, kinds }, { customers }] = await Promise.all([api('GET', '/api/admin/contracts'), api('GET', '/api/admin/customers')]);
    return h('div', {}, h('h2', {}, 'Contracts'),
      customers.length ? form([
        { name: 'user_id', label: 'Client', type: 'select', options: customers.map((c) => [c.id, c.name]) },
        { name: 'kind', label: 'Type', type: 'select', options: kinds },
        { name: 'start_date', label: 'Start date', type: 'date', value: today() },
      ], 'Add contract', async (d) => { await api('POST', '/api/admin/contracts', { ...d, user_id: Number(d.user_id) }); flash('Contract added.', true); reload(); }) : h('p', { class: 'em' }, 'Add clients first.'),
      table(['Client', 'Type', 'Start', 'Status', ''], contracts.map((c) => [c.name, c.kind, fmtDate(c.start_date), pill(c.status),
        btn(c.status === 'active' ? 'End' : 'Reactivate', async () => { await api('POST', `/api/admin/contracts/${c.id}/toggle`); reload(); })]), 'No contracts yet.'));
  };

  A.tenders = async () => {
    const { tenders } = await api('GET', '/api/admin/tenders');
    return h('div', {}, h('h2', {}, 'Tenders'),
      form([
        { name: 'title', label: 'Tender', max: 200 }, { name: 'client', label: 'Client', max: 150 },
        { name: 'closing_date', label: 'Closing date', type: 'date', value: today() },
        { name: 'value_rand', label: 'Value (R)', type: 'number', step: '0.01', min: '0', required: false },
      ], 'Add tender', async (d) => { await api('POST', '/api/admin/tenders', d); flash('Tender added.', true); reload(); }),
      table(['Tender', 'Client', 'Closes', 'Value', 'Stage'], tenders.map((t) => {
        const st = sel([['spotted', 'Spotted'], ['preparing', 'Preparing'], ['submitted', 'Submitted'], ['won', 'Won'], ['lost', 'Lost']], t.stage);
        st.addEventListener('change', async () => { try { await api('POST', `/api/admin/tenders/${t.id}/stage`, { stage: st.value }); flash('Stage updated.', true); } catch (e) { flash(e.message, false); } });
        return [t.title, t.client, fmtDate(t.closing_date), t.value_cents ? R(t.value_cents) : '—', st];
      }), 'No tenders yet.'));
  };

  A.team = async () => {
    const { staff } = await api('GET', '/api/admin/staff');
    return h('div', {}, h('h2', {}, 'Team'),
      h('div', { class: 'card' }, h('h3', {}, 'Add a crew member'), h('p', { class: 'small' }, 'They log in with this temporary password and must choose their own straight away.'),
        form([{ name: 'name', label: 'Full name', max: 100 }, { name: 'email', label: 'Email', type: 'email' }, { name: 'phone', label: 'Phone', type: 'tel' },
          { name: 'password', label: 'Temporary password (10+)', type: 'text', minlength: 10, auto: 'off' }], 'Add crew member',
        async (d, f) => { await api('POST', '/api/admin/staff', d); f.reset(); flash('Crew member added.', true); reload(); })),
      table(['Name', 'Email', 'Role', 'Last login', 'Status', ''], staff.map((m) => [m.name, h('span', {}, m.email, h('span', { class: 'small' }, m.phone)), roleLabel(m.role), fmtTs(m.last_login), pill(m.status),
        m.id === S.user.id ? 'You' : h('div', { class: 'acts' },
          btn(m.status === 'active' ? 'Disable' : 'Enable', async () => { await api('POST', `/api/admin/users/${m.id}/status`, { status: m.status === 'active' ? 'disabled' : 'active' }); reload(); }, m.status === 'active' ? 'b2 danger' : 'b'),
          resetBox(m.id, m.name, m.phone))]), 'No team members.'));
  };

  A.audit = async () => {
    const { audit } = await api('GET', '/api/admin/audit');
    return h('div', {}, h('h2', {}, 'Audit log'), h('p', { class: 'tab-hint' }, 'The latest 300 actions: who did what, when, and from which address.'),
      table(['When', 'Who', 'Action', 'Item', 'Detail', 'IP'], audit.map((a) => [fmtTs(a.ts), a.actor || '—', a.action, a.entity ? `${a.entity} #${a.entity_id ?? ''}` : '', a.detail || '', a.ip || '']), 'Nothing logged yet.'));
  };

  // ---------- start ----------
  function init() { root = $('portal'); start(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
