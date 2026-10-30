// Renders either a text prompt or a serial-port chooser. All text is set via textContent (never innerHTML).
(async () => {
  const cfg = await window.mcDialog.init();
  const $ = (id) => document.getElementById(id);
  document.title = cfg.title || 'Medical Card';
  $('msg').textContent = cfg.message || '';
  $('cancel').onclick = () => window.mcDialog.done(null);
  if (cfg.mode === 'prompt') {
    const v = $('val'); v.hidden = false; v.value = cfg.value || ''; v.focus(); v.select();
    $('ok').hidden = false;
    const submit = () => window.mcDialog.done(v.value);
    $('ok').onclick = submit;
    v.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') window.mcDialog.done(null); });
  } else {
    const list = $('list'); list.hidden = false;
    if (!cfg.ports.length) {
      $('msg').textContent = 'No serial ports were found.\n\nUSB reader: plug in the Arduino.\nBluetooth (HC-05): pair it in Windows Settings, then open "More Bluetooth options → COM Ports" — it appears as a "Standard Serial over Bluetooth link (COMx)" port.\n\nClose this window and press Connect again once the port exists.';
      list.hidden = true;
    }
    for (const p of cfg.ports) {
      const b = document.createElement('button'); b.className = 'port'; b.textContent = p.label;
      b.onclick = () => window.mcDialog.done(p.id); list.appendChild(b);
    }
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.mcDialog.done(null); });
  }
})();
