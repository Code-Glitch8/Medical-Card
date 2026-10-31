/* Android shim: provides a Web-Serial-compatible navigator.serial on top of the native Bluetooth Classic (SPP)
 * bridge, so the site's existing connectSerial()/readSerialLoop()/sendSerialLine() code runs unchanged.
 * The bridge object "McNative" is injected by Android's WebViewCompat.addWebMessageListener and exists ONLY for
 * the app's own origin. Without it (plain browser) this file does nothing.
 * Wire protocol to the Arduino is untouched: newline-terminated text lines (UID:/CARD:/CODE:/INFO:/ERR:).
 */
(function () {
  'use strict';
  window.__mcPlatform = 'android';
  var bridge = window.McNative;
  if (!bridge || typeof bridge.postMessage !== 'function') return;

  var listeners = [];          // one-shot waiters for native events
  var current = null;          // the single open port (one Bluetooth link at a time)
  function send(msg) { bridge.postMessage(JSON.stringify(msg)); }
  function waitFor(evNames, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () { drop(); reject(new DOMException('No response from the Android Bluetooth layer.', 'TimeoutError')); }, timeoutMs);
      function drop() { clearTimeout(t); var i = listeners.indexOf(l); if (i >= 0) listeners.splice(i, 1); }
      var l = function (m) { if (evNames.indexOf(m.ev) < 0) return false; drop(); resolve(m); return true; };
      listeners.push(l);
    });
  }
  // Edge Functions through the native HTTPS stack (see native/common.js). One request id per call.
  var edgeWaiters = {}, edgeSeq = 0;
  window.__mcEdgeNative = function (fn, body, apikey, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var id = 'e' + (++edgeSeq);
      var t = setTimeout(function () { delete edgeWaiters[id]; reject(new DOMException('timed out', 'TimeoutError')); }, timeoutMs + 5000);
      edgeWaiters[id] = function (m) { clearTimeout(t); if (m.error) reject(new DOMException(m.error, m.error === 'timeout' ? 'TimeoutError' : 'NetworkError')); else resolve({ status: m.status, text: m.body }); };
      send({ op: 'edge', id: id, fn: fn, body: JSON.stringify(body), apikey: apikey, timeoutMs: timeoutMs });
    });
  };
  bridge.onmessage = function (e) {
    var m; try { m = JSON.parse(e.data); } catch (_) { return; }
    if (m.ev === 'edge') { var w = edgeWaiters[m.id]; if (w) { delete edgeWaiters[m.id]; w(m); } return; }
    if (m.ev === 'data') { if (current) current._push(m.b64); return; }
    if (m.ev === 'closed') { if (current) current._lost(m.error || ''); return; }
    for (var i = 0; i < listeners.length; i++) if (listeners[i](m)) return;
  };

  function b64ToBytes(b64) { var s = atob(b64), a = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) a[i] = s.charCodeAt(i); return a; }
  function bytesToB64(u8) { var s = ''; for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return btoa(s); }

  function BtPort(address) {
    this._address = address; this._ctrl = null; this._open = false;
    this.readable = null; this.writable = null;
  }
  // Bounded queue: if the page stops reading, never grow without limit (64 KiB), drop the link instead.
  BtPort.prototype._push = function (b64) {
    if (!this._ctrl) return;
    try {
      if (this._ctrl.desiredSize !== null && this._ctrl.desiredSize < -65536) { send({ op: 'close' }); this._lost('Reader data overflow.'); return; }
      this._ctrl.enqueue(b64ToBytes(b64));
    } catch (_) {}
  };
  BtPort.prototype._lost = function (reason) {
    if (!this._open) return;
    this._open = false;
    var c = this._ctrl; this._ctrl = null;
    // Real Web Serial rejects the pending read with NetworkError when the device vanishes; the site's
    // existing catch-block then shows "Reader error" and cleans up. Never pretend we are still connected.
    if (c) { try { c.error(new DOMException(reason || 'Bluetooth connection lost.', 'NetworkError')); } catch (_) {} }
    this.readable = null; this.writable = null; if (current === this) current = null;
  };
  BtPort.prototype.open = function (opts) {
    var self = this;
    if (self._open) return Promise.reject(new DOMException('The port is already open.', 'InvalidStateError'));
    var baud = (opts && opts.baudRate) | 0;
    // The site uses 115200 for the direct-USB Arduino. Android has no USB-serial path in this app.
    if (baud === 115200) {
      return Promise.reject(new DOMException('USB serial is not supported on Android. Select 9600 baud and connect the HC-05 Bluetooth reader.', 'NotSupportedError'));
    }
    var pending = waitFor(['opened', 'open_failed', 'pick_failed'], 45000);
    send({ op: 'open', address: self._address });
    return pending.then(function (m) {
      if (m.ev !== 'opened') throw new DOMException(m.error || 'Could not connect to the Bluetooth reader.', 'NetworkError');
      self._open = true; current = self;
      self.readable = new ReadableStream({
        start: function (c) { self._ctrl = c; },
        cancel: function () { /* like Web Serial: cancel just stops reading; close() closes the link */ }
      });
      self.writable = new WritableStream({
        write: function (chunk) {
          if (!self._open) throw new DOMException('Bluetooth connection lost.', 'NetworkError');
          send({ op: 'write', b64: bytesToB64(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk)) });
        }
      });
    });
  };
  BtPort.prototype.close = function () {
    var self = this;
    if (self._open) {
      self._open = false;
      var c = self._ctrl; self._ctrl = null;
      if (c) { try { c.close(); } catch (_) {} }
      send({ op: 'close' });
    }
    self.readable = null; self.writable = null; if (current === self) current = null;
    return Promise.resolve();
  };
  BtPort.prototype.getInfo = function () { return {}; };

  var serial = {
    // Shows the NATIVE device picker (paired Bluetooth devices only), like Chrome's port chooser.
    requestPort: function () {
      var pending = waitFor(['picked', 'pick_cancelled', 'pick_failed'], 5 * 60 * 1000);
      send({ op: 'pick' });
      return pending.then(function (m) {
        if (m.ev === 'picked') return new BtPort(m.address);
        throw new DOMException(m.error || 'No device selected.', m.ev === 'pick_failed' ? 'SecurityError' : 'NotFoundError');
      });
    },
    getPorts: function () { return Promise.resolve([]); },
    addEventListener: function () {}, removeEventListener: function () {}
  };
  try { Object.defineProperty(navigator, 'serial', { value: serial, configurable: true }); } catch (_) {}
})();
