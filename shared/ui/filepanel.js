/* The file panel — one way to open a file, in every tool.
 *
 * All three apps had drifted apart here: one hid the drop zone entirely after
 * loading and moved "open" to a topbar button, one left a full-size drop zone
 * sitting there forever, and one never showed the filename at all. This owns
 * the whole interaction so they can't drift again.
 *
 * Three states, and it is always visible — a loaded file shrinks the panel to a
 * compact bar rather than hiding it:
 *
 *   empty    the full dashed drop zone, inviting a file
 *   loaded   a compact bar: filename, optional detail, Change file / Close
 *   error    the drop zone plus a message saying what was wrong and why
 *
 * Usage:
 *
 *   var panel = FilePanel.create({
 *     mount: document.getElementById('file-panel'),
 *     accept: '.fit',
 *     prompt: 'Drop a <strong>.fit</strong> file here, or click to choose',
 *     onFile: function (file) { ... },      // required
 *     onClear: function () { ... }          // optional; omit to hide Close
 *   });
 *
 *   panel.setLoaded('swim.fit', '29 lengths · 725 m');
 *   panel.showError('That is not a FIT file.', 'It has no .FIT signature.');
 *   panel.setEmpty();
 *
 * The error region lives outside the swappable content on purpose: an app that
 * hides its drop zone once a file is open must still be able to report a
 * failure that happens later (the swim corrector used to write export errors
 * into a hidden element, so they were never seen).
 */
(function (root) {
  'use strict';

  function el(tag, className, html) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    if (html != null) e.innerHTML = html;
    return e;
  }

  function create(opts) {
    if (!opts || !opts.mount) throw new Error('FilePanel needs a mount element.');
    if (typeof opts.onFile !== 'function') throw new Error('FilePanel needs an onFile callback.');

    var mount = opts.mount;
    var accept = opts.accept || '';
    var prompt = opts.prompt || 'Drop a file here, or click to choose';

    mount.classList.add('filepanel');
    mount.innerHTML = '';

    // One real input, reused by every route into the picker.
    var input = el('input');
    input.type = 'file';
    if (accept) input.accept = accept;
    input.hidden = true;

    var slot = el('div', 'filepanel-slot');
    var errorSlot = el('div', 'filepanel-error');
    errorSlot.setAttribute('role', 'alert');

    mount.appendChild(input);
    mount.appendChild(slot);
    mount.appendChild(errorSlot);

    function pick() { input.click(); }

    input.addEventListener('change', function () {
      var f = input.files && input.files[0];
      // Clear first, so re-picking the same file still fires a change event.
      input.value = '';
      if (f) opts.onFile(f);
    });

    function buildEmpty() {
      var drop = el('div', 'filedrop', '<p>' + prompt + '</p>');
      drop.setAttribute('role', 'button');
      drop.setAttribute('tabindex', '0');

      drop.addEventListener('click', pick);
      // The drop zone claims to be a button, so it has to behave like one.
      drop.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
          e.preventDefault();
          pick();
        }
      });
      ['dragenter', 'dragover'].forEach(function (ev) {
        drop.addEventListener(ev, function (e) {
          e.preventDefault();
          drop.classList.add('filedrop--active');
        });
      });
      ['dragleave', 'dragend'].forEach(function (ev) {
        drop.addEventListener(ev, function () { drop.classList.remove('filedrop--active'); });
      });
      drop.addEventListener('drop', function (e) {
        e.preventDefault();
        drop.classList.remove('filedrop--active');
        var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (f) opts.onFile(f);
      });
      return drop;
    }

    function buildLoaded(name, detail) {
      var bar = el('div', 'filepanel-loaded');
      var info = el('div', 'filepanel-info');
      var nameEl = el('span', 'filepanel-name');
      nameEl.textContent = name;
      nameEl.title = name;
      info.appendChild(nameEl);
      if (detail) {
        var d = el('span', 'filepanel-detail');
        d.textContent = detail;
        info.appendChild(d);
      }
      bar.appendChild(info);

      var actions = el('div', 'filepanel-actions');
      var change = el('button', 'small');
      change.type = 'button';
      change.textContent = 'Change file';
      change.addEventListener('click', pick);
      actions.appendChild(change);

      if (typeof opts.onClear === 'function') {
        var close = el('button', 'small ghost');
        close.type = 'button';
        close.textContent = 'Close';
        close.addEventListener('click', function () { opts.onClear(); });
        actions.appendChild(close);
      }
      bar.appendChild(actions);

      // Dropping onto the compact bar swaps the file too — the affordance
      // shrinks, but it doesn't stop working.
      ['dragenter', 'dragover'].forEach(function (ev) {
        bar.addEventListener(ev, function (e) {
          e.preventDefault();
          bar.classList.add('filepanel-loaded--active');
        });
      });
      ['dragleave', 'dragend'].forEach(function (ev) {
        bar.addEventListener(ev, function () { bar.classList.remove('filepanel-loaded--active'); });
      });
      bar.addEventListener('drop', function (e) {
        e.preventDefault();
        bar.classList.remove('filepanel-loaded--active');
        var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (f) opts.onFile(f);
      });

      return bar;
    }

    var api = {
      setEmpty: function () {
        slot.innerHTML = '';
        slot.appendChild(buildEmpty());
        return api;
      },
      setLoaded: function (name, detail) {
        slot.innerHTML = '';
        slot.appendChild(buildLoaded(name, detail));
        return api;
      },
      showError: function (title, detail) {
        errorSlot.innerHTML = '';
        var box = el('div', 'error');
        box.appendChild(el('span', 'error-icon', '&#9888;'));
        var body = el('div');
        var t = el('strong');
        t.textContent = title;
        body.appendChild(t);
        if (detail) {
          var d = el('span');
          d.textContent = detail;
          body.appendChild(d);
        }
        box.appendChild(body);
        errorSlot.appendChild(box);
        return api;
      },
      clearError: function () {
        errorSlot.innerHTML = '';
        return api;
      },
      open: pick
    };

    api.setEmpty();
    return api;
  }

  var apiRoot = { create: create };

  if (typeof module !== 'undefined' && module.exports) module.exports = apiRoot;
  else root.FilePanel = apiRoot;

})(typeof self !== 'undefined' ? self : this);
