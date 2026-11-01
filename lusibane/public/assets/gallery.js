(function () {
  'use strict';
  // Shows the photos and videos from the media folder and opens them in a full-screen preview.
  // Everything is built with createElement/textContent, so file names can never inject HTML.
  var SVGNS = 'http://www.w3.org/2000/svg';

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function playIcon() {
    var s = document.createElementNS(SVGNS, 'svg');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true');
    var p = document.createElementNS(SVGNS, 'path'); p.setAttribute('d', 'M8 5v14l11-7z');
    s.appendChild(p); return s;
  }

  // ---------- full-screen preview ----------
  var lb, stage, cap, count, items = [], at = 0, opener = null, touchX = null;

  function build() {
    if (lb) return;
    lb = el('div', 'lb'); lb.hidden = true;
    lb.setAttribute('role', 'dialog'); lb.setAttribute('aria-modal', 'true'); lb.setAttribute('aria-label', 'Photo and video preview');
    var top = el('div', 'lb-top'); count = el('span', '', '');
    var x = el('button', 'lb-x', '×'); x.type = 'button'; x.setAttribute('aria-label', 'Close preview');
    x.addEventListener('click', close);
    top.appendChild(count); top.appendChild(x);
    var main = el('div', 'lb-main');
    var prev = el('button', 'lb-n prev', '‹'); prev.type = 'button'; prev.setAttribute('aria-label', 'Previous');
    var next = el('button', 'lb-n next', '›'); next.type = 'button'; next.setAttribute('aria-label', 'Next');
    prev.addEventListener('click', function () { show(at - 1); });
    next.addEventListener('click', function () { show(at + 1); });
    stage = el('div', 'lb-stage');
    main.appendChild(prev); main.appendChild(stage); main.appendChild(next);
    cap = el('div', 'lb-cap');
    lb.appendChild(top); lb.appendChild(main); lb.appendChild(cap);
    lb.addEventListener('click', function (e) { if (e.target === lb || e.target === stage || e.target === main) close(); });
    lb.addEventListener('touchstart', function (e) { touchX = e.touches[0].clientX; }, { passive: true });
    lb.addEventListener('touchend', function (e) {
      if (touchX == null) return;
      var dx = e.changedTouches[0].clientX - touchX; touchX = null;
      if (Math.abs(dx) > 60) show(at + (dx < 0 ? 1 : -1));
    });
    document.addEventListener('keydown', function (e) {
      if (lb.hidden) return;
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowLeft') show(at - 1);
      else if (e.key === 'ArrowRight') show(at + 1);
      else if (e.key === 'Tab') { // keep keyboard focus inside the preview
        var f = lb.querySelectorAll('button,video[controls]');
        if (!f.length) return;
        var first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    });
    document.body.appendChild(lb);
  }

  function stop() {
    var v = stage && stage.querySelector('video');
    if (v) { v.pause(); v.removeAttribute('src'); v.load(); }
    if (stage) stage.replaceChildren();
  }

  function show(i) {
    if (!items.length) return;
    at = (i + items.length) % items.length;
    stop();
    var m = items[at], node;
    if (m.kind === 'video') {
      node = document.createElement('video');
      node.controls = true; node.playsInline = true; node.autoplay = true; node.preload = 'auto';
      if (m.poster) node.poster = m.poster;
      node.src = m.src;
      node.setAttribute('aria-label', m.caption || 'Video of our work');
      var p = node.play(); if (p && p.catch) p.catch(function () { /* the viewer can press play */ });
    } else {
      node = document.createElement('img'); node.src = m.src; node.alt = m.caption || 'Photo of our work';
    }
    stage.appendChild(node);
    cap.textContent = m.caption || '';
    count.textContent = (at + 1) + ' / ' + items.length;
  }

  function open(list, i, from) {
    build(); items = list; opener = from || null;
    lb.hidden = false; document.body.style.overflow = 'hidden';
    show(i);
    lb.querySelector('.lb-x').focus();
  }
  function close() {
    if (!lb || lb.hidden) return;
    stop(); lb.hidden = true; document.body.style.overflow = '';
    if (opener && opener.focus) opener.focus();
  }

  // ---------- the grid ----------
  function tile(m, list, i) {
    var b = el('button', 'gt'); b.type = 'button';
    b.setAttribute('aria-label', (m.kind === 'video' ? 'Play video: ' : 'View photo: ') + (m.caption || 'our work'));
    if (m.kind === 'video') {
      if (m.poster) { var pi = document.createElement('img'); pi.src = m.poster; pi.alt = ''; pi.loading = 'lazy'; b.appendChild(pi); }
      else {
        var v = document.createElement('video'); v.muted = true; v.playsInline = true; v.preload = 'metadata';
        v.setAttribute('aria-hidden', 'true'); v.tabIndex = -1; v.src = m.src + '#t=0.1'; b.appendChild(v);
      }
      var badge = el('span', 'gv'); badge.appendChild(playIcon()); badge.appendChild(document.createTextNode('Video'));
      b.appendChild(badge);
    } else {
      var im = document.createElement('img'); im.src = m.src; im.alt = ''; im.loading = 'lazy'; im.decoding = 'async'; b.appendChild(im);
    }
    if (m.caption) b.appendChild(el('span', 'gc', m.caption));
    b.addEventListener('click', function () { open(list, i, b); });
    return b;
  }

  function render(box, media) {
    var limit = Number(box.dataset.limit) || 8;
    var more = box.dataset.more || '';           // optional link to "see all"
    box.replaceChildren();
    if (!media.length) {
      var e = el('div', 'gal-empty');
      e.appendChild(el('b', '', 'Photos and videos are on the way'));
      e.appendChild(el('span', '', 'We are adding real pictures and videos of our jobs here. Message us on WhatsApp and we will send you examples of work like yours.'));
      box.appendChild(e); return;
    }
    var grid = el('div', 'gal' + (limit >= 5 && media.length >= 5 ? ' big' : ''));
    var shown = 0;
    function add(n) {
      for (var k = 0; k < n && shown < media.length; k++, shown++) grid.appendChild(tile(media[shown], media, shown));
    }
    add(limit);
    box.appendChild(grid);
    if (shown < media.length || more) {
      var bar = el('div', 'gal-more');
      if (shown < media.length && !more) {
        var btn = el('button', '', 'Show more (' + (media.length - shown) + ')'); btn.type = 'button';
        btn.addEventListener('click', function () { add(12); if (shown >= media.length) bar.remove(); else btn.textContent = 'Show more (' + (media.length - shown) + ')'; });
        bar.appendChild(btn);
      }
      if (more) { var a = el('a', '', box.dataset.moreLabel || 'See all our work'); a.href = more; bar.appendChild(a); }
      box.appendChild(bar);
    }
  }

  var boxes = document.querySelectorAll('[data-gallery]');
  if (!boxes.length) return;
  fetch('/api/media', { credentials: 'same-origin' })
    .then(function (r) { return r.ok ? r.json() : { media: [] }; })
    .catch(function () { return { media: [] }; })
    .then(function (j) { boxes.forEach(function (b) { render(b, j.media || []); }); });
})();
