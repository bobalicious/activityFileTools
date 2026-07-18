/* The help modal — one per app, built from markdown embedded in the page.
 *
 * Put the text in the page as
 *   <script type="text/markdown" id="help-src"> ... </script>
 * and call Help.install({ trigger: helpButton }). The markdown is rendered
 * once, on first open.
 *
 * Embedded rather than fetched because the apps run from file://, where fetch
 * is blocked — so each app's help text is a copy of the parts of its README
 * that matter in the app. Keep them in step.
 */
(function (root) {
  'use strict';

  function install(opts) {
    opts = opts || {};
    var srcId = opts.sourceId || 'help-src';
    var src = document.getElementById(srcId);
    if (!src) return null;

    var rendered = false;
    var lastFocus = null;

    var modal = document.createElement('div');
    modal.className = 'modal hidden';
    modal.innerHTML =
      '<div class="modal-backdrop"></div>' +
      '<div class="modal-panel" role="dialog" aria-modal="true" aria-label="' +
        (opts.label || 'Help') + '">' +
        '<button class="modal-close" aria-label="Close">&times;</button>' +
        '<div class="markdown"></div>' +
      '</div>';
    document.body.appendChild(modal);

    var panel = modal.querySelector('.modal-panel');
    var body = modal.querySelector('.markdown');
    var closeBtn = modal.querySelector('.modal-close');

    function open() {
      if (!rendered) {
        body.innerHTML = root.Markdown.render(src.textContent || '');
        rendered = true;
      }
      lastFocus = document.activeElement;
      modal.classList.remove('hidden');
      // Move focus in, so the dialog is where the keyboard already is.
      closeBtn.focus();
      document.addEventListener('keydown', onKeydown, true);
    }

    function close() {
      modal.classList.add('hidden');
      document.removeEventListener('keydown', onKeydown, true);
      // Put focus back where the user left it.
      if (lastFocus && lastFocus.focus) lastFocus.focus();
      lastFocus = null;
    }

    function isOpen() { return !modal.classList.contains('hidden'); }

    /* Escape closes; Tab is kept inside the dialog. Without the trap, tabbing
     * walks out of the modal and into the page behind it. */
    function onKeydown(e) {
      if (!isOpen()) return;
      if (e.key === 'Escape') { e.preventDefault(); close(); return; }
      if (e.key !== 'Tab') return;

      var focusable = panel.querySelectorAll(
        'a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])');
      if (!focusable.length) return;
      var first = focusable[0], last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }

    closeBtn.addEventListener('click', close);
    modal.querySelector('.modal-backdrop').addEventListener('click', close);
    if (opts.trigger) opts.trigger.addEventListener('click', function (e) { e.preventDefault(); open(); });
    (opts.extraTriggers || []).forEach(function (t) {
      if (t) t.addEventListener('click', function (e) { e.preventDefault(); open(); });
    });

    return { open: open, close: close, isOpen: isOpen };
  }

  var api = { install: install };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Help = api;

})(typeof self !== 'undefined' ? self : this);
