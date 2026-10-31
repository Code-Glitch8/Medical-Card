/* Shared native UI behaviour (Android + Windows). Presentation only; no business logic, no network. */
(function () {
  'use strict';
  var root = document.documentElement;
  var plat = window.__mcPlatform || 'web';
  root.classList.add('mc-app', 'mc-' + plat);
  var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  var LOGO = '<svg viewBox="0 0 64 64" aria-hidden="true"><defs><linearGradient id="mcg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3b8cff"/><stop offset="1" stop-color="#1747b8"/></linearGradient></defs><rect width="64" height="64" rx="16" fill="url(#mcg)"/><rect x="14" y="12" width="36" height="40" rx="6" fill="#fff" opacity=".96"/><path d="M29 19h6v7h7v6h-7v7h-6v-7h-7v-6h7z" fill="#1747b8"/><path d="M18 45h8l3-5 4 9 3-6 2 2h8" fill="none" stroke="#3b8cff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  var ICONS = {
    approvals: '<path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="9"/>',
    profiles: '<circle cx="9" cy="8" r="3.2"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><path d="M16 5.5a3 3 0 010 5.6M18 14.4c2 .7 3 2.5 3 5.6"/>',
    analytics: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    lookup: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
    records: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 8h6M9 12h6M9 16h4"/>',
    audit: '<path d="M12 3l8 3v6c0 4.5-3.3 8-8 9-4.7-1-8-4.5-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.8-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.7 1.7 0 00-1.1-1.5 1.7 1.7 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.8 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1a1.7 1.7 0 001.5-1.1 1.7 1.7 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.8.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.8V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z"/>'
  };
  function svg(inner) { return '<svg class="mc-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + inner + '</svg>'; }

  function decorate() {
    document.querySelectorAll('.logo').forEach(function (l) { if (!l.dataset.mc) { l.dataset.mc = 1; l.innerHTML = LOGO; } });
    document.querySelectorAll('#mainNav [data-nav]').forEach(function (b) {
      if (b.dataset.mc) return; b.dataset.mc = 1;
      var label = b.textContent.trim();
      b.setAttribute('aria-label', label);
      b.innerHTML = svg(ICONS[b.dataset.nav] || ICONS.records) + '<span class="mc-lbl">' + label + '</span>';
    });
    var lock = document.getElementById('lockBtn');
    if (lock && !lock.dataset.mc) { lock.dataset.mc = 1; lock.setAttribute('title', 'Sign out' + (plat === 'windows' ? ' (Ctrl+L)' : '')); }
  }

  // Active nav item (the site only calls renderPage; mirror its current page onto the nav).
  var NAVMAP = { dashboard: 'lookup', assignUID: 'lookup', addPerson: 'lookup', timeline: 'lookup', history: 'lookup' };
  function syncNav() {
    var cur = typeof currentPage === 'string' ? currentPage : '';
    var want = NAVMAP[cur] || cur;
    document.querySelectorAll('#mainNav [data-nav]').forEach(function (b) {
      var on = b.dataset.nav === want; b.classList.toggle('mc-active', on);
      if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
  }

  function labelTables(scope) {
    (scope || document).querySelectorAll('#main table').forEach(function (t) {
      var heads = Array.prototype.map.call(t.querySelectorAll('thead th'), function (th) { return th.textContent.trim(); });
      if (!heads.length) return;
      t.classList.add('mc-table');
      t.querySelectorAll('tbody tr').forEach(function (tr) {
        Array.prototype.forEach.call(tr.children, function (td, i) { if (!td.dataset.label && heads[i]) td.dataset.label = heads[i]; });
      });
    });
  }

  function onReady() {
    decorate();
    var main = document.getElementById('main');
    if (main) {
      new MutationObserver(function () {
        labelTables(); syncNav();
        if (!reduce) { main.classList.remove('mc-enter'); void main.offsetWidth; main.classList.add('mc-enter'); }
      }).observe(main, { childList: true });
    }
    new MutationObserver(function () { decorate(); syncNav(); }).observe(document.body, { attributes: true, subtree: true, attributeFilter: ['class', 'hidden'] });

    // Keyboard: keep the focused field visible; hide the bottom bar while typing.
    document.addEventListener('focusin', function (e) {
      var t = e.target; if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) setTimeout(function () { try { t.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' }); } catch (_) {} }, 300);
    });
    if (window.visualViewport) {
      var base = window.visualViewport.height;
      window.visualViewport.addEventListener('resize', function () {
        var h = window.visualViewport.height; if (h > base) base = h;
        root.classList.toggle('mc-kb', base - h > 150);
      });
    }
    if (plat === 'windows') windowsChrome();
    dismissSplash();
  }

  function windowsChrome() {
    var bar = document.createElement('div');
    bar.id = 'mcTitlebar';
    bar.innerHTML = '<span class="mc-tb-logo">' + LOGO + '</span><span class="mc-tb-title">MedVault Secure Medical Records</span><span class="mc-tb-sub">SECURE MEDICAL RECORDS</span>';
    document.body.appendChild(bar);
    document.addEventListener('keydown', function (e) {
      if (!e.ctrlKey || e.altKey) return;
      var k = e.key.toLowerCase();
      var app = document.getElementById('appView');
      var inApp = app && !app.classList.contains('hidden');
      if (!inApp) return;
      if (/^[1-9]$/.test(k)) {
        var items = Array.prototype.filter.call(document.querySelectorAll('#mainNav [data-nav]'), function (b) { return !b.hidden; });
        var b = items[Number(k) - 1]; if (b) { e.preventDefault(); b.click(); }
      } else if (k === 'k') {
        e.preventDefault();
        var f = document.querySelector('#main input:not([type=hidden]):not([type=checkbox]):not([disabled])'); if (f) { f.focus(); f.select && f.select(); }
      } else if (k === 'l' && !e.shiftKey) { e.preventDefault(); var l = document.getElementById('lockBtn'); if (l) l.click(); }
      else if (k === 'r' && e.shiftKey) { e.preventDefault(); var c = document.getElementById('headerConnectBtn'); if (c && !c.hidden) c.click(); }
    });
  }

  // Splash: shown by markup at start of <body>; runs once per app launch (never during in-app navigation).
  var T0 = (window.performance && performance.now) ? performance.now() : 0;
  function dismissSplash() {
    var s = document.getElementById('mcSplash'); if (!s) return;
    var MIN = reduce ? 700 : 1900;
    var wait = Math.max(0, MIN - (T0 ? performance.now() : MIN));
    setTimeout(function () {
      s.classList.add('mc-out');
      setTimeout(function () { if (s.parentNode) s.parentNode.removeChild(s); }, reduce ? 50 : 420);
    }, wait);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onReady); else onReady();
  window.addEventListener('keydown', function (e) { if (e.key === 'Escape' && window.__mcHandleBack && plat === 'windows' && !/^(INPUT|TEXTAREA|SELECT)$/.test((e.target||{}).tagName||'')) window.__mcHandleBack(); });
})();
