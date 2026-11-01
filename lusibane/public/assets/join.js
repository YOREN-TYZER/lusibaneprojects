(function () {
  'use strict';
  var $ = function (i) { return document.getElementById(i); };
  var WA = '27815786526';
  var form = $('jf'), msg = $('msg'), go = $('go');

  var PLANS = {
    'Lusibane Home': { price: 'R150', from: false, blurb: 'Waste collected once a week, same day every week. No more burning or dumping.', list: ['Weekly waste collection', 'Same day every week', 'Month-to-month'] },
    'Lusibane Home Plus': { price: 'R500', from: false, blurb: 'Everything in Home, plus yard care twice a week.', list: ['Weekly waste collection', 'Grass, sweeping, hedges and trees twice weekly', 'Our own tools brought to site'] },
    'Lusibane Church': { price: 'R400', from: true, blurb: 'Waste, yard and full cleaning. Yard plans depend on the size of your yard, so we confirm the price after we see it.', list: ['Yard and garden care', 'Full cleaning, floors to windows', 'Price confirmed after a site visit'] },
    'Lusibane School': { price: 'R300', from: false, blurb: 'Weekly collection after school hours. Bush and boundary clearing is quoted after a visit.', list: ['Collection once a week', 'After school hours', '2 weeks’ notice to cancel'] },
    'Lusibane Business': { price: 'R200', from: true, blurb: 'Collection one to three times a week, priced by how much waste your business produces.', list: ['One to three collections a week', 'Priced by waste volume', 'Price confirmed by our team'] },
    'Not sure yet, please advise me': { price: '', from: false, blurb: 'No problem. Tell us about your home, church, school or business in the notes and we will recommend the right plan and price.', list: ['Free advice, no obligation', 'Quotes valid for 14 days'] }
  };

  function planCard(name) {
    var p = PLANS[name] || PLANS['Not sure yet, please advise me'], box = $('planbox');
    box.replaceChildren();
    var h = document.createElement('h3'); h.textContent = 'Your choice'; box.appendChild(h);
    var b = document.createElement('b'); b.textContent = PLANS[name] ? name.replace(/^Lusibane /, 'Lusibane ') : 'We will help you choose'; box.appendChild(b);
    if (p.price) {
      var pr = document.createElement('div'); pr.className = 'pr';
      pr.textContent = (p.from ? 'from ' : '') + p.price + ' ';
      var sm = document.createElement('small'); sm.textContent = '/ month'; pr.appendChild(sm); box.appendChild(pr);
    }
    var t = document.createElement('p'); t.textContent = p.blurb; box.appendChild(t);
    var ul = document.createElement('ul');
    p.list.forEach(function (x) { var li = document.createElement('li'); li.textContent = x; ul.appendChild(li); });
    box.appendChild(ul);
  }

  // /join?plan=Lusibane+Home pre-selects a plan
  try {
    var want = new URLSearchParams(location.search).get('plan');
    if (want && PLANS[want]) $('plan').value = want;
  } catch (e) { /* ignore */ }
  planCard($('plan').value);
  $('plan').addEventListener('change', function () { planCard($('plan').value); });

  // ---------- validation (the server checks everything again) ----------
  function setErr(key, text) {
    var f = form.querySelector('[data-f="' + key + '"]');
    if (!f) return;
    f.classList.toggle('err', !!text);
    var e = f.querySelector('.ferr'); if (e) e.textContent = text || '';
    var inp = f.querySelector('input,select,textarea'); if (inp) inp.setAttribute('aria-invalid', text ? 'true' : 'false');
  }
  function clearErrs() { ['name', 'phone', 'area', 'email', 'address', 'plan', 'best_time', 'details'].forEach(function (k) { setErr(k, ''); }); $('consent').classList.remove('err'); }
  function check(d) {
    var bad = null;
    function need(key, cond, text) { if (!cond) { setErr(key, text); if (!bad) bad = key; } }
    need('name', d.name.trim().length >= 2, 'Please enter your full name');
    need('phone', /^\+?\d{9,15}$/.test(d.phone.replace(/[\s()-]/g, '')), 'Enter a valid phone number, e.g. 081 578 6526');
    need('area', d.area.trim().length >= 2, 'Please tell us your area or street');
    if (d.email.trim()) need('email', /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(d.email.trim()), 'Enter a valid email address');
    if (d.contact_pref === 'Email') need('email', !!d.email.trim(), 'Add your email, or choose WhatsApp or Phone call');
    if (!d.consent) { $('consent').classList.add('err'); if (!bad) bad = 'consent'; }
    return bad;
  }
  form.addEventListener('input', function (e) {
    var f = e.target.closest && e.target.closest('[data-f]'); if (f) setErr(f.dataset.f, '');
    $('consent').classList.remove('err');
  });

  function data() {
    var fd = new FormData(form);
    return {
      name: String(fd.get('name') || ''), phone: String(fd.get('phone') || ''), email: String(fd.get('email') || ''),
      area: String(fd.get('area') || ''), address: String(fd.get('address') || ''), plan: String(fd.get('plan') || ''),
      contact_pref: String(fd.get('contact_pref') || 'WhatsApp'), best_time: String(fd.get('best_time') || ''),
      details: String(fd.get('details') || ''), website: String(fd.get('website') || ''), consent: $('agree').checked
    };
  }

  function thanks(d, ref) {
    var box = $('formbox'); box.replaceChildren();
    var c = document.createElement('div'); c.className = 'jn-done'; c.tabIndex = -1;
    c.innerHTML = '<div class="tick"><svg viewBox="0 0 24 24" aria-hidden="true"><use href="#ok"/></svg></div>';
    var h = document.createElement('h2'); h.textContent = 'Thank you, ' + d.name.trim().split(/\s+/)[0] + '.'; c.appendChild(h);
    var p = document.createElement('p');
    p.textContent = 'Your joining form is with us. A team member will acknowledge it and contact you by ' + d.contact_pref.toLowerCase() +
      ' on ' + d.phone.trim() + ' (Monday to Friday, 08:00 to 16:00) to agree your plan, price and first collection day.';
    c.appendChild(p);
    var r = document.createElement('div'); r.className = 'refno'; r.textContent = ref; c.appendChild(r);
    var q = document.createElement('p'); q.textContent = 'Keep this reference number. If you would like the fastest reply, send us a quick WhatsApp with it.'; c.appendChild(q);
    var acts = document.createElement('div'); acts.className = 'acts';
    var wa = document.createElement('a'); wa.className = 'wa2'; wa.target = '_blank'; wa.rel = 'noopener';
    wa.href = 'https://wa.me/' + WA + '?text=' + encodeURIComponent('Hello Lusibane, I just sent my joining form (' + ref + ') for ' + d.plan + '. My name is ' + d.name.trim() + '.');
    wa.textContent = 'Message us on WhatsApp';
    var back = document.createElement('a'); back.className = 'bk'; back.href = '/'; back.textContent = 'Back to the website';
    acts.appendChild(wa); acts.appendChild(back); c.appendChild(acts);
    box.appendChild(c);
    c.focus(); window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  form.addEventListener('submit', function (e) {
    e.preventDefault();
    clearErrs(); msg.className = 'fmsg'; msg.textContent = '';
    var d = data(), bad = check(d);
    if (bad) {
      msg.className = 'fmsg err'; msg.textContent = 'Please fix the highlighted fields.';
      var t = bad === 'consent' ? $('agree') : form.querySelector('[data-f="' + bad + '"] input,[data-f="' + bad + '"] select');
      if (t) t.focus();
      return;
    }
    go.disabled = true; msg.textContent = 'Sending…';
    fetch('/api/join', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(d)
    }).then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (!res.ok) throw new Error(res.j && res.j.error ? res.j.error : 'We could not send your form');
        thanks(d, res.j.reference);
      })
      .catch(function (err) {
        msg.className = 'fmsg err';
        msg.textContent = (err && err.message ? err.message : 'We could not send your form') + '. You can also call or WhatsApp 081 578 6526.';
        go.disabled = false;
      });
  });
})();
