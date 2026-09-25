// XIOM Package Registry -- dependency-free markdown renderer for readmes.
// Copyright (c) 2026 Eleftherios Notas and The XIOM Authors
// SPDX-License-Identifier: Apache-2.0
//
// SESSION.md section 13 phase 3. README content is publisher-controlled and
// untrusted, so the pipeline is escape-first: the source is HTML-escaped
// before any markdown rule runs, and the renderer only ever emits tags from
// its own allowlist (headings, paragraphs, lists, code, quotes, tables, hr,
// links, images, emphasis). Link URLs must be http(s)/mailto; images must be
// https. Attribute values are interpolated after escaping, so quotes and
// ampersands cannot break out of the attribute.

'use strict';

const { escapeHtml } = require('./layout');

const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const PLACEHOLDER = /\u0002(\d+)\u0002/g;
const SAFE_LINK = /^(https?:\/\/|mailto:)/i;
const SAFE_IMAGE = /^https:\/\//i;

const FENCE = /^\s*(`{3,}|~{3,})\s*([A-Za-z0-9_+.-]*)\s*$/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const HR = /^\s*([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^\s*>\s?/;
const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const TABLE_SEPARATOR = /^\s*\|?(\s*:?-+:?\s*\|)+\s*:?-*:?\s*\|?\s*$/;

function stripControl(text) {
  return String(text ?? '').replace(CONTROL_CHARS, '');
}

/** Emphasis and strikethrough for one line of already-escaped text. */
function renderEmphasis(escaped) {
  return escaped
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_\n]+)__/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
    .replace(/(^|[^_\w])_([^_\n]+)_/g, '$1<em>$2</em>')
    .replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
}

/**
 * Inline markdown for one text chunk. Everything is escaped first; generated
 * HTML is stashed behind placeholders so later rules cannot rewrite it.
 */
function renderInline(text) {
  const stash = [];
  const keep = (html) => `\u0002${stash.push(html) - 1}\u0002`;
  let out = escapeHtml(stripControl(text));

  // Inline code first: its contents must not run through other rules.
  out = out.replace(/`([^`\n]+)`/g, (match, code) => keep(`<code>${code}</code>`));

  // Images before links (a link is an image expression without `!`).
  out = out.replace(/!\[([^\]]*)\]\(([^()\s]+)\)/g, (match, alt, url) => (
    SAFE_IMAGE.test(url)
      ? keep(`<img src="${url}" alt="${alt}" loading="lazy" referrerpolicy="no-referrer">`)
      : keep(`<span class="md-invalid">${alt}</span>`)
  ));
  out = out.replace(/\[([^\]]+)\]\(([^()\s]+)\)/g, (match, label, url) => (
    SAFE_LINK.test(url)
      ? keep(`<a href="${url}" rel="noopener nofollow" target="_blank">${renderEmphasis(label)}</a>`)
      : keep(`<span class="md-invalid">${label}</span>`)
  ));

  out = renderEmphasis(out);
  return out.replace(PLACEHOLDER, (match, index) => stash[Number(index)]);
}

function renderCodeFence(lines, start) {
  const open = FENCE.exec(lines[start]);
  const marker = open[1][0];
  const language = open[2];
  const close = new RegExp(`^\\s*\\${marker}{3,}\\s*$`);
  const code = [];
  let i = start + 1;
  while (i < lines.length && !close.test(lines[i])) {
    code.push(lines[i]);
    i++;
  }
  const cls = language ? ` class="language-${escapeHtml(language)}"` : '';
  return {
    html: `<pre><code${cls}>${escapeHtml(code.join('\n'))}</code></pre>`,
    next: i + 1,
  };
}

function renderList(lines, start) {
  const first = LIST.exec(lines[start]);
  const baseIndent = first[1].length;
  const ordered = /^\d/.test(first[2]);
  const items = [];
  let i = start;

  while (i < lines.length) {
    const match = LIST.exec(lines[i]);
    if (!match || match[1].length !== baseIndent) break;
    let text = match[3];
    i++;

    // Continuation lines belong to the item until a blank line or a new item.
    while (i < lines.length && lines[i].trim() !== '' && !LIST.test(lines[i])) {
      text += `\n${lines[i].trim()}`;
      i++;
    }
    // One level of nesting: collect the deeper block for a recursive render.
    const nested = [];
    while (i < lines.length) {
      const deeper = LIST.exec(lines[i]);
      if (!deeper || deeper[1].length <= baseIndent) break;
      nested.push(lines[i].slice(baseIndent + 2));
      i++;
    }
    items.push({ text, nested });
  }

  const tag = ordered ? 'ol' : 'ul';
  const body = items.map(({ text, nested }) => {
    const tail = nested.length > 0 ? `\n${renderMarkdown(nested.join('\n'))}` : '';
    const task = /^\[([ xX])\]\s+(.*)$/.exec(text);
    if (task) {
      const checked = task[1].toLowerCase() === 'x' ? ' checked' : '';
      return `<li class="task-list-item"><input type="checkbox" disabled${checked}> ${renderInline(task[2])}${tail}</li>`;
    }
    return `<li>${renderInline(text)}${tail}</li>`;
  });
  return { html: `<${tag}>\n${body.join('\n')}\n</${tag}>`, next: i };
}

function parseTableRow(line) {
  let row = line.trim();
  if (row.startsWith('|')) row = row.slice(1);
  if (row.endsWith('|')) row = row.slice(0, -1);
  return row.split('|').map((cell) => cell.trim());
}

function renderTable(lines, start) {
  const aligns = parseTableRow(lines[start + 1]).map((cell) => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    if (left && right) return 'center';
    if (right) return 'right';
    if (left) return 'left';
    return '';
  });
  const head = parseTableRow(lines[start]);
  const rows = [];
  let i = start + 2;
  while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
    rows.push(parseTableRow(lines[i]));
    i++;
  }
  const renderCell = (content, align, header) => {
    const cellTag = header ? 'th' : 'td';
    const style = align ? ` style="text-align: ${align}"` : '';
    return `<${cellTag}${style}>${renderInline(content)}</${cellTag}>`;
  };
  const headRow = `<tr>${head.map((cell, index) => renderCell(cell, aligns[index], true)).join('')}</tr>`;
  const bodyRows = rows
    .map((row) => `<tr>${row.map((cell, index) => renderCell(cell, aligns[index], false)).join('')}</tr>`)
    .join('\n');
  return {
    html: `<table>\n<thead>${headRow}</thead>\n<tbody>\n${bodyRows}\n</tbody>\n</table>`,
    next: i,
  };
}

function isBlockStart(line) {
  return FENCE.test(line) || HEADING.test(line) || HR.test(line)
    || QUOTE.test(line) || LIST.test(line);
}

/**
 * Render a markdown document to safe HTML.
 *
 * @param {string} source untrusted markdown
 * @returns {string} HTML built only from the renderer's own allowlist
 */
function renderMarkdown(source) {
  const lines = String(source ?? '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') {
      i++;
      continue;
    }
    if (FENCE.test(line)) {
      const { html, next } = renderCodeFence(lines, i);
      blocks.push(html);
      i = next;
      continue;
    }
    if (HEADING.test(line)) {
      const match = HEADING.exec(line);
      const level = match[1].length;
      blocks.push(`<h${level}>${renderInline(match[2])}</h${level}>`);
      i++;
      continue;
    }
    if (HR.test(line)) {
      blocks.push('<hr>');
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const quote = [];
      while (i < lines.length && QUOTE.test(lines[i])) {
        quote.push(lines[i].replace(QUOTE, ''));
        i++;
      }
      blocks.push(`<blockquote>\n${renderMarkdown(quote.join('\n'))}\n</blockquote>`);
      continue;
    }
    if (LIST.test(line)) {
      const { html, next } = renderList(lines, i);
      blocks.push(html);
      i = next;
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEPARATOR.test(lines[i + 1])) {
      const { html, next } = renderTable(lines, i);
      blocks.push(html);
      i = next;
      continue;
    }
    const paragraph = [];
    while (i < lines.length && lines[i].trim() !== '' && !isBlockStart(lines[i])
      && !(lines[i].includes('|') && i + 1 < lines.length && TABLE_SEPARATOR.test(lines[i + 1]))) {
      paragraph.push(lines[i]);
      i++;
    }
    blocks.push(`<p>${renderInline(paragraph.join('\n'))}</p>`);
  }

  return blocks.join('\n');
}

module.exports = { renderMarkdown, renderInline, renderEmphasis };
