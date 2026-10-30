/* Windows (Electron) shim. Chromium inside Electron already implements Web Serial, so navigator.serial is the
 * real thing and the site's serial code needs no adapter: the main process only supplies the port chooser
 * (session 'select-serial-port') and the permission policy.
 * What Electron does NOT provide is window.prompt() (it throws). The site uses prompt() in 3 places
 * (delete-profile name confirmation, allergy status), so it is routed to a modal dialog owned by the main process.
 * window.__mcDesktop is exposed by preload.cjs through contextBridge (context isolation stays ON).
 */
(function () {
  'use strict';
  var d = window.__mcDesktop;
  if (!d || typeof d.prompt !== 'function') return;
  window.prompt = function (message, def) {
    var r = d.prompt(String(message == null ? '' : message), def == null ? '' : String(def));
    return typeof r === 'string' ? r : null;       // null = cancelled, same as a browser
  };
})();
