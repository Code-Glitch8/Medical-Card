/* Shared native-app layer (Android + Windows). Injected by tools/build-web.mjs BEFORE the site's own script.
 * Nothing here touches the website source on disk; the site keeps working unchanged in a normal browser
 * (this file is only injected into the app bundles).
 *
 *  1. Persistent auth storage (session survives closing/reopening the app, with an idle cut-off).
 *  2. Edge-Function invoker that goes through the platform's NATIVE HTTPS stack (no browser CORS / Origin
 *     problems). Used for login-with-id, register-hospital and request-password-reset.
 *  3. Android-Back / Escape handler.
 */
(function () {
  'use strict';
  var PFX = 'mc_auth:', ACTIVE_KEY = 'mc_last_active';
  var MAX_IDLE_MS = 8 * 60 * 60 * 1000;     // a restored session is dropped after 8 h without any use
  var mem = Object.create(null);

  function ls() { try { return window.localStorage; } catch (_) { return null; } }
  function now() { return Date.now(); }

  function clearAuth() {
    var s = ls(); if (!s) { mem = Object.create(null); return; }
    try {
      var rm = [];
      for (var i = 0; i < s.length; i++) { var k = s.key(i); if (k && k.indexOf(PFX) === 0) rm.push(k); }
      rm.forEach(function (k) { s.removeItem(k); });
      s.removeItem(ACTIVE_KEY);
    } catch (_) {}
  }
  function touch() { var s = ls(); if (s) { try { s.setItem(ACTIVE_KEY, String(now())); } catch (_) {} } }

  // Cold start: drop a stale session before supabase-js ever reads it.
  (function expireStale() {
    var s = ls(); if (!s) return;
    try {
      var last = Number(s.getItem(ACTIVE_KEY));
      if (last && now() - last > MAX_IDLE_MS) clearAuth();
    } catch (_) {}
  })();

  window.__mcAuthStorage = {
    getItem: function (k) { var s = ls(); try { return s ? s.getItem(PFX + k) : (k in mem ? mem[k] : null); } catch (_) { return null; } },
    setItem: function (k, v) { var s = ls(); try { if (s) { s.setItem(PFX + k, v); touch(); } else mem[k] = String(v); } catch (_) { mem[k] = String(v); } },
    removeItem: function (k) { var s = ls(); try { if (s) s.removeItem(PFX + k); } catch (_) {} delete mem[k]; }
  };

  // Count real use as activity (throttled), so the idle cut-off measures inactivity, not install age.
  var lastTouch = 0;
  function activity() { var t = now(); if (t - lastTouch > 20000) { lastTouch = t; if (window.__mcAuthStorage.getItem('sb-pkzzktnxiboottirasvc-auth-token')) touch(); } }
  ['pointerdown', 'keydown', 'touchstart'].forEach(function (ev) { window.addEventListener(ev, activity, { passive: true, capture: true }); });

  // ---- Edge Functions through the native HTTPS stack -------------------------------------------------------
  var EDGE_TIMEOUT_MS = 25000;
  function httpError(status, body) {
    var e = new Error('Edge Function returned a non-2xx status code');
    e.name = 'FunctionsHttpError';
    e.context = { status: status, json: function () { return Promise.resolve(body); } };
    return e;
  }
  function netError(message, code) {
    var body = { error: { code: code || 'unavailable', message: message } };
    var e = new Error(message); e.name = 'FunctionsFetchError';
    e.context = { status: 0, json: function () { return Promise.resolve(body); } };
    return e;
  }
  /* Same contract as supabase-js functions.invoke(): resolves {data,error}, never rejects. */
  window.__mcEdgeInvoke = function (fn, body, apikey) {
    var native = window.__mcEdgeNative;
    return Promise.resolve().then(function () {
      return native(String(fn), body || {}, String(apikey || ''), EDGE_TIMEOUT_MS);
    }).then(function (r) {
      var parsed = null;
      try { parsed = r && r.text ? JSON.parse(r.text) : null; } catch (_) { parsed = null; }
      if (r && r.status >= 200 && r.status < 300) return { data: parsed, error: null };
      return { data: null, error: httpError(r ? r.status : 0, parsed) };
    }, function (err) {
      var timeout = err && (err.name === 'TimeoutError' || /timed? ?out/i.test(String(err.message || err)));
      return { data: null, error: netError(timeout
        ? 'The server did not respond in time. Check your connection and try again.'
        : 'Could not reach the server. Check your internet connection and try again.', timeout ? 'deadline-exceeded' : 'unavailable') };
    });
  };

  // ---- Back / Escape ---------------------------------------------------------------------------------------
  /* Returns true when the page consumed the "back" action; false lets the native layer offer to exit. */
  window.__mcHandleBack = function () {
    try {
      var open = document.querySelector('dialog[open], .modal:not(.hidden), [role="dialog"]:not(.hidden)');
      if (open) {
        var c = open.querySelector('[data-close], .close, button.secondary, button.ghost');
        if (c) { c.click(); return true; }
      }
      var vis = function (id) { var el = document.getElementById(id); return el && !el.classList.contains('hidden'); };
      if (vis('publicView')) { document.getElementById('pubBackTop').click(); return true; }
      if (vis('registerView')) { document.getElementById('regBack').click(); return true; }
      if (vis('recoveryView')) { document.getElementById('recoveryCancel').click(); return true; }
      var fg = document.getElementById('forgotForm');
      if (vis('loginView') && fg && !fg.classList.contains('hidden')) { document.getElementById('forgotBtn').click(); return true; }
      if (vis('appView')) {
        var home = typeof homePage === 'function' ? homePage() : 'dashboard';
        var cur = typeof currentPage === 'string' ? currentPage : home;
        if (cur !== home && typeof renderPage === 'function') {
          if (typeof activePerson !== 'undefined') activePerson = null;
          renderPage(home); return true;
        }
      }
    } catch (_) {}
    return false;
  };
})();
