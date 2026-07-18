/* App icons, drawn to one recipe so the suite looks like a set.
 *
 * The rules, taken from the swim corrector's original mark:
 *   - 20x20 viewBox, no fill on the root
 *   - 1.6 stroke width, round caps and joins
 *   - everything strokes in var(--accent), so each app's icon takes its own
 *     colour and the whole thing follows light/dark for free
 *   - one element dropped to 0.45 opacity, for depth
 *   - exactly one filled circle, as the focal point
 *
 * Used by the landing page and by each app's header, so the icon in the tool
 * and the icon on the front page cannot drift apart.
 *
 *   <span class="app-icon" data-icon="swim"></span>
 * then Icons.render() — or Icons.svg('swim') for the markup directly.
 */
(function (root) {
  'use strict';

  var S = 'stroke="var(--accent)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"';

  function wrap(size, body) {
    return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 20 20" ' +
           'fill="none" aria-hidden="true" focusable="false">' + body + '</svg>';
  }

  var PATHS = {
    /* Swimmer over water: two waves, a head and an arm. */
    swim:
      '<path d="M1 13.5c1.8 0 1.8 1.6 3.6 1.6s1.8-1.6 3.6-1.6 1.8 1.6 3.6 1.6 1.8-1.6 3.6-1.6 1.8 1.6 3.6 1.6" ' + S + '/>' +
      '<path d="M1 17c1.8 0 1.8 1.6 3.6 1.6S6.4 17 8.2 17s1.8 1.6 3.6 1.6S13.6 17 15.4 17s1.8 1.6 3.6 1.6" ' + S + ' opacity=".45"/>' +
      '<circle cx="13.5" cy="4.2" r="2.2" fill="var(--accent)"/>' +
      '<path d="M4 10.2 8.8 7l4 2.2" ' + S + '/>',

    /* A climb: the lower steps fade back, the upper ones lead to a figure
       standing at the top. */
    stairs:
      '<path d="M1 17h4v-4h4" ' + S + ' opacity=".45"/>' +
      '<path d="M9 13v-4h4v-4h3" ' + S + '/>' +
      '<circle cx="16" cy="2.8" r="2.2" fill="var(--accent)"/>',

    /* Rising bars on a baseline, the latest crowned as a plotted point. The
       bars ascend left to right rather than peaking in the middle — a tall
       centre bar with a dot on top reads as a thermometer at 22px. */
    graphs:
      '<path d="M1.5 17.5h17" ' + S + ' opacity=".45"/>' +
      '<path d="M4.5 17.5v-4M9.5 17.5v-6.5M14.5 17.5v-7.5" ' + S + '/>' +
      '<circle cx="14.5" cy="7.8" r="2.2" fill="var(--accent)"/>',

    /* Sliders: the suite's settings. */
    settings:
      '<path d="M3 6h9M3 14h5" ' + S + ' opacity=".45"/>' +
      '<path d="M16 6h1M12 14h5" ' + S + '/>' +
      '<circle cx="14" cy="6" r="2.2" fill="var(--accent)"/>' +
      '<circle cx="10" cy="14" r="2.2" fill="var(--accent)"/>'
  };

  function svg(name, size) {
    var body = PATHS[name];
    if (!body) return '';
    return wrap(size || 22, body);
  }

  /* Fills every <span class="app-icon" data-icon="…"> on the page. */
  function render(scope) {
    var host = scope || document;
    var nodes = host.querySelectorAll('[data-icon]');
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i];
      var markup = svg(n.getAttribute('data-icon'), n.getAttribute('data-icon-size'));
      if (markup) n.innerHTML = markup;
    }
  }

  var api = { svg: svg, render: render, PATHS: PATHS };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Icons = api;

  // Self-render once the document is ready, so a page only needs the markup.
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function () { render(); });
    } else {
      render();
    }
  }

})(typeof self !== 'undefined' ? self : this);
