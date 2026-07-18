/* Chart palette, shared by all three tools.
 *
 * The charts can't just read CSS custom properties: two of them bake colours
 * into exported SVG/PNG, which has to look right outside the page it came from.
 * So the palette lives here in JS and is kept in step with shared/ui/tokens.css
 * by hand — if you change one, change the other.
 *
 *   var t = ChartTheme.resolve();          // follows the page's light/dark
 *   var t = ChartTheme.resolve('dark');    // or force one
 *   t.bg, t.fg, t.gridline, t.baseline, t.muted
 *   ChartTheme.SERIES.pace                 // per-metric series colours
 */
(function (root) {
  'use strict';

  var THEMES = {
    light: {
      bg: '#ffffff',
      fg: '#16191d',
      muted: '#6b7684',
      gridline: '#e7ebf0',
      baseline: '#c3c9d1',
      surface2: '#f1f3f6',
      border: '#dde2e8'
    },
    dark: {
      bg: '#1a1f26',
      fg: '#e7eaee',
      muted: '#8e99a6',
      gridline: '#262c35',
      baseline: '#3a424d',
      surface2: '#232932',
      border: '#2c333d'
    }
  };

  /* Series colours are theme-independent on purpose: a metric keeps its
   * identity in light and dark, and in an exported image. They are chosen to
   * stay legible on both backgrounds. */
  var SERIES = {
    // running / cycling
    pace: '#fc4c02',
    cadence: '#2f80ed',
    stride: '#27ae60',
    heartRate: '#eb5757',
    // swimming
    swimPace: '#0aa5c9',
    lengthTime: '#3b6ea5',
    strokes: '#8e6fd8',
    swolf: '#e08a2b',
    // stair climbing
    plan: '#2f6feb',
    altitude: '#8e6fd8'
  };

  /* Semantic colours for chart annotations — flagged lengths, rest periods and
   * the like. These do shift between themes, so they read against the plot
   * background rather than the page. */
  var SEMANTIC = {
    light: { good: '#1f9d4d', goodText: '#127036', warning: '#d98324', critical: '#d03b3b', rest: '#9aa4b1' },
    dark:  { good: '#35b863', goodText: '#4cc97a', warning: '#e0a03f', critical: '#e05c5c', rest: '#5c6672' }
  };

  /* Which theme the page is currently showing: an explicit data-theme on the
   * root element wins, otherwise the system preference. */
  function current() {
    if (typeof document !== 'undefined' && document.documentElement) {
      var forced = document.documentElement.getAttribute('data-theme');
      if (forced === 'light' || forced === 'dark') return forced;
    }
    if (typeof window !== 'undefined' && window.matchMedia &&
        window.matchMedia('(prefers-color-scheme: dark)').matches) {
      return 'dark';
    }
    return 'light';
  }

  function resolve(theme) {
    var name = (theme === 'light' || theme === 'dark') ? theme : current();
    var base = THEMES[name];
    var sem = SEMANTIC[name];
    var out = { theme: name };
    for (var k in base) if (Object.prototype.hasOwnProperty.call(base, k)) out[k] = base[k];
    for (var s in sem) if (Object.prototype.hasOwnProperty.call(sem, s)) out[s] = sem[s];
    return out;
  }

  var api = { THEMES: THEMES, SERIES: SERIES, SEMANTIC: SEMANTIC, current: current, resolve: resolve };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ChartTheme = api;

})(typeof self !== 'undefined' ? self : this);
