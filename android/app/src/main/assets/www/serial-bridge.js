/* Medical Card native serial compatibility layer.
 * Provides the subset of the Web Serial API used by index.html, backed by
 * Android Bluetooth Classic SPP or Windows COM-port IPC. It does not change
 * the Arduino text protocol (PRECHECK / CODE: / UID: / INFO: / ERR: lines).
 */
(() => {
  'use strict';
  const android = window.MedicalCardAndroid || null;
  const desktop = window.medicalCardDesktopSerial || null;
  if (!android && !desktop) return;

  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const isAndroid = !!android;

  function decodeJson(raw, fallback) {
    try { return typeof raw === 'string' ? JSON.parse(raw) : raw; }
    catch { return fallback; }
  }
  function decodeBase64(text) {
    const binary = atob(text || '');
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }
  function encodeBase64(value) {
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + 0x8000, bytes.length)));
    }
    return btoa(binary);
  }

  async function listDevices() {
    let result;
    if (isAndroid) result = decodeJson(android.getPairedDevices(), []);
    else result = await desktop.listPorts();
    if (!Array.isArray(result)) throw new Error((result && result.error) || 'The serial device list could not be loaded.');
    return result;
  }

  function chooseDevice(items) {
    return new Promise((resolve, reject) => {
      const old = document.getElementById('mc-native-serial-picker');
      if (old) old.remove();
      const overlay = document.createElement('div');
      overlay.id = 'mc-native-serial-picker';
      Object.assign(overlay.style, {
        position: 'fixed', inset: '0', zIndex: '2147483647', background: 'rgba(2,6,23,.72)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '18px',
        fontFamily: 'system-ui, sans-serif'
      });
      const panel = document.createElement('div');
      Object.assign(panel.style, {
        width: 'min(520px, 100%)', maxHeight: '85vh', overflow: 'auto',
        background: '#fff', color: '#111827', borderRadius: '16px', padding: '20px',
        boxShadow: '0 20px 60px rgba(0,0,0,.35)'
      });
      const heading = document.createElement('h2');
      heading.textContent = isAndroid ? 'Choose paired HC-05 Bluetooth device' : 'Choose reader COM port';
      heading.style.marginTop = '0';
      const hint = document.createElement('p');
      hint.textContent = isAndroid
        ? 'Pair the HC-05 in Android Settings first. This app lists already-paired devices only.'
        : 'Select the COM port assigned to your HC-05 or USB serial reader.';
      hint.style.color = '#475569';
      panel.append(heading, hint);
      const finish = (value, error) => {
        overlay.remove();
        if (error) reject(error); else resolve(value);
      };
      if (!items.length) {
        const empty = document.createElement('p');
        empty.textContent = isAndroid
          ? 'No paired Bluetooth devices were found. Pair the HC-05 in Android Settings and try again.'
          : 'No serial ports were found. Connect the reader and check Windows Device Manager.';
        panel.appendChild(empty);
      }
      for (const item of items) {
        const button = document.createElement('button');
        const label = isAndroid
          ? `${item.name || 'Bluetooth device'} — ${item.address || ''}`
          : `${item.path || 'Serial port'}${item.manufacturer ? ' — ' + item.manufacturer : ''}`;
        button.textContent = label;
        Object.assign(button.style, {
          display: 'block', width: '100%', padding: '12px', margin: '8px 0',
          textAlign: 'left', borderRadius: '10px', border: '1px solid #cbd5e1',
          background: '#f8fafc', color: '#111827', cursor: 'pointer', whiteSpace: 'normal'
        });
        button.addEventListener('click', () => finish(item));
        panel.appendChild(button);
      }
      const cancel = document.createElement('button');
      cancel.textContent = 'Cancel';
      Object.assign(cancel.style, {
        padding: '10px 14px', borderRadius: '9px', border: '0', background: '#e2e8f0',
        color: '#0f172a', cursor: 'pointer', marginTop: '8px'
      });
      cancel.addEventListener('click', () => finish(null, new DOMException('Port selection cancelled.', 'AbortError')));
      overlay.addEventListener('click', event => {
        if (event.target === overlay) finish(null, new DOMException('Port selection cancelled.', 'AbortError'));
      });
      panel.appendChild(cancel);
      overlay.appendChild(panel);
      document.body.appendChild(overlay);
    });
  }

  class NativePort {
    constructor(device) {
      this.device = device;
      this.readable = { getReader: () => this._makeReader() };
      this.writable = { getWriter: () => this._makeWriter() };
      this.isOpen = false;
      this.cancelled = false;
      this._readActive = false;
    }
    async open(options = {}) {
      const baudRate = Number(options.baudRate || 9600);
      if (isAndroid) {
        const status = android.beginConnect(String(this.device.address), baudRate);
        if (status && status.startsWith('error:')) throw new Error(status.slice(6));
        const until = Date.now() + 18000;
        while (Date.now() < until) {
          const s = String(android.getConnectionStatus() || '');
          if (s === 'connected') { this.isOpen = true; return; }
          if (s.startsWith('error:')) throw new Error(s.slice(6));
          if (s === 'disconnected') throw new Error('Bluetooth connection failed. Check that the HC-05 is powered and paired.');
          await pause(120);
        }
        try { android.disconnect(); } catch {}
        throw new Error('Bluetooth connection timed out. Check that the HC-05 is in range and not busy.');
      }
      await desktop.openPort(String(this.device.path), baudRate);
      this.isOpen = true;
    }
    _makeReader() {
      const port = this;
      let released = false;
      return {
        async read() {
          if (released || port.cancelled || !port.isOpen) return { value: undefined, done: true };
          while (!released && !port.cancelled && port.isOpen) {
            let result;
            if (isAndroid) result = decodeJson(android.readChunk(), { status: 'disconnected', data: '' });
            else result = await desktop.readChunk();
            if (typeof result === 'string') result = decodeJson(result, { status: 'disconnected', data: '' });
            if (result && result.data) return { value: decodeBase64(result.data), done: false };
            if (result && result.status === 'error') {
              port.isOpen = false;
              const nativeError = isAndroid ? String(android.getConnectionStatus() || '').replace(/^error:/, '') : (result.error || 'Serial connection failed.');
              throw new Error(nativeError || 'Serial connection failed.');
            }
            if (!result || result.status === 'disconnected') {
              port.isOpen = false;
              return { value: undefined, done: true };
            }
            await pause(25);
          }
          return { value: undefined, done: true };
        },
        async cancel() { port.cancelled = true; return; },
        releaseLock() { released = true; }
      };
    }
    _makeWriter() {
      const port = this;
      return {
        async write(value) {
          if (!port.isOpen) throw new Error('Reader is not connected.');
          const encoded = encodeBase64(value);
          const result = isAndroid ? android.writeData(encoded) : await desktop.writeData(encoded);
          if (result === false || result === 'error') throw new Error('The serial write failed.');
        },
        releaseLock() {}
      };
    }
    async close() {
      this.cancelled = true;
      this.isOpen = false;
      if (isAndroid) android.disconnect(); else await desktop.closePort();
    }
  }

  const serial = {
    async requestPort() {
      const devices = await listDevices();
      const chosen = await chooseDevice(devices);
      return new NativePort(chosen);
    }
  };
  try {
    Object.defineProperty(navigator, 'serial', { configurable: true, enumerable: true, value: serial });
  } catch {
    // Keep the app usable for manual code entry if the host does not allow a shim.
  }
  window.MedicalCardSerialBridgeReady = true;
})();
