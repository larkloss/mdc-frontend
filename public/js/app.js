import { loadPage, refreshNext, cleanLabel } from './extract.js';

const SOURCE = 'http://www.mdc.idv.tw';

const SECTIONS = [
  { label: '海軍', href: '/mdc/navy/index.html', note: '各國艦艇、艦載武器與海軍發展' },
  { label: '陸軍', href: '/mdc/army/index.html', note: '戰車、裝甲車輛與火砲' },
  { label: '空軍', href: '/mdc/air/air-table.htm', note: '軍用航空器與空中武力' },
  { label: '資料庫', href: '/mdc/information/inf-table.htm', note: '軍事科技、戰略戰史、二戰專區' },
  { label: '核生化', href: '/mdc/nbc/nbc-index.htm', note: '核子、生物與化學武器' },
  { label: '反恐', href: '/mdc/terror/terror-index.htm', note: '恐怖主義與反恐作戰' },
  { label: '網路', href: '/mdc/net/net-index.htm', note: '網路與資訊相關專區' },
  { label: 'MDC 故事', href: '/mdc/mdcstory/story-index.htm', note: '站史與幕後' },
];
const BRANCHES = [
  { label: '太平洋戰爭博物館', href: '/pwm/index2.htm', note: '直屬分館' },
  { label: 'MDCWW2', href: '/mdcww2/index2.htm', note: '二次大戰分館' },
  { label: 'SMP 蘇聯紅軍網', href: '/smp/index.htm', note: '蘇聯武裝力量' },
];
const FEEDS = [
  { label: '近期新增', href: '/mdc/indexmid-table.htm' },
  { label: '維護日誌', href: '/mdc/updatelog-table.htm' },
];

/* ───────────────────────── storage ───────────────────────── */

function read(area, key, fallback) {
  try {
    const v = area.getItem(key);
    return v == null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}
function write(area, key, value) {
  try {
    area.setItem(key, JSON.stringify(value));
  } catch {
    // storage unavailable (private mode, quota): the app still works
  }
}

const settings = { theme: 'auto', size: 2, font: 'sans', ...read(localStorage, 'mdc.settings', {}) };
let history_ = read(localStorage, 'mdc.history', []);
let marks = read(localStorage, 'mdc.marks', []);
// The directory trail the reader came through, e.g. 海軍 → 美國.
let trail = read(sessionStorage, 'mdc.trail', []);
// Parts of the multi-part article last opened, so direct links between
// parts keep their tab bar.
let series = read(sessionStorage, 'mdc.series', null);

/* ───────────────────────── dom helpers ───────────────────────── */

const $ = (sel, root = document) => root.querySelector(sel);

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c);
  return el;
}

const view = $('#view');
const pathOf = (href) => href.split('#')[0];
const here = () => location.pathname + location.search;

/* ───────────────────────── appearance ───────────────────────── */

function applySettings() {
  const root = document.documentElement;
  if (settings.theme === 'auto') delete root.dataset.theme;
  else root.dataset.theme = settings.theme;
  root.dataset.size = settings.size;
  root.dataset.font = settings.font;
  for (const seg of document.querySelectorAll('#settings [data-setting]')) {
    for (const b of seg.children) b.setAttribute('aria-pressed', String(settings[seg.dataset.setting] === b.dataset.value));
  }
  write(localStorage, 'mdc.settings', settings);
}

function initSettings() {
  const panel = $('#settings');
  const button = $('#btn-settings');
  const toggle = (open) => {
    panel.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
  };
  button.addEventListener('click', (e) => {
    e.stopPropagation();
    toggle(panel.hidden);
  });
  document.addEventListener('click', (e) => {
    if (!panel.hidden && !panel.contains(e.target)) toggle(false);
  });
  panel.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.size) settings.size = Math.max(0, Math.min(5, settings.size + Number(b.dataset.size)));
    else settings[b.parentElement.dataset.setting] = b.dataset.value;
    applySettings();
  });
  applySettings();
}

/* ───────────────────────── sidebar ───────────────────────── */

function renderSections() {
  const nav = $('#sections');
  const list = (items) => h('ul', null, items.map((s) => h('li', null, h('a', { href: s.href }, s.label))));
  nav.replaceChildren(
    list(SECTIONS),
    h('h2', null, '分館'),
    list(BRANCHES),
    h('h2', null, '動態'),
    list(FEEDS),
  );
}

function markCurrent() {
  const current = here();
  const top = trail[0] && trail[0].path;
  for (const a of document.querySelectorAll('#sections a')) {
    a.classList.toggle('on', a.getAttribute('href') === current || a.getAttribute('href') === top);
  }
  let active = null;
  for (const a of document.querySelectorAll('#context-list a, .directory a')) {
    // a part of a multi-part article still belongs to its entry in the list
    const href = pathOf(a.getAttribute('href'));
    const on = href === current || (location.search.startsWith('?page=') && href === location.pathname);
    a.classList.toggle('on', on);
    if (on && a.closest('#context-list')) active = a;
  }
  if (active) {
    const group = active.closest('details');
    if (group) group.open = true;
  }
}

function directoryList(items) {
  return h('ul', null, items.map((it) => (it.heading
    ? h('li', { class: 'sub' }, it.heading)
    : h('li', null, h('a', linkAttrs(it), it.label)))));
}

function linkAttrs(it) {
  return it.kind === 'external' || it.kind === 'asset'
    ? { href: it.href, target: '_blank', rel: 'noopener noreferrer' }
    : { href: it.href };
}

function renderContext() {
  const box = $('#context');
  const level = trail[trail.length - 1];
  if (!level) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  $('#context-title').textContent = level.title || '目錄';
  const up = $('#context-up');
  const parent = trail[trail.length - 2];
  up.hidden = !parent;
  if (parent) {
    up.href = parent.path;
    up.textContent = '‹ ' + (parent.title || '上一層');
  }
  const single = level.menus.length === 1;
  $('#context-list').replaceChildren(
    ...level.menus.map((m, i) => (single || !m.title
      ? h('div', { class: 'group' }, m.title && !single ? h('h3', null, m.title) : null, directoryList(m.items))
      : h('details', { open: level.menus.length <= 3 && i === 0 }, h('summary', null, m.title, h('span', null, String(m.items.filter((x) => x.href).length))), directoryList(m.items)))),
  );
  const filter = $('#context-filter');
  filter.hidden = level.menus.reduce((n, m) => n + m.items.length, 0) < 14;
  filter.value = '';
  filterList($('#context-list'), '');
}

/** Hide entries that do not match; groups with no match disappear. */
function filterList(root, query) {
  const q = query.trim().toLowerCase();
  for (const group of root.querySelectorAll('details, .group, .dir-group')) {
    let any = false;
    for (const li of group.querySelectorAll('li')) {
      const hit = !q || (!li.classList.contains('sub') && li.textContent.toLowerCase().includes(q));
      li.hidden = !hit;
      if (hit && !li.classList.contains('sub')) any = true;
    }
    group.hidden = !any;
    if (q && group.tagName === 'DETAILS') group.open = true;
  }
}

function updateTrail(path, title, menus) {
  const level = { path, title, menus };
  const at = trail.findIndex((l) => l.path === path);
  const last = trail[trail.length - 1];
  const listed = (l) => l.menus.some((m) => m.items.some((i) => i.href && pathOf(i.href) === path));
  if (at >= 0) trail = [...trail.slice(0, at), level];
  else if (last && listed(last)) trail = [...trail, level];
  else if (trail.length > 1 && listed(trail[trail.length - 2])) trail = [...trail.slice(0, -1), level];
  else trail = [level];
  write(sessionStorage, 'mdc.trail', trail);
}

/* ───────────────────────── routing ───────────────────────── */

let renderToken = 0;

function navigate(href, { label = '', replace = false } = {}) {
  const state = { label };
  if (replace) history.replaceState(state, '', href);
  else {
    saveScroll();
    history.pushState(state, '', href);
  }
  render({ restore: false });
}

function saveScroll() {
  history.replaceState({ ...(history.state || {}), y: window.scrollY }, '');
}

let lastPath = here();
window.addEventListener('popstate', () => {
  // in-page anchors change only the hash
  if (here() === lastPath) return;
  render({ restore: true });
});

let scrollTimer;
window.addEventListener('scroll', () => {
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(saveScroll, 150);
  updateProgress();
}, { passive: true });

document.addEventListener('click', (e) => {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const a = e.target.closest('a[href]');
  if (!a) return;
  if (a.dataset.full) {
    e.preventDefault();
    openLightbox(a);
    return;
  }
  if (a.target === '_blank' || a.origin !== location.origin || a.pathname.startsWith('/img/')) return;
  const href = a.pathname + a.search + a.hash;
  if (a.pathname + a.search === here() && a.hash) return; // same-page anchor
  e.preventDefault();
  closeDrawer();
  navigate(href, { label: cleanLabel(a.textContent) });
});

async function render({ restore }) {
  const token = ++renderToken;
  const path = here();
  lastPath = path;
  closeDrawer();
  document.body.classList.add('loading');
  $('#btn-mark').hidden = $('#btn-source').hidden = path === '/';
  $('#btn-source').href = SOURCE + (path === '/' ? '/' : path);

  try {
    if (path === '/') {
      renderHome();
    } else {
      if (!view.querySelector('.skeleton')) setTimeout(() => token === renderToken && document.body.classList.contains('loading') && showSkeleton(), 180);
      const page = await loadPage(path, (history.state && history.state.label) || '');
      if (token !== renderToken) return;
      if (page.home) return navigate('/', { replace: true });
      renderPage(page, path);
    }
  } catch (err) {
    if (token !== renderToken) return;
    if (err.asset) {
      location.replace(err.asset);
      return;
    }
    renderError(err, path);
  }
  document.body.classList.remove('loading');
  markCurrent();
  updateProgress();

  const y = restore && history.state ? history.state.y : null;
  if (y != null) window.scrollTo(0, y);
  else if (location.hash.length > 1) scrollToHash();
  else window.scrollTo(0, 0);
}

function scrollToHash() {
  let id = location.hash.slice(1);
  try {
    id = decodeURIComponent(id);
  } catch {
    // keep as is
  }
  const el = document.getElementById(id);
  if (el) el.scrollIntoView();
}

function showSkeleton() {
  view.replaceChildren(h('div', { class: 'page skeleton', 'aria-busy': 'true' },
    h('div', { class: 'sk sk-title' }), h('div', { class: 'sk sk-meta' }),
    ...[92, 100, 96, 70, 0, 98, 94, 100, 55].map((w) => h('div', { class: 'sk', style: `width:${w}%` }))));
}

function setCrumbs(items, current) {
  const nav = $('#crumbs');
  if (!items.length && !current) {
    nav.replaceChildren();
    return;
  }
  const parts = [{ label: '首頁', href: '/' }, ...items];
  const nodes = parts.flatMap((c) => [h('a', { href: c.href }, c.label), h('span', { class: 'sep', 'aria-hidden': 'true' }, '/')]);
  if (current) nodes.push(h('span', { class: 'here' }, current));
  else nodes.pop();
  nav.replaceChildren(...nodes);
}

/* ───────────────────────── page view ───────────────────────── */

function renderPage(page, requested) {
  if (page.path !== requested) {
    history.replaceState(history.state, '', page.path + location.hash);
    lastPath = here();
  }
  const path = here();

  // multi-part articles
  let tabs = page.tabs;
  if (tabs) {
    series = { items: tabs.items };
    write(sessionStorage, 'mdc.series', series);
  } else if (series) {
    const at = series.items.findIndex((i) => i.page === path);
    if (at >= 0) tabs = { items: series.items, active: at };
  }

  const known = [...SECTIONS, ...BRANCHES, ...FEEDS].find((s) => s.href === path);
  if (!page.title) page.title = (known && known.label) || page.file;

  const isDirectory = page.menus.length > 0;
  if (isDirectory) updateTrail(path, page.title, page.menus);
  else if (known) {
    trail = [];
    write(sessionStorage, 'mdc.trail', trail);
  }
  renderContext();

  // breadcrumbs: the site's own trail when it has one, else the directory trail
  let crumbs = (page.crumbs || []).filter((c) => c.href !== '/' && pathOf(c.href) !== path);
  if (!crumbs.length) crumbs = trail.filter((l) => l.path !== path).map((l) => ({ label: l.title || '目錄', href: l.path }));
  setCrumbs(crumbs, page.title);

  const article = h('article', { class: 'prose' }, page.blocks);
  // tables are reference material, not reading time
  const count = (el) => el.textContent.replace(/\s+/g, '').length;
  const tabular = [...article.querySelectorAll('.table-wrap')].reduce((n, t) => n + count(t), 0);
  const words = count(article) - tabular;
  const pictures = article.querySelectorAll('img').length;
  const isArticle = words > 600;

  const meta = [];
  if (isArticle) meta.push(`約 ${words.toLocaleString('en-US')} 字`, `閱讀約 ${Math.max(1, Math.round(words / 500))} 分鐘`);
  if (pictures > 3) meta.push(`${pictures} 張圖`);
  if (page.lastModified && (words > 0 || tabular > 0)) {
    const d = new Date(page.lastModified);
    if (!Number.isNaN(d.getTime())) meta.push(`原站更新於 ${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`);
  }

  const toc = isArticle ? buildToc(article) : null;
  const root = h('div', { class: 'page' + (toc ? ' has-toc' : '') },
    h('header', { class: 'page-head' },
      tabs ? h('p', { class: 'kicker' }, `第 ${tabs.active + 1} 部分，共 ${tabs.items.length} 部分`) : null,
      h('h1', null, page.title),
      meta.length ? h('p', { class: 'meta' }, meta.join(' · ')) : null),
    tabs ? renderTabs(tabs) : null,
    isDirectory ? renderDirectory(page.menus) : null,
    words || pictures || tabular ? article : null,
    !isDirectory && !words && !pictures && !tabular ? h('p', { class: 'empty' }, '這個頁面沒有可顯示的內容。') : null,
    tabs ? renderPager(tabs) : null,
    h('footer', { class: 'page-foot' },
      h('span', null, '內容取自 ', h('a', { href: SOURCE + path, target: '_blank', rel: 'noopener noreferrer' }, 'MDC軍武狂人夢'), '，版權屬原作者所有。'),
      h('button', { class: 'link', onclick: () => { refreshNext(); render({ restore: false }); } }, '重新抓取')),
  );
  if (toc) root.append(toc);
  view.replaceChildren(root);
  document.title = `${page.title} · MDC 閱讀器`;

  syncMark(path, page.title);
  if (isArticle && !isDirectory) remember(path, page.title);
  if (toc) watchToc(article, toc);
}

function renderTabs(tabs) {
  return h('nav', { class: 'parts', 'aria-label': '文章分頁' },
    tabs.items.map((t, i) => h('a', { href: t.href, class: i === tabs.active ? 'on' : null, 'aria-current': i === tabs.active ? 'page' : null },
      h('b', null, String(i + 1)), t.label)));
}

function renderPager(tabs) {
  const prev = tabs.items[tabs.active - 1];
  const next = tabs.items[tabs.active + 1];
  if (!prev && !next) return null;
  return h('nav', { class: 'pager', 'aria-label': '上下篇' },
    prev ? h('a', { href: prev.href, class: 'prev' }, h('small', null, '上一部分'), prev.label) : h('span'),
    next ? h('a', { href: next.href, class: 'next' }, h('small', null, '下一部分'), next.label) : h('span'));
}

function renderDirectory(menus) {
  const total = menus.reduce((n, m) => n + m.items.filter((i) => i.href).length, 0);
  const groups = h('div', { class: 'dir-groups' + (menus.length === 1 ? ' single' : '') },
    menus.map((m) => h('section', { class: 'dir-group' }, m.title ? h('h2', null, m.title, h('span', null, String(m.items.filter((i) => i.href).length))) : null, directoryList(m.items))));
  const box = h('div', { class: 'directory' });
  if (total >= 14) {
    box.append(h('input', {
      type: 'search', class: 'dir-filter', placeholder: `在 ${total} 個項目中篩選…`, 'aria-label': '篩選目錄', autocomplete: 'off',
      oninput: (e) => filterList(groups, e.target.value),
    }));
  }
  box.append(groups);
  return box;
}

function buildToc(article) {
  const heads = [...article.querySelectorAll('h2, h3')].filter((el) => !el.closest('table'));
  if (heads.length < 3) return null;
  heads.forEach((el, i) => {
    if (!el.id) el.id = `s${i + 1}`;
  });
  return h('aside', { class: 'toc', 'aria-label': '本頁段落' },
    h('h2', null, '本頁段落'),
    h('ol', null, heads.map((el) => h('li', { class: el.tagName === 'H3' ? 'l3' : null }, h('a', { href: '#' + el.id }, el.textContent)))));
}

let tocObserver;
function watchToc(article, toc) {
  if (tocObserver) tocObserver.disconnect();
  const links = new Map([...toc.querySelectorAll('a')].map((a) => [decodeURIComponent(a.hash.slice(1)), a]));
  tocObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      for (const a of links.values()) a.classList.remove('on');
      const a = links.get(e.target.id);
      if (a) a.classList.add('on');
    }
  }, { rootMargin: '-10% 0px -75% 0px' });
  for (const el of article.querySelectorAll('h2, h3')) if (el.id) tocObserver.observe(el);
}

function renderError(err, path) {
  setCrumbs([], '');
  view.replaceChildren(h('div', { class: 'page state' },
    h('h1', null, err.status === 404 ? '原站沒有這個頁面' : '載入失敗'),
    h('p', null, String(err.message || err)),
    h('p', { class: 'actions' },
      h('button', { class: 'btn', onclick: () => { refreshNext(); render({ restore: false }); } }, '再試一次'),
      h('a', { class: 'btn ghost', href: SOURCE + path, target: '_blank', rel: 'noopener noreferrer' }, '開啟原站頁面'),
      h('a', { class: 'btn ghost', href: '/' }, '回首頁'))));
  document.title = '載入失敗 · MDC 閱讀器';
}

/* ───────────────────────── home ───────────────────────── */

function renderHome() {
  setCrumbs([], '');
  trail = [];
  write(sessionStorage, 'mdc.trail', trail);
  renderContext();
  document.title = 'MDC 閱讀器';

  const card = (s, i) => h('a', { class: 'card', href: s.href },
    h('span', { class: 'no' }, String(i + 1).padStart(2, '0')), h('b', null, s.label), h('small', null, s.note));
  const entry = (e, removable) => h('li', null,
    h('a', { href: e.path }, e.title),
    removable ? h('button', { class: 'x', 'aria-label': '移除書籤', onclick: () => { marks = marks.filter((m) => m.path !== e.path); write(localStorage, 'mdc.marks', marks); renderHome(); } }, '×') : null);

  const recent = h('ol', { class: 'feed' }, h('li', { class: 'pending' }, '正在讀取原站的更新紀錄…'));
  view.replaceChildren(h('div', { class: 'page home' },
    h('header', { class: 'hero' },
      h('p', { class: 'kicker' }, 'Military Dreamer Club'),
      h('h1', null, '軍武狂人夢'),
      h('p', { class: 'lede' }, '同樣的文章，換一個好讀的版面。所有文字、圖片與表格都在你打開頁面時即時取自 ',
        h('a', { href: SOURCE + '/', target: '_blank', rel: 'noopener noreferrer' }, 'mdc.idv.tw'), '。')),
    h('section', null, h('h2', null, '分區'), h('div', { class: 'cards' }, SECTIONS.map(card))),
    h('section', null, h('h2', null, '分館'), h('div', { class: 'cards three' }, BRANCHES.map(card))),
    history_.length || marks.length ? h('div', { class: 'cols' },
      history_.length ? h('section', null, h('h2', null, '繼續閱讀'), h('ul', { class: 'list' }, history_.slice(0, 8).map((e) => entry(e)))) : null,
      marks.length ? h('section', null, h('h2', null, '書籤'), h('ul', { class: 'list' }, marks.map((e) => entry(e, true)))) : null) : null,
    h('section', null,
      h('h2', null, '近期新增', h('a', { href: FEEDS[0].href }, '全部')),
      recent),
  ));
  loadRecent(recent);
}

async function loadRecent(list) {
  try {
    const page = await loadPage(FEEDS[0].href);
    const rows = [];
    for (const block of page.blocks) {
      for (const tr of block.querySelectorAll?.('tr') || []) {
        const a = tr.querySelector('a[href]');
        const cells = [...tr.cells].map((c) => c.textContent.trim());
        if (!a || cells.length < 3) continue;
        rows.push({ section: cells[0], author: cells[1], title: cleanLabel(a.textContent), href: a.getAttribute('href'), date: cells[cells.length - 1] });
        if (rows.length >= 20) break;
      }
      if (rows.length >= 20) break;
    }
    if (!list.isConnected) return;
    if (!rows.length) throw new Error('empty');
    list.replaceChildren(...rows.map((r) => h('li', null,
      h('time', null, r.date), h('a', { href: r.href }, r.title), h('span', { class: 'tag' }, r.section))));
  } catch {
    if (list.isConnected) list.replaceChildren(h('li', { class: 'pending' }, '暫時讀不到更新紀錄。'));
  }
}

/* ───────────────────────── history & bookmarks ───────────────────────── */

function remember(path, title) {
  history_ = [{ path, title, t: Date.now() }, ...history_.filter((e) => e.path !== path)].slice(0, 40);
  write(localStorage, 'mdc.history', history_);
}

let markTarget = null;
function syncMark(path, title) {
  markTarget = { path, title };
  const on = marks.some((m) => m.path === path);
  const b = $('#btn-mark');
  b.setAttribute('aria-pressed', String(on));
  b.setAttribute('aria-label', on ? '移除書籤' : '加入書籤');
  b.title = on ? '移除書籤' : '加入書籤';
}
$('#btn-mark').addEventListener('click', () => {
  if (!markTarget) return;
  const on = marks.some((m) => m.path === markTarget.path);
  marks = on ? marks.filter((m) => m.path !== markTarget.path) : [{ ...markTarget, t: Date.now() }, ...marks];
  write(localStorage, 'mdc.marks', marks);
  syncMark(markTarget.path, markTarget.title);
});

/* ───────────────────────── chrome ───────────────────────── */

function updateProgress() {
  const max = document.documentElement.scrollHeight - window.innerHeight;
  $('#progress i').style.transform = `scaleX(${max > 200 ? Math.min(1, window.scrollY / max) : 0})`;
}

function closeDrawer() {
  document.body.classList.remove('nav-open');
}
$('#btn-menu').addEventListener('click', () => document.body.classList.toggle('nav-open'));
$('#scrim').addEventListener('click', closeDrawer);
$('#context-filter').addEventListener('input', (e) => filterList($('#context-list'), e.target.value));

/* ───────────────────────── lightbox ───────────────────────── */

const lightbox = $('#lightbox');
let gallery = [];
let galleryAt = 0;

function fullOf(el) {
  return el.dataset.full || el.currentSrc || el.src;
}

function openLightbox(el) {
  gallery = [...view.querySelectorAll('.prose img, .prose a[data-full]')].filter((x) => !(x.tagName === 'IMG' && x.closest('a[href]')));
  galleryAt = Math.max(0, gallery.indexOf(el));
  showSlide();
  if (!lightbox.open) lightbox.showModal();
}

function showSlide() {
  const el = gallery[galleryAt];
  const img = $('img', lightbox);
  img.src = fullOf(el);
  const fig = el.closest('figure');
  const cap = fig && fig.querySelector('figcaption');
  $('figcaption', lightbox).textContent = cap ? cap.textContent : el.tagName === 'A' ? el.textContent : '';
  lightbox.classList.toggle('solo', gallery.length < 2);
}

function step(d) {
  if (gallery.length < 2) return;
  galleryAt = (galleryAt + d + gallery.length) % gallery.length;
  showSlide();
}

view.addEventListener('click', (e) => {
  const img = e.target.closest('.prose img');
  if (!img || img.closest('a[href]')) return;
  openLightbox(img);
});
$('.lb-close', lightbox).addEventListener('click', () => lightbox.close());
$('.lb-prev', lightbox).addEventListener('click', () => step(-1));
$('.lb-next', lightbox).addEventListener('click', () => step(1));
lightbox.addEventListener('click', (e) => {
  if (e.target === lightbox || e.target.tagName === 'FIGURE') lightbox.close();
});
lightbox.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft') step(-1);
  if (e.key === 'ArrowRight') step(1);
});

/* ───────────────────────── start ───────────────────────── */

initSettings();
renderSections();
render({ restore: true });
