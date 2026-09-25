// XIOM Package Registry -- markdown renderer tests (SESSION.md section 13).
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: MIT OR Apache-2.0

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { renderMarkdown, renderInline } = require('../src/ui/markdown');

test('renders headings, paragraphs, emphasis, and inline code', () => {
  const html = renderMarkdown([
    '# Title',
    '',
    'Some **bold** and *em* and `code` text.',
    '',
    '## Sub',
  ].join('\n'));
  assert.match(html, /<h1>Title<\/h1>/);
  assert.match(html, /<p>Some <strong>bold<\/strong> and <em>em<\/em> and <code>code<\/code> text\.<\/p>/);
  assert.match(html, /<h2>Sub<\/h2>/);
});

test('renders fenced code with an escaped body and language class', () => {
  const html = renderMarkdown('```js\nconst a = 1 < 2 && "x";\n```');
  assert.match(html, /<pre><code class="language-js">const a = 1 &lt; 2 &amp;&amp; &quot;x&quot;;<\/code><\/pre>/);
  const hostileLang = renderMarkdown('```"><script>\nx\n```');
  assert.doesNotMatch(hostileLang, /<script/);
  assert.doesNotMatch(hostileLang, /language-"/);
});

test('renders nested lists, ordered lists, and task lists', () => {
  const html = renderMarkdown([
    '- one',
    '  - nested',
    '- two',
    '',
    '1. first',
    '2. second',
    '',
    '- [x] done',
    '- [ ] todo',
  ].join('\n'));
  assert.match(html, /<ul>\n<li>one\n<ul>\n<li>nested<\/li>\n<\/ul><\/li>/);
  assert.match(html, /<ol>\n<li>first<\/li>\n<li>second<\/li>\n<\/ol>/);
  assert.match(html, /class="task-list-item"><input type="checkbox" disabled checked>/);
  assert.match(html, /class="task-list-item"><input type="checkbox" disabled>/);
});

test('renders blockquotes, rules, and GFM tables with alignment', () => {
  const html = renderMarkdown([
    '> quoted',
    '> lines',
    '',
    '---',
    '',
    '| left | center | right |',
    '| :--- | :----: | ----: |',
    '| a | b | c |',
  ].join('\n'));
  assert.match(html, /<blockquote>\n<p>quoted\nlines<\/p>\n<\/blockquote>/);
  assert.match(html, /<hr>/);
  assert.match(html, /<th style="text-align: left">left<\/th>/);
  assert.match(html, /<th style="text-align: center">center<\/th>/);
  assert.match(html, /<th style="text-align: right">right<\/th>/);
  assert.match(html, /<td style="text-align: left">a<\/td><td style="text-align: center">b<\/td><td style="text-align: right">c<\/td>/);
});

test('renders safe links and images and rejects unsafe schemes', () => {
  const html = renderMarkdown([
    '[docs](https://xiom-lang.org/docs)',
    '',
    '![logo](https://xiom-lang.org/logo.png)',
  ].join('\n'));
  assert.match(html, /<a href="https:\/\/xiom-lang\.org\/docs" rel="noopener nofollow" target="_blank">docs<\/a>/);
  assert.match(html, /<img src="https:\/\/xiom-lang\.org\/logo\.png" alt="logo" loading="lazy" referrerpolicy="no-referrer">/);

  for (const hostile of [
    '[click](javascript:alert)',
    '[click](JaVaScRiPt:alert)',
    '[click](data:text/html,hi)',
    '![x](http://insecure.example/x.png)',
    '[rel](./relative/path)',
  ]) {
    const rendered = renderMarkdown(hostile);
    assert.doesNotMatch(rendered, /<a /, hostile);
    assert.doesNotMatch(rendered, /<img /, hostile);
    assert.match(rendered, /class="md-invalid"/, hostile);
  }
  // Parentheses inside a URL are not parsed as a link; the expression stays
  // inert escaped text rather than becoming a controlled link.
  const parens = renderMarkdown('[click](javascript:alert(1))');
  assert.doesNotMatch(parens, /<a /);
});

test('escape-first: raw HTML and attribute injection stay inert', () => {
  const scripts = renderMarkdown('<script>alert(1)</script>');
  assert.doesNotMatch(scripts, /<script/);
  assert.match(scripts, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);

  const img = renderMarkdown('<img src=x onerror=alert(1)>');
  assert.doesNotMatch(img, /<img/);
  assert.match(img, /&lt;img src=x onerror=alert\(1\)&gt;/, 'raw HTML is shown as text');

  // A quote in the URL cannot terminate the href attribute.
  const quoted = renderMarkdown('[x](https://a.example/"onmouseover=alert)');
  assert.doesNotMatch(quoted, /onmouseover="/);
  assert.match(quoted, /href="https:\/\/a\.example\/&quot;onmouseover=alert"/);

  const svg = renderMarkdown('<svg/onload=alert(1)>');
  assert.doesNotMatch(svg, /<svg/);
  assert.match(svg, /&lt;svg\/onload=alert\(1\)&gt;/);
});

test('inline code protects markdown syntax from later rules', () => {
  const html = renderInline('`**not bold** and [not a link](https://x)`');
  assert.match(html, /<code>\*\*not bold\*\* and \[not a link\]\(https:\/\/x\)<\/code>/);
  assert.doesNotMatch(html, /<strong>/);
  assert.doesNotMatch(html, /<a /);
});

test('control characters are stripped and CRLF normalized', () => {
  const html = renderMarkdown('a\u0000b\u0007c\r\nnext');
  assert.match(html, /<p>abc\nnext<\/p>/);
  assert.doesNotMatch(html, /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/);
});

test('the output only contains allowlisted tags', () => {
  const html = renderMarkdown([
    '# h', 'text', '> quote', '- item', '| a | b |', '| - | - |', '| 1 | 2 |',
    '```', 'code', '```', '<iframe src="x">', '[l](https://e.example)',
  ].join('\n'));
  const tags = [...html.matchAll(/<\/?([a-z0-9]+)/gi)].map((match) => match[1].toLowerCase());
  const allowed = new Set([
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'ul', 'ol', 'li',
    'code', 'pre', 'blockquote', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'a', 'img', 'strong', 'em', 'del', 'span', 'input', 'br',
  ]);
  for (const tag of tags) assert.ok(allowed.has(tag), `unexpected tag <${tag}>`);
  assert.doesNotMatch(html, /<iframe/);
});
