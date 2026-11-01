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

  // household / organisation plan tabs
  function tab(k) {
    ['h', 'o'].forEach(function (x) {
      var on = x === k;
      $('t-' + x).setAttribute('aria-selected', on);
      $('g-' + x).hidden = !on;
    });
  }
  $('t-h').addEventListener('click', function () { tab('h'); });
  $('t-o').addEventListener('click', function () { tab('o'); });
  document.querySelectorAll('[data-tab]').forEach(function (a) {
    a.addEventListener('click', function () { tab(a.dataset.tab); });
  });

  // contact form: save the request on the server, then offer WhatsApp as the fast follow-up
  var form = $('f'), msg = $('fmsg'), btn = $('fsend');
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var body = { name: $('n').value, phone: $('p').value, area: $('a').value, service: $('s').value, details: $('m').value };
    msg.className = 'fmsg'; msg.textContent = 'Sending…'; btn.disabled = true;
    fetch('/api/quotes', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (!res.ok) throw new Error(res.j && res.j.error ? res.j.error : 'Could not send your request');
        var text = 'Hello Lusibane, I would like a quote.\nName: ' + body.name + '\nPhone: ' + body.phone +
          '\nArea: ' + body.area + '\nService: ' + body.service + (body.details ? '\nDetails: ' + body.details : '');
        msg.className = 'fmsg ok';
        msg.textContent = 'Thank you, we have your request and will contact you soon. ';
        var a = document.createElement('a');
        a.href = 'https://wa.me/' + WA + '?text=' + encodeURIComponent(text);
        a.target = '_blank'; a.rel = 'noopener';
        a.textContent = 'Message us on WhatsApp for the fastest reply →';
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
