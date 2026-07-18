/* Browser behaviour tests. Run with:  node test/behaviour.js
 *
 * These exist because the three apps had each invented their own answer to the
 * same questions — what happens to the upload control after a file loads, how a
 * rejection is reported, whether there is any help. The consolidation is only
 * real if it stays true, so it is asserted rather than eyeballed.
 *
 * Asserts, in all three apps:
 *   - a bad file produces an inline .error with a title AND a detail
 *   - the file panel is still on screen after that failure
 *   - a good file shrinks the panel to the compact bar with a filename
 *   - Change file / Close are present
 *   - the help modal exists and opens
 * Driven in headless Chrome against the real pages. */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');

/* Needs a real browser: these are DOM behaviours, not logic. Skips rather than
 * fails when Chrome isn't where we expect it — the FIT tests in run.js are the
 * ones that must always run. */
const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];
const CHROME = CHROME_CANDIDATES.find(function (p) { return fs.existsSync(p); });
if (!CHROME) {
  console.log('No Chrome found — skipping browser behaviour tests.');
  process.exit(0);
}

const APPS = [
  { name: 'stairinator', dir: 'apps/stairinator',
    good: 'apps/stairinator/sample.gpx', pre: "document.getElementById('tab-btn-activity').click();" },
  { name: 'bd-licious-graphs', dir: 'apps/bd-licious-graphs',
    good: 'apps/bd-licious-graphs/samples/Strictly_Zone_2.fit', pre: '' },
  { name: 'swim-corrector', dir: 'apps/swim-corrector',
    good: 'apps/swim-corrector/test-data/750m_Breaststroke_Swolf_66.fit', pre: '' },
];

function run(app, mode) {
  const bytes = mode === 'good'
    ? fs.readFileSync(path.join(ROOT, app.good)).toString('base64')
    : Buffer.from('not a fit file at all, and not GPX either').toString('base64');
  const name = mode === 'good' ? 'sample' + path.extname(app.good) : 'notafit.txt';

  const drive = `
<script>
(function () {
  function report(o) {
    var d = document.createElement('div');
    d.id = '__result';
    d.textContent = JSON.stringify(o);
    document.body.appendChild(d);
  }
  window.addEventListener('load', function () {
    setTimeout(function () {
      try {
        ${app.pre}
        var bin = atob('${bytes}'), b = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
        var file = new File([b], '${name}');
        var input = document.querySelector('#file-panel input[type=file]');
        var dt = new DataTransfer(); dt.items.add(file);
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      } catch (e) { report({ fatal: e.message }); return; }

      // Poll rather than guess a delay: the file read is async and real-time,
      // while Chrome's virtual clock races timers ahead of it.
      var waited = 0;
      (function settle() {
        var e = document.querySelector('#file-panel .error');
        var l = document.querySelector('#file-panel .filepanel-loaded');
        if (!e && !l && waited < 6000) { waited += 100; return setTimeout(settle, 100); }
        var err = document.querySelector('#file-panel .error');
        var loaded = document.querySelector('#file-panel .filepanel-loaded');
        var drop = document.querySelector('#file-panel .filedrop');
        var help = document.getElementById('btn-help');
        var modalBefore = document.querySelector('.modal');
        if (help) help.click();
        var modal = document.querySelector('.modal');
        report({
          panelPresent: !!document.getElementById('file-panel'),
          errorShown: !!err,
          errorTitle: err ? (err.querySelector('strong') || {}).textContent : null,
          errorDetail: err ? ((err.querySelectorAll('span')[1] || {}).textContent || null) : null,
          dropVisible: !!drop,
          loadedBar: !!loaded,
          filename: loaded ? loaded.querySelector('.filepanel-name').textContent : null,
          detail: loaded ? (loaded.querySelector('.filepanel-detail') || {}).textContent : null,
          actions: loaded ? Array.prototype.map.call(loaded.querySelectorAll('button'), function (b) { return b.textContent; }) : [],
          helpButton: !!help,
          settingsLink: !!document.querySelector('.app-bar a[href$="settings.html"]'),
          appBar: !!document.querySelector('.app-bar .app-nav'),
          pageWidth: (function () {
            var el = document.querySelector('.page') || document.querySelector('main');
            return el ? getComputedStyle(el).maxWidth : null;
          })(),
          ownExportImport: !!document.querySelector('#btn-export, #btn-import'),
          barHeight: (function () {
            var b = document.querySelector('.app-bar');
            return b ? Math.round(b.getBoundingClientRect().height) : null;
          })(),
          iconSvg: (function () {
            var i = document.querySelector('.app-header .app-icon svg');
            return i ? i.outerHTML.replace(/\s+/g, ' ') : null;
          })(),
          helpOpens: !!(modal && !modal.classList.contains('hidden')),
          modalPreexisting: !!modalBefore
        });
      })();
    }, 300);
  });
})();
</script>`;

  const tmp = path.join(ROOT, app.dir, '__behaviour.html');
  fs.writeFileSync(tmp, fs.readFileSync(path.join(ROOT, app.dir, 'index.html'), 'utf8')
    .replace('</body>', drive + '</body>'));
  let dom = '';
  try {
    dom = execFileSync(CHROME, ['--headless', '--disable-gpu', '--dump-dom',
      '--virtual-time-budget=6000', 'file://' + tmp],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
  } catch (e) { dom = ''; }
  fs.unlinkSync(tmp);
  const m = dom.match(/<div id="__result">([\s\S]*?)<\/div>/);
  if (!m) return { error: 'no result marker' };
  return JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>'));
}

let fails = 0;
const widths = [];
const bars = [];
const icons = {};
function check(label, cond, extra) {
  if (!cond) { fails++; console.log('  FAIL  ' + label + (extra ? '  → ' + extra : '')); }
  else console.log('  ok    ' + label);
}

for (const app of APPS) {
  console.log('\n' + app.name + ' — bad file');
  const bad = run(app, 'bad');
  check('inline error shown (no alert)', bad.errorShown, JSON.stringify(bad));
  check('error has a title', !!bad.errorTitle, bad.errorTitle);
  check('error has an actionable detail', !!bad.errorDetail, bad.errorDetail);
  check('drop zone still visible after failure', bad.dropVisible);
  check('help button present', bad.helpButton);
  check('help modal opens', bad.helpOpens);
  check('standard app bar', bad.appBar);
  check('Settings reachable from the app', bad.settingsLink);
  check('no app-level export/import', !bad.ownExportImport);
  check('header icon rendered from the shared set', !!bad.iconSvg, bad.iconSvg);
  widths.push([app.name, bad.pageWidth]);
  bars.push([app.name, bad.barHeight]);
  icons[app.name] = bad.iconSvg;

  console.log(app.name + ' — good file');
  const good = run(app, 'good');
  check('panel shrinks to loaded bar', good.loadedBar, JSON.stringify(good));
  check('filename shown', !!good.filename, good.filename);
  check('summary detail shown', !!good.detail, good.detail);
  check('Change file offered', (good.actions || []).indexOf('Change file') >= 0, JSON.stringify(good.actions));
  check('Close offered', (good.actions || []).indexOf('Close') >= 0, JSON.stringify(good.actions));
  check('no error left over', !good.errorShown, good.errorTitle);
}

console.log('\nchrome');
const barSet = [...new Set(bars.map(b => b[1]))];
check('every app bar is the same height', barSet.length === 1,
  bars.map(b => b[0] + '=' + b[1]).join(', '));

const distinct = [...new Set(widths.map(w => w[1]))];
check('all screens are the same width', distinct.length === 1,
  widths.map(w => w[0] + '=' + w[1]).join(', '));


// --- landing cards must show each tool's own colour -------------------------

function accentOf(rel, selector) {
  const drive = `
<script>
window.addEventListener('load', function () {
  setTimeout(function () {
    var el = document.querySelector('${selector}');
    var cs = el ? getComputedStyle(el) : null;
    var probe = null;
    if (el) {
      // Resolve --accent to a real colour by applying it to something.
      var d = document.createElement('span');
      d.style.color = 'var(--accent)';
      el.appendChild(d);
      probe = getComputedStyle(d).color;
      var b = document.createElement('span');
      b.style.borderColor = 'var(--accent)';
      b.style.borderStyle = 'solid';
      el.appendChild(b);
    }
    var out = document.createElement('div');
    out.id = '__accent';
    out.textContent = probe || 'none';
    document.body.appendChild(out);
  }, 250);
});
</script>`;
  const src = path.join(ROOT, rel);
  const tmp = path.join(path.dirname(src), '__accent-' + path.basename(src));
  if (path.resolve(tmp) === path.resolve(src)) throw new Error('refusing to overwrite ' + src);
  fs.writeFileSync(tmp, fs.readFileSync(src, 'utf8').replace('</body>', drive + '</body>'));
  let dom = '';
  try {
    dom = execFileSync(CHROME, ['--headless', '--disable-gpu', '--dump-dom',
      '--virtual-time-budget=4000', 'file://' + tmp],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
  } catch (e) { dom = ''; }
  fs.unlinkSync(tmp);
  const m = dom.match(/<div id="__accent">([\s\S]*?)<\/div>/);
  return m ? m[1].trim() : null;
}

console.log('\naccent colours');
[
  ['Stairinator', '.app--stairinator', 'apps/stairinator/index.html'],
  ['bd-licious graphs', '.app--graphs', 'apps/bd-licious-graphs/index.html'],
  ['Swim FIT Corrector', '.app--swim', 'apps/swim-corrector/index.html'],
].forEach(function (row) {
  const card = accentOf('index.html', row[1]);
  const app = accentOf(row[2], ':root');
  check(row[0] + ' card matches its app', card === app && !!card, 'card=' + card + ' app=' + app);
});

console.log(fails === 0 ? '\nAll behaviours consistent across the three apps.' : '\n' + fails + ' check(s) failed.');
process.exit(fails ? 1 : 0);
