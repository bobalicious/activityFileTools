// markdown.js — a tiny Markdown → HTML renderer supporting only the subset used
// by our README: h1–h3, paragraphs, bold, italic, inline code, links, and
// ordered / unordered lists (with wrapped continuation lines).
(function () {
  'use strict';
  window.Stair = window.Stair || {};

  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function inline(s) {
    s = escapeHtml(s);
    // Protect inline code spans (with a sentinel that can't occur in the text or
    // collide with normal numbers) before applying bold/italic/link formatting.
    var codes = [];
    s = s.replace(/`([^`]+)`/g, function (_, c) { codes.push(c); return '@@CODE' + (codes.length - 1) + '@@'; });
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    s = s.replace(/@@CODE(\d+)@@/g, function (_, i) { return '<code>' + codes[i] + '</code>'; });
    return s;
  }

  function render(md) {
    var lines = String(md).replace(/\r\n/g, '\n').split('\n');
    var html = [], para = [], listType = null, items = [];

    function flushPara() { if (para.length) { html.push('<p>' + inline(para.join(' ')) + '</p>'); para = []; } }
    function flushList() {
      if (listType) {
        html.push('<' + listType + '>' + items.map(function (x) { return '<li>' + inline(x) + '</li>'; }).join('') + '</' + listType + '>');
        listType = null; items = [];
      }
    }

    for (var i = 0; i < lines.length; i++) {
      var t = lines[i].trim();
      if (t === '') { flushPara(); flushList(); continue; }

      var h = /^(#{1,3})\s+(.*)$/.exec(t);
      if (h) { flushPara(); flushList(); html.push('<h' + h[1].length + '>' + inline(h[2]) + '</h' + h[1].length + '>'); continue; }

      var ul = /^-\s+(.*)$/.exec(t);
      var ol = /^\d+\.\s+(.*)$/.exec(t);
      if (ul) { flushPara(); if (listType && listType !== 'ul') flushList(); listType = 'ul'; items.push(ul[1]); continue; }
      if (ol) { flushPara(); if (listType && listType !== 'ol') flushList(); listType = 'ol'; items.push(ol[1]); continue; }

      // Continuation line: append to the current list item, else to the paragraph.
      if (listType) { items[items.length - 1] += ' ' + t; }
      else { para.push(t); }
    }
    flushPara(); flushList();
    return html.join('\n');
  }

  Stair.markdown = { render: render };
})();
