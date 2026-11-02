(function () {
  'use strict';
  var $ = function (i) { return document.getElementById(i); };
  var WA = '27815786526';

  // reveal-on-scroll
  var io = new IntersectionObserver(function (es) {
    es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('vis'); io.unobserve(e.target); } });
  }, { threshold: 0.1 });
  document.querySelectorAll('.rv,.cd').forEach(function (e) { io.observe(e); });

  // the once-off job button pre-fills the contact form's service field
  document.querySelectorAll('[data-p]').forEach(function (a) {
    a.addEventListener('click', function () { $('s').value = a.dataset.p; });
  });

  // phone menu
  var nav = document.querySelector('nav'), mb = nav.querySelector('.mb');
  function menu(open) { nav.classList.toggle('open', open); mb.setAttribute('aria-expanded', String(open)); }
  mb.addEventListener('click', function () { menu(!nav.classList.contains('open')); });
  nav.querySelectorAll('.nl a').forEach(function (a) { a.addEventListener('click', function () { menu(false); }); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') menu(false); });

  // contact form: sent to the form service, which emails info@ and keeps a copy in its inbox
  var CFG = window.LUSIBANE || {};
  var form = $('f'), msg = $('fmsg'), btn = $('fsend');
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var body = { form_type: 'Quote request', _subject: 'New quote request: ' + $('n').value, name: $('n').value, phone: $('p').value,
      area: $('a').value, service: $('s').value, details: $('m').value, _gotcha: '' };
    msg.className = 'fmsg'; msg.textContent = 'Sending\u2026'; btn.disabled = true;
    if (!CFG.formEndpoint || /YOUR_FORM_ID/.test(CFG.formEndpoint)) {
      msg.className = 'fmsg err'; msg.textContent = 'The form is not connected yet. Please call or WhatsApp 081 578 6526.'; btn.disabled = false; return;
    }
    fetch(CFG.formEndpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { if (!r.ok) throw new Error('Could not send your request'); })
      .then(function () {
        var text = 'Hello Lusibane, I would like a quote.\nName: ' + body.name + '\nPhone: ' + body.phone +
          '\nArea: ' + body.area + '\nService: ' + body.service + (body.details ? '\nDetails: ' + body.details : '');
        msg.className = 'fmsg ok';
        msg.textContent = 'Thank you, we have your request and will contact you soon. ';
        var a = document.createElement('a');
        a.href = 'https://wa.me/' + WA + '?text=' + encodeURIComponent(text);
        a.target = '_blank'; a.rel = 'noopener';
        a.textContent = 'Message us on WhatsApp for the fastest reply \u2192';
        msg.appendChild(a);
        form.reset();
      })
      .catch(function (err) {
        msg.className = 'fmsg err';
        msg.textContent = (err && err.message ? err.message : 'Could not send') + '. You can also call or WhatsApp 081 578 6526.';
      })
      .then(function () { btn.disabled = false; });
  });
})();
