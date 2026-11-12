// Turns one page of the original site into a clean, presentation-free model.
//
// The source is twenty years of FrontPage output: framesets, nested iframes,
// <font> soup, layout tables, navigation hidden in <select> boxes and onclick
// handlers. Nothing from it is inserted into the app as-is. Every page is
// parsed into an inert document, walked, and rebuilt from an allowlist of
// elements, so no script, style or attribute of the original survives.

const FAKE_ORIGIN = 'http://mdc.invalid';
const SITE_HOSTS = new Set(['www.mdc.idv.tw', 'mdc.idv.tw']);
const HOME_PATHS = new Set([
  '/', '/index.htm', '/index.html',
  '/mdc/', '/mdc/index.htm', '/mdc/index.html', '/mdc/index-top.htm', '/mdc/index-top-big.htm',
]);
const MAX_DEPTH = 4;

const GENERIC_TITLE = /^(?:新增網頁\s*\d*|MDC軍武狂人夢|untitled.*|new page.*|.*\b(?:frames?|nav|navigation)\b.*)?$/i;
const IMAGE_EXT = /\.(?:jpe?g|gif|png|bmp|webp|svg)$/i;
const PAGE_EXT = /\.(?:html?|php|asp|shtml)$/i;
const CJK = '\\u2e80-\\u9fff\\uf900-\\ufaff\\uff00-\\uffef';
const CJK_GAP = new RegExp(`([${CJK}])[ \\t]+(?=[${CJK}])`, 'g');
const CJK_END = new RegExp(`[${CJK}]$`);
const CJK_START = new RegExp(`^[${CJK}]`);

const BREAK = { t: 'break' };

/* ───────────────────────── fetching ───────────────────────── */

const rawCache = new Map();
let freshUntil = 0;

/** Make the next page load bypass both the in-memory and the edge cache. */
export function refreshNext() {
  rawCache.clear();
  freshUntil = Date.now() + 15000;
}

export function fetchRaw(path, fresh = Date.now() < freshUntil) {
  if (!fresh && rawCache.has(path)) return rawCache.get(path);
  const promise = (async () => {
    const res = await fetch(`/api/page?u=${encodeURIComponent(path)}${fresh ? '&fresh=1' : ''}`);
    if (!res.ok) {
      const err = new Error((await res.text()) || `HTTP ${res.status}`);
      err.status = res.status;
      err.asset = res.headers.get('x-asset');
      throw err;
    }
    return {
      html: await res.text(),
      sourcePath: res.headers.get('x-source-path') || path,
      lastModified: res.headers.get('x-source-last-modified'),
    };
  })();
  rawCache.set(path, promise);
  promise.catch(() => rawCache.delete(path));
  return promise;
}

/* ───────────────────────── links ───────────────────────── */

/**
 * Classify a raw href/src found on a page.
 * kind: 'page' (open in the reader), 'image', 'asset' (other file),
 *       'external', 'anchor' (same-page #id) or 'home'.
 */
export function resolveLink(raw, base) {
  if (raw == null) return null;
  raw = String(raw).trim();
  if (!raw || /^javascript:/i.test(raw)) return null;
  if (raw.startsWith('#')) return raw.length > 1 ? { kind: 'anchor', href: raw, id: safeDecode(raw.slice(1)) } : null;
  let url;
  try {
    url = new URL(raw, base);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol)) return { kind: 'external', href: url.href };
  const onSite = url.origin === FAKE_ORIGIN || SITE_HOSTS.has(url.hostname);
  if (!onSite) return { kind: 'external', href: url.href };

  const path = url.pathname;
  if (HOME_PATHS.has(path) && !url.search) return { kind: 'home', href: '/', path: '/' };
  const last = path.slice(path.lastIndexOf('/') + 1);
  if (!last || PAGE_EXT.test(last) || !last.includes('.')) {
    return { kind: 'page', href: path + url.search + url.hash, path: path + url.search };
  }
  return { kind: IMAGE_EXT.test(last) ? 'image' : 'asset', href: '/img' + path + url.search, path };
}

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/* ───────────────────────── small helpers ───────────────────────── */

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else el.setAttribute(k, v);
    }
  }
  for (const c of children.flat()) {
    if (c == null) continue;
    el.append(c);
  }
  return el;
}

const textOf = (node) => (node.textContent || '').replace(/[\s 　]+/g, ' ').trim();

export function cleanLabel(s) {
  return String(s || '')
    .replace(/[▶►▼▸▾▲]/g, '')
    .replace(/[\s 　]+/g, ' ')
    .trim();
}

/** "=====  現 役 艦 艇 =====" → "現役艦艇" */
function cleanHeading(s) {
  let t = cleanLabel(s).replace(/^[\s=\-—–_*~.·]+|[\s=\-—–_*~.·]+$/g, '');
  if (new RegExp(`^(?:[${CJK}] )+[${CJK}]$`).test(t)) t = t.replace(/ /g, '');
  return t;
}

function cleanTitle(s) {
  return cleanLabel(s).replace(/[-－—–]\s*選單$/, '');
}

/* ───────────────────────── per-document style hints ───────────────────────── */

// FrontPage 12 moves alignment and weight into generated classes
// (.auto-style7 { text-align: center }), so read those out of <style>.
function readClassHints(doc) {
  const hints = {};
  for (const style of doc.querySelectorAll('style')) {
    for (const m of style.textContent.matchAll(/\.([\w-]+)\s*\{([^}]*)\}/g)) {
      hints[m[1]] = styleHints(m[2]);
    }
  }
  return hints;
}

function styleHints(css) {
  const out = {};
  const align = /text-align\s*:\s*(\w+)/i.exec(css);
  if (align) out.center = /center/i.test(align[1]);
  if (/font-weight\s*:\s*(?:bold|[6-9]00)/i.test(css)) out.bold = true;
  return out;
}

const ALIGNABLE = new Set(['P', 'DIV', 'TD', 'TH', 'TR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'LI', 'CENTER', 'BLOCKQUOTE']);

function hintsFor(el, classHints) {
  const out = {};
  for (const cls of el.classList) Object.assign(out, classHints[cls]);
  const style = el.getAttribute('style');
  if (style) Object.assign(out, styleHints(style));
  if (ALIGNABLE.has(el.tagName)) {
    const align = el.getAttribute('align');
    if (align) out.center = /^(?:center|middle)$/i.test(align);
    if (el.tagName === 'CENTER') out.center = true;
  } else {
    delete out.center;
  }
  return out;
}

/* ───────────────────────── navigation extraction ───────────────────────── */

const SCRIPT_URL = /['"]([^'"\s]+\.html?(?:[?#][^'"]*)?)['"]/i;

/** <select> boxes used as jump menus become menu groups. */
function extractSelectMenus(doc, base) {
  const menus = [];
  for (const select of [...doc.querySelectorAll('select')]) {
    const items = [];
    let title = '';
    for (const opt of select.options) {
      const label = cleanLabel(opt.textContent);
      // FrontPage's jump() menus append "&_self" / "&frameName" to the URL.
      let value = (opt.getAttribute('value') || '').trim();
      if (!value.includes('?')) value = value.replace(/&[\w-]+$/, '');
      const link = value && value !== '#' ? resolveLink(value, base) : null;
      if (link && link.kind !== 'anchor') {
        if (label) items.push({ label, href: link.href, kind: link.kind });
      } else {
        const heading = cleanHeading(label);
        if (!heading || /^選\s*擇$/.test(heading) || /選\s*項$/.test(heading) && !title) {
          if (!title && heading && !/^選\s*擇$/.test(heading)) title = heading.replace(/選\s*項$/, '').trim();
          continue;
        }
        if (!title && !items.length) title = heading;
        else items.push({ heading });
      }
    }
    const context = labelBefore(select);
    select.remove();
    if (items.some((i) => i.href)) menus.push({ title, items: trimHeadings(items), context });
  }
  // Older pages put the real label in the paragraph above the box and give
  // every box the same placeholder ("---機 種 選 項---").
  const seen = {};
  for (const m of menus) seen[m.title] = (seen[m.title] || 0) + 1;
  for (const m of menus) {
    const context = m.context;
    delete m.context;
    if (context && (!m.title || seen[m.title] > 1)) {
      m.title = context.label;
      if (context.el.isConnected && cleanLabel(context.el.textContent).replace(/[：:]$/, '') === context.label) context.el.remove();
    }
  }
  return menus;
}

/** The short piece of text that sits right before an element, if any. */
function labelBefore(el) {
  for (let node = el, level = 0; node && level < 5; node = node.parentElement, level++) {
    if (/^(?:TD|TH)$/.test(node.tagName)) {
      // label in the cell to the left
      const cell = node.previousElementSibling;
      const label = cell && !cell.querySelector('select') ? cleanLabel(cell.textContent).replace(/[：:]$/, '') : '';
      return label && label.length <= 40 ? { label, el: cell } : null;
    }
    if (/^(?:TR|TABLE|BODY|HTML)$/.test(node.tagName)) break;
    for (let prev = node.previousSibling; prev; prev = prev.previousSibling) {
      if (prev.nodeType !== Node.ELEMENT_NODE && prev.nodeType !== Node.TEXT_NODE) continue;
      if (prev.nodeType === Node.ELEMENT_NODE && (prev.matches('select') || prev.querySelector('select'))) return null;
      const label = cleanLabel(prev.textContent).replace(/[：:]$/, '');
      if (!label) continue;
      if (label.length > 40) return null;
      return { label, el: prev.nodeType === Node.ELEMENT_NODE ? prev : prev.parentElement };
    }
  }
  return null;
}

function trimHeadings(items) {
  // drop headings that have no links under them
  return items.filter((it, i) => !it.heading || (items[i + 1] && items[i + 1].href));
}

/** Tab bars built from <button data-page="x.htm"> wrap multi-part articles. */
function extractTabs(doc, base, pageUrl) {
  const buttons = [...doc.querySelectorAll('[data-page]')];
  if (buttons.length < 2) return null;
  const items = [];
  for (const b of buttons) {
    const link = resolveLink(b.getAttribute('data-page'), base);
    if (!link || link.kind !== 'page') continue;
    const wrapper = new URL(pageUrl.pathname, FAKE_ORIGIN);
    wrapper.searchParams.set('page', b.getAttribute('data-page'));
    items.push({
      label: cleanLabel(b.textContent).replace(/^\d+\s*[.．、]\s*/, ''),
      page: link.path,
      href: wrapper.pathname + wrapper.search,
    });
  }
  if (items.length < 2) return null;
  const wanted = pageUrl.searchParams.get('page');
  const wantedLink = wanted ? resolveLink(wanted, base) : null;
  let active = wantedLink ? items.findIndex((i) => i.page === wantedLink.path) : 0;
  if (active < 0) active = 0;
  // remove the tab bar itself and any <select> that duplicates it
  for (const b of buttons) b.remove();
  const pages = new Set(buttons.map((b) => b.getAttribute('data-page')));
  for (const s of [...doc.querySelectorAll('select')]) {
    const values = [...s.options].map((o) => o.getAttribute('value')).filter(Boolean);
    if (values.length && values.every((v) => pages.has(v))) s.remove();
  }
  return { items, active };
}

/** "MDC軍武狂人夢->空軍專區->俄羅斯" trails become real breadcrumbs. */
function extractCrumbs(doc, base) {
  const walker = doc.createTreeWalker(doc.body || doc.documentElement, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    if (!/-\s*>|→|＞/.test(node.nodeValue)) continue;
    let best = null;
    for (let el = node.parentElement, i = 0; el && i < 6; i++, el = el.parentElement) {
      if (/^(?:TD|TH|TR|TABLE|BODY|DIV|HTML)$/.test(el.tagName) || textOf(el).length >= 90) break;
      if (el.querySelectorAll('a[href]').length >= 2) best = el;
    }
    if (!best) continue;
    const crumbs = [];
    for (const a of best.querySelectorAll('a[href]')) {
      const link = resolveLink(a.getAttribute('href'), base);
      const label = cleanLabel(a.textContent);
      if (link && label && (link.kind === 'page' || link.kind === 'home')) crumbs.push({ label, href: link.href });
    }
    const hr = best.nextElementSibling;
    if (hr && hr.tagName === 'HR') hr.remove();
    best.remove();
    return crumbs;
  }
  return null;
}

/** Pages that are nothing but `location.href = "..."`. */
function findRedirect(doc, base) {
  const body = doc.body;
  if (body && (textOf(body).length > 40 || body.querySelector('img, iframe, frame, a, select'))) return null;
  if (doc.querySelector('frame, iframe')) return null;
  const meta = doc.querySelector('meta[http-equiv="refresh" i]');
  const metaUrl = meta && /url\s*=\s*['"]?([^'";]+)/i.exec(meta.getAttribute('content') || '');
  if (metaUrl) return resolveLink(metaUrl[1], base);
  for (const s of doc.querySelectorAll('script')) {
    const m = /location(?:\.href)?\s*=\s*['"]([^'"]+)['"]|location\.(?:replace|assign)\(\s*['"]([^'"]+)['"]/.exec(s.textContent);
    if (m) return resolveLink(m[1] || m[2], base);
  }
  return null;
}

/* ───────────────────────── the walker ───────────────────────── */

const DROP = new Set([
  'SCRIPT', 'STYLE', 'LINK', 'META', 'HEAD', 'TITLE', 'BASE', 'BGSOUND', 'EMBED', 'OBJECT', 'APPLET',
  'NOSCRIPT', 'NOFRAMES', 'INPUT', 'BUTTON', 'TEXTAREA', 'SELECT', 'OPTION', 'MAP', 'AREA',
  'AUDIO', 'VIDEO', 'CANVAS', 'SVG', 'TEMPLATE',
]);
const BLOCK_CONTAINERS = new Set([
  'P', 'DIV', 'CENTER', 'BODY', 'HTML', 'FORM', 'BLOCKQUOTE', 'SECTION', 'ARTICLE', 'MAIN', 'HEADER', 'FOOTER',
  'ADDRESS', 'FIELDSET', 'DL', 'DT', 'DD', 'LI', 'TBODY', 'THEAD', 'TFOOT', 'TR', 'TD', 'TH', 'FRAMESET',
  'CAPTION', 'NAV', 'ASIDE', 'FIGURE', 'FIGCAPTION', 'DETAILS', 'SUMMARY',
]);
const INLINE_FMT = { B: 'bold', STRONG: 'bold', I: 'italic', EM: 'italic', U: 'underline', SUB: 'sub', SUP: 'sup', S: 'strike', STRIKE: 'strike', DEL: 'strike' };

function isLayoutTable(table) {
  const rows = [...table.rows];
  if (!rows.length) return true;
  let maxCols = 0;
  let longest = 0;
  let cells = 0;
  for (const row of rows) {
    let cols = 0;
    for (const cell of row.cells) {
      cols += Math.max(1, cell.colSpan || 1);
      cells++;
      longest = Math.max(longest, textOf(cell).length);
    }
    maxCols = Math.max(maxCols, cols);
  }
  if (maxCols <= 1 || cells <= 2) return true;
  if (table.querySelector('table, iframe, frame')) return true;
  if (longest > 700) return true;
  // a row or two of pictures is a photo layout, not data
  if (rows.length <= 2 && table.querySelector('img') && textOf(table).length < 200) return true;
  return false;
}

function createWalker(doc, base, pageUrl, tabs) {
  const classHints = readClassHints(doc);
  const slots = [];

  function frameSrc(el) {
    // Shell pages fill their iframes from the query string
    // (nav_frame.htm?top=a.htm&bottom=b.htm → #topFrame / #bottomFrame).
    const id = el.id || el.getAttribute('name') || '';
    const key = id.replace(/Frame$/i, '');
    const fromQuery = key && key !== id ? pageUrl.searchParams.get(key) : null;
    let src = fromQuery || el.getAttribute('src');
    if (!src && tabs) return tabs.items[tabs.active].page;
    if (!src || /^about:/i.test(src)) return null;
    const link = resolveLink(src, base);
    return link && link.kind === 'page' ? link.path : null;
  }

  function walk(node, ctx, out) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (node.nodeValue) out.push({ t: 'text', text: node.nodeValue, fmt: ctx.fmt, center: ctx.center });
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const tag = node.tagName;
    if (DROP.has(tag)) return;

    const hints = hintsFor(node, classHints);
    let fmt = ctx.fmt;
    if (hints.bold && !fmt.bold) fmt = { ...fmt, bold: true };
    const center = hints.center ?? ctx.center;

    // Elements that navigate through an inline handler act as links.
    if (tag !== 'A' && node.hasAttribute('onclick')) {
      const m = SCRIPT_URL.exec(node.getAttribute('onclick'));
      const link = m && resolveLink(m[1], base);
      if (link) fmt = { ...fmt, link };
    }

    switch (tag) {
      case 'BR':
        out.push({ t: 'br' });
        return;
      case 'HR':
        out.push(BREAK, { t: 'block', el: h('hr') }, BREAK);
        return;
      case 'IMG':
        pushImage(node, { ...ctx, fmt, center }, out);
        return;
      case 'IFRAME':
      case 'FRAME': {
        const src = frameSrc(node);
        if (src) {
          const slot = h('div', { class: 'slot' });
          slots.push({ el: slot, path: src });
          out.push(BREAK, { t: 'block', el: slot }, BREAK);
        }
        return;
      }
      case 'A': {
        const name = node.getAttribute('name') || node.id;
        if (name) out.push({ t: 'anchor', id: name });
        const link = resolveLink(node.getAttribute('href'), base);
        if (link) fmt = { ...fmt, link };
        walkChildren(node, { ...ctx, fmt, center }, out);
        return;
      }
      case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6': {
        const inner = [];
        walkChildren(node, { ...ctx, fmt: { ...fmt, bold: false }, center }, inner);
        const nodes = inlineNodes(inner.filter((i) => i !== BREAK && i.t !== 'block'));
        if (nodes.length) {
          out.push(BREAK, { t: 'block', el: h(tag <= 'H2' ? 'h2' : 'h3', center ? { class: 'c' } : null, nodes) }, BREAK);
        }
        return;
      }
      case 'UL':
      case 'OL': {
        const list = h(tag.toLowerCase());
        for (const li of node.children) {
          const inner = [];
          walk(li, { ...ctx, fmt, center: false }, inner);
          const blocks = assemble(inner);
          if (!blocks.length) continue;
          list.append(h('li', null, blocks.length === 1 && blocks[0].tagName === 'P' ? [...blocks[0].childNodes] : blocks));
        }
        if (list.children.length) out.push(BREAK, { t: 'block', el: list }, BREAK);
        return;
      }
      case 'PRE':
        if (node.textContent.trim()) out.push(BREAK, { t: 'block', el: h('pre', null, node.textContent) }, BREAK);
        return;
      case 'TABLE': {
        // tables do not inherit alignment from their surroundings
        const inner = { ...ctx, fmt, center: false };
        if (isLayoutTable(node)) {
          out.push(BREAK);
          for (const row of node.rows) for (const cell of row.cells) walk(cell, inner, out);
          out.push(BREAK);
        } else {
          const table = buildTable(node, inner);
          if (table) out.push(BREAK, { t: 'block', el: table }, BREAK);
        }
        return;
      }
    }

    if (INLINE_FMT[tag]) {
      walkChildren(node, { ...ctx, fmt: { ...fmt, [INLINE_FMT[tag]]: true }, center }, out);
    } else if (BLOCK_CONTAINERS.has(tag)) {
      out.push(BREAK);
      walkChildren(node, { ...ctx, fmt, center }, out);
      out.push(BREAK);
    } else {
      // <font>, <span> and anything unknown: keep the text, lose the tag
      walkChildren(node, { ...ctx, fmt, center }, out);
    }
  }

  function walkChildren(node, ctx, out) {
    for (const child of node.childNodes) walk(child, ctx, out);
  }

  function pushImage(node, ctx, out) {
    const link = resolveLink(node.getAttribute('src'), base);
    if (!link || (link.kind !== 'image' && link.kind !== 'asset')) return;
    const w = parseInt(node.getAttribute('width'), 10) || parseInt(node.style.width, 10) || 0;
    const ht = parseInt(node.getAttribute('height'), 10) || parseInt(node.style.height, 10) || 0;
    // spacer bars and bullets
    if ((ht && ht <= 12) || (w && w <= 12)) return;
    // list bullets drawn as little pictures
    if (w && ht && w <= 40 && ht <= 40) return;
    out.push({ t: 'img', src: link.href, alt: node.getAttribute('alt') || '', w, h: ht, fmt: ctx.fmt, center: ctx.center });
  }

  function buildTable(source, ctx) {
    const table = h('table');
    let first = true;
    for (const row of source.rows) {
      const tr = h('tr');
      let allBold = true;
      let any = false;
      for (const cell of row.cells) {
        const inner = [];
        const hints = hintsFor(cell, classHints);
        walkChildren(cell, { ...ctx, center: hints.center ?? false }, inner);
        const blocks = assemble(inner);
        const td = h('td', {
          colspan: cell.colSpan > 1 ? Math.min(cell.colSpan, 50) : null,
          rowspan: cell.rowSpan > 1 ? Math.min(cell.rowSpan, 200) : null,
        });
        if (blocks.length === 1 && blocks[0].tagName === 'P') {
          if (blocks[0].classList.contains('c')) td.className = 'c';
          td.append(...blocks[0].childNodes);
        } else {
          td.append(...blocks);
        }
        if (td.textContent.trim() || td.querySelector('img')) any = true;
        if (td.textContent.trim() && !isAllBold(td)) allBold = false;
        tr.append(td);
      }
      if (!any) continue;
      if (first && allBold && source.rows.length > 1) {
        for (const td of [...tr.children]) {
          const th = h('th', { colspan: td.getAttribute('colspan'), rowspan: td.getAttribute('rowspan') });
          th.textContent = textOf(td);
          td.replaceWith(th);
        }
      }
      first = false;
      table.append(tr);
    }
    if (!table.rows.length) return null;
    return h('div', { class: 'table-wrap' }, table);
  }

  return { walk, slots };
}

function isAllBold(el) {
  const total = textOf(el).length;
  if (!total) return false;
  let bold = 0;
  for (const s of el.querySelectorAll('strong')) bold += textOf(s).length;
  return bold >= total;
}

/* ───────────────────────── inline assembly ───────────────────────── */

function normText(s) {
  return s.replace(/[\s ]+/g, ' ');
}

/** Turn a flat run of text / image / break items into inline DOM nodes. */
function inlineNodes(items) {
  // 1. merge neighbouring text with identical formatting
  const merged = [];
  for (const it of items) {
    const prev = merged[merged.length - 1];
    if (it.t === 'text' && prev && prev.t === 'text' && sameFmt(prev.fmt, it.fmt)) {
      prev.text += it.text;
    } else {
      merged.push(it.t === 'text' ? { ...it } : it);
    }
  }
  // 2. normalise whitespace; hard-wrapped source lines leave stray spaces
  //    between CJK characters, which must not survive
  let prevText = '';
  for (const it of merged) {
    if (it.t !== 'text') {
      if (it.t !== 'anchor') prevText = '';
      continue;
    }
    let t = normText(it.text).replace(CJK_GAP, '$1');
    if (CJK_END.test(prevText) && /^ /.test(t) && CJK_START.test(t.slice(1))) t = t.slice(1);
    if (/ $/.test(prevText) && /^ /.test(t)) t = t.slice(1);
    it.text = t;
    prevText = t || prevText;
  }
  // 3. trim the ends, including full-width indentation
  const isBlank = (it) => it.t === 'br' || (it.t === 'text' && !it.text.replace(/[\s　]+/g, ''));
  while (merged.length && isBlank(merged[0])) merged.shift();
  while (merged.length && isBlank(merged[merged.length - 1])) merged.pop();
  if (!merged.length) return [];
  const head = merged.find((it) => it.t === 'text');
  if (head && merged.indexOf(head) === merged.findIndex((it) => it.t !== 'anchor')) head.text = head.text.replace(/^[\s　]+/, '');
  const tail = merged[merged.length - 1];
  if (tail.t === 'text') tail.text = tail.text.replace(/[\s　]+$/, '');

  // 4. build nodes, grouping consecutive items that share a link
  const nodes = [];
  let i = 0;
  while (i < merged.length) {
    const link = merged[i].fmt && merged[i].fmt.link;
    let j = i;
    const group = [];
    while (j < merged.length && ((merged[j].fmt && merged[j].fmt.link) || null) === (link || null) && (link || j === i)) {
      group.push(merged[j]);
      j++;
    }
    const inner = group.map(leafNode).filter(Boolean);
    if (link && inner.length) nodes.push(linkNode(link, inner));
    else nodes.push(...inner);
    i = j;
  }
  return nodes;
}

function sameFmt(a, b) {
  return a === b || (a.link === b.link && !!a.bold === !!b.bold && !!a.italic === !!b.italic && !!a.underline === !!b.underline
    && !!a.sub === !!b.sub && !!a.sup === !!b.sup && !!a.strike === !!b.strike);
}

function leafNode(it) {
  if (it.t === 'br') return h('br');
  if (it.t === 'anchor') return h('span', { id: it.id, class: 'anchor' });
  if (it.t === 'img') return imageNode(it);
  if (!it.text) return null;
  let node = document.createTextNode(it.text);
  const f = it.fmt;
  if (f.sub) node = h('sub', null, node);
  if (f.sup) node = h('sup', null, node);
  if (f.strike) node = h('s', null, node);
  if (f.underline && !f.link) node = h('u', null, node);
  if (f.italic) node = h('em', null, node);
  if (f.bold) node = h('strong', null, node);
  return node;
}

function imageNode(it) {
  const link = it.fmt.link;
  return h('img', {
    src: it.src,
    alt: it.alt,
    width: it.w || null,
    height: it.w && it.h ? it.h : null,
    loading: 'lazy',
    decoding: 'async',
    // a thumbnail that links to a bigger picture opens that one instead
    dataset: { ...(link && link.kind === 'image' ? { full: link.href } : {}), ...(it.h ? { h: it.h } : {}) },
  });
}

function linkNode(link, children) {
  // picture links are handled by the lightbox, not by an anchor
  if (link.kind === 'image' && children.every((c) => c.tagName === 'IMG')) return children.length === 1 ? children[0] : h('span', null, children);
  const attrs = { href: link.href };
  if (link.kind === 'external' || link.kind === 'asset') {
    attrs.target = '_blank';
    attrs.rel = 'noopener noreferrer';
    attrs.class = link.kind === 'external' ? 'ext' : 'file';
  } else if (link.kind === 'image') {
    attrs.class = 'zoom';
    attrs.dataset = { full: link.href };
  }
  return h('a', attrs, children);
}

/* ───────────────────────── block assembly ───────────────────────── */

function assemble(items) {
  const blocks = [];
  let run = [];
  const flush = () => {
    if (run.length) blocks.push(...runToBlocks(run));
    run = [];
  };
  for (const it of items) {
    if (it === BREAK) flush();
    else if (it.t === 'block') {
      flush();
      blocks.push(it.el);
    } else run.push(it);
  }
  flush();
  return blocks;
}

function runToBlocks(run) {
  // a blank line made of two <br> separates paragraphs
  const segments = [[]];
  let brs = 0;
  for (const it of run) {
    if (it.t === 'br') {
      brs++;
      if (brs === 2) {
        segments[segments.length - 1].pop();
        segments.push([]);
        continue;
      }
      if (brs > 2) continue;
    } else if (!(it.t === 'text' && !it.text.trim())) {
      brs = 0;
    }
    segments[segments.length - 1].push(it);
  }

  const blocks = [];
  for (const seg of segments) {
    const solid = seg.filter((it) => it.t === 'img' || it.t === 'anchor' || (it.t === 'text' && it.text.replace(/[\s 　]+/g, '')));
    if (!solid.length) continue;
    const center = !!solid[0].center;
    const images = solid.filter((it) => it.t === 'img');
    if (images.length && solid.every((it) => it.t !== 'text')) {
      // picture(s) on their own → a figure
      const nodes = inlineNodes(seg.filter((it) => it.t === 'img' || it.t === 'anchor'));
      blocks.push(h('figure', images.length > 1 ? { class: 'multi' } : null, nodes));
      continue;
    }
    const nodes = inlineNodes(seg);
    if (nodes.length) blocks.push(h('p', center ? { class: 'c' } : null, nodes));
  }
  return blocks;
}

/* ───────────────────────── block refinement ───────────────────────── */

function refine(blocks) {
  const out = [];
  for (const el of blocks) {
    const prev = out[out.length - 1];
    // Captions are centred lines under a picture, usually hard-wrapped into
    // several <p>. Fold them into the figure as one caption.
    if (prev && prev.tagName === 'FIGURE' && el.tagName === 'P' && el.classList.contains('c') && !el.querySelector('img')) {
      const len = textOf(el).length;
      let cap = prev.querySelector('figcaption');
      const lines = cap ? Number(cap.dataset.lines) : 0;
      if (len <= 150 && lines < 8) {
        if (!cap) cap = prev.appendChild(h('figcaption'));
        const last = cap.lastChild;
        const joinText = last && last.nodeType === Node.TEXT_NODE ? last.nodeValue : last ? last.textContent : '';
        if (joinText && !CJK_END.test(joinText) ) cap.append(' ');
        cap.append(...el.childNodes);
        cap.dataset.lines = lines + 1;
        continue;
      }
    }
    // A short paragraph that is bold from end to end is a heading.
    if (el.tagName === 'P' && !el.querySelector('img, a')) {
      const t = textOf(el);
      if (t && t.length <= 42 && isAllBold(el) && !/[。，；,;]$/.test(t)) {
        const heading = h(el.classList.contains('c') ? 'h2' : 'h3', null, t);
        const anchor = el.querySelector('.anchor');
        if (anchor) heading.id = anchor.id;
        out.push(heading);
        continue;
      }
    }
    if (el.tagName === 'HR' && (!prev || prev.tagName === 'HR')) continue;
    out.push(el);
  }
  while (out.length && out[out.length - 1].tagName === 'HR') out.pop();
  for (const cap of out) cap.querySelector?.('figcaption')?.removeAttribute('data-lines');
  return out;
}

/** The first heading near the top of a document is its title. */
function takeTitle(blocks) {
  for (let i = 0; i < Math.min(blocks.length, 3); i++) {
    const el = blocks[i];
    if (el.tagName === 'H2') {
      blocks.splice(i, 1);
      return textOf(el);
    }
    if (el.tagName !== 'P' || textOf(el).length > 60) break;
  }
  return '';
}

/** A document that is essentially a list of links is navigation, not content. */
function asMenu(blocks, title) {
  let total = 0;
  let linked = 0;
  const items = [];
  for (const el of blocks) {
    if (el.matches('.slot, .table-wrap') || el.querySelector('.slot, .table-wrap')) return null;
    const text = textOf(el);
    total += text.length;
    const links = el.matches('a[href]') ? [el] : [...el.querySelectorAll('a[href]')];
    for (const a of links) {
      const label = cleanLabel(a.textContent);
      linked += label.length;
      if (label && !a.classList.contains('ext')) items.push({ label, href: a.getAttribute('href') });
    }
    if (!links.length && text && text.length <= 24) items.push({ heading: cleanHeading(text) });
  }
  const links = items.filter((i) => i.href);
  if (links.length < 3) return null;
  const loose = total - linked;
  if (loose > Math.max(60, total * 0.3)) return null;
  return { title: GENERIC_TITLE.test(title) ? '' : title, items: trimHeadings(items) };
}

/**
 * Inside an otherwise ordinary page, a run of paragraphs that are each just
 * one link is a menu written out by hand. Lift it out of the text.
 */
function liftLinkRuns(blocks, menus) {
  const linkOnly = (el) => {
    if (el.tagName !== 'P' || el.querySelector('img')) return null;
    const links = [...el.querySelectorAll('a[href]')].filter((a) => !a.classList.contains('ext') && !a.getAttribute('href').startsWith('#'));
    const text = textOf(el);
    if (!links.length || text.length > 40) return null;
    const linked = links.reduce((n, a) => n + textOf(a).length, 0);
    if (text.length - linked > 2 || new Set(links.map((a) => a.getAttribute('href'))).size !== 1) return null;
    return { label: cleanLabel(text), href: links[0].getAttribute('href') };
  };
  for (let i = 0; i < blocks.length; i++) {
    const items = [];
    let j = i;
    for (; j < blocks.length; j++) {
      const item = linkOnly(blocks[j]);
      if (!item) break;
      const prev = items[items.length - 1];
      if (prev && prev.href === item.href) prev.label += item.label;
      else items.push(item);
    }
    if (items.length >= 3) {
      menus.push({ title: '', items });
      blocks.splice(i, j - i);
      i--;
    }
  }
}

/* ───────────────────────── loading ───────────────────────── */

async function loadDoc(path, depth, chain) {
  const raw = await fetchRaw(path);
  const doc = new DOMParser().parseFromString(raw.html, 'text/html');
  const pageUrl = new URL(path, FAKE_ORIGIN);
  // Query strings select frames inside shell pages; the file itself is the base.
  const sourceUrl = new URL(raw.sourcePath, FAKE_ORIGIN);
  let base = new URL(sourceUrl.pathname, FAKE_ORIGIN).href;
  const baseHref = doc.querySelector('base[href]');
  if (baseHref) {
    const b = resolveLink(baseHref.getAttribute('href'), base);
    if (b && b.path) base = new URL(b.path, FAKE_ORIGIN).href;
  }

  const redirect = findRedirect(doc, base);
  if (redirect) return { redirect };

  const docTitle = cleanTitle(doc.title);
  const tabs = extractTabs(doc, base, pageUrl);
  const menus = extractSelectMenus(doc, base);
  const crumbs = extractCrumbs(doc, base);

  const walker = createWalker(doc, base, pageUrl, tabs);
  const items = [];
  const root = doc.querySelector('frameset') || doc.body || doc.documentElement;
  walker.walk(root, { fmt: {}, center: false }, items);
  let blocks = refine(assemble(items));
  const headTitle = takeTitle(blocks);

  const model = {
    path,
    docTitle: GENERIC_TITLE.test(docTitle) ? '' : docTitle,
    headTitle,
    blocks,
    menus,
    tabs,
    crumbs,
    lastModified: raw.lastModified,
  };
  // The title and date shown for an address come from whichever document
  // in the frame tree carries the most text.
  const ownLength = blocks.reduce((n, el) => n + textOf(el).length, 0);
  model.best = { title: model.docTitle, length: ownLength, lastModified: raw.lastModified };

  // Fill frame slots with the pages they point to.
  const nextChain = [...chain, pageUrl.pathname + pageUrl.search];
  await Promise.all(
    walker.slots.map(async (slot) => {
      if (depth >= MAX_DEPTH || nextChain.includes(slot.path)) {
        slot.el.remove();
        return;
      }
      try {
        let sub = await loadDoc(slot.path, depth + 1, nextChain);
        if (sub.redirect && sub.redirect.kind === 'page') sub = await loadDoc(sub.redirect.path, depth + 1, nextChain);
        slot.sub = sub;
      } catch (err) {
        slot.error = err;
      }
    }),
  );
  for (const slot of walker.slots) {
    const at = blocks.indexOf(slot.el);
    if (at < 0) continue;
    const sub = slot.sub;
    if (!sub || sub.redirect) {
      const note = slot.error
        ? [h('p', { class: 'note' }, '這一部分內容載入失敗：', h('a', { href: slot.path }, slot.path))]
        : [];
      blocks.splice(at, 1, ...note);
      continue;
    }
    blocks.splice(at, 1, ...sub.blocks);
    model.menus.push(...sub.menus);
    model.tabs = model.tabs || sub.tabs;
    model.crumbs = model.crumbs || sub.crumbs;
    model.headTitle = model.headTitle || sub.headTitle;
    if (sub.best.title && (sub.best.length > model.best.length || !model.best.title)) model.best = sub.best;
  }
  blocks = model.blocks = refine(blocks);

  // Link lists turn into a menu; pictures with no words around them inside a
  // frame are decoration (emblem strips, banners).
  const menu = asMenu(blocks, model.headTitle || model.docTitle);
  if (menu) {
    model.menus.unshift(menu);
    model.blocks = [];
    model.best.length = Math.min(model.best.length, 1);
  } else {
    liftLinkRuns(blocks, model.menus);
  }
  if (menu) {
    // nothing left to show
  } else if (depth > 0 && blocks.length && blocks.every((el) => el.tagName === 'FIGURE' && !el.querySelector('figcaption')
    && [...el.querySelectorAll('img')].every((img) => Number(img.dataset.h) > 0 && Number(img.dataset.h) <= 120))) {
    model.blocks = [];
  }
  return model;
}

/**
 * Load everything needed to show one address of the original site.
 * Returns { path, title, blocks, menus, tabs, crumbs, lastModified }.
 */
export async function loadPage(path, hintLabel = '') {
  let model;
  let current = path;
  for (let hop = 0; hop < 4; hop++) {
    model = await loadDoc(current, 0, []);
    if (!model.redirect) break;
    if (model.redirect.kind === 'home') return { home: true };
    if (model.redirect.kind !== 'page') throw new Error('這個頁面只是一個轉址：' + model.redirect.href);
    current = model.redirect.path;
  }
  if (model.redirect) throw new Error('轉址次數過多');

  const file = safeDecode(current.split('?')[0].split('/').filter(Boolean).pop() || '');
  // Many pages are titled "新增網頁1". Fall back to what the site's own
  // breadcrumb calls this page, then to the link that led here.
  const self = (model.crumbs || []).find((c) => c.href.split('#')[0] === current);
  const title = model.headTitle || model.best.title || model.docTitle || (self && self.label) || cleanLabel(hintLabel) || '';
  return {
    path: current,
    title,
    file,
    blocks: model.blocks,
    menus: model.menus.filter((m) => m.items.length),
    tabs: model.tabs,
    crumbs: model.crumbs,
    lastModified: model.best.lastModified || model.lastModified,
  };
}
