// Thin edge layer in front of the original site.
//
//   GET /api/page?u=/mdc/navy/...   one HTML page, transcoded to UTF-8
//   GET /img/mdc/navy/.../x.jpg     one image / binary file, passed through
//
// Nothing is stored permanently: responses sit in the edge cache for a while
// so that repeat views do not hit the origin again, and that is all.

const DEFAULT_ORIGIN = 'http://www.mdc.idv.tw';

const PAGE_EDGE_TTL = 6 * 3600; // seconds an HTML page stays in the edge cache
const PAGE_BROWSER_TTL = 300;
const ASSET_TTL = 30 * 86400;
const FETCH_TIMEOUT_MS = 25000;
const MAX_PAGE_BYTES = 8 * 1024 * 1024;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return text('Method Not Allowed', 405);
    }
    try {
      if (url.pathname === '/api/page') return await handlePage(request, url, env, ctx);
      if (url.pathname.startsWith('/img/')) return await handleAsset(request, url, env, ctx);
    } catch (err) {
      const timedOut = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
      return text(timedOut ? '原站回應逾時' : `無法連線到原站：${err && err.message}`, timedOut ? 504 : 502);
    }
    return env.ASSETS.fetch(request);
  },
};

function text(body, status = 200, headers = {}) {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

/** Resolve a site-relative path against the origin, refusing anything that escapes it. */
function originUrl(env, path) {
  const origin = new URL(env.ORIGIN || DEFAULT_ORIGIN);
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//') || path.includes('\\')) {
    return null;
  }
  let target;
  try {
    target = new URL(path, origin);
  } catch {
    return null;
  }
  if (target.origin !== origin.origin) return null;
  target.hash = '';
  return target;
}

function fetchOrigin(target) {
  return fetch(target.toString(), {
    headers: {
      'user-agent': 'Mozilla/5.0 (compatible; mdc-reader; personal reading proxy)',
      accept: '*/*',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
}

/**
 * The site mixes Big5 and UTF-8 files, and neither the HTTP header nor the
 * <meta> tag can be trusted (UTF-8 files are served as "charset=Big5", some
 * Big5 files declare utf-8). So look at the bytes: a BOM or a clean strict
 * UTF-8 decode means UTF-8, otherwise fall back to the declared legacy
 * charset, defaulting to Big5.
 */
function decodeHtml(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { html: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'utf-8' };
  }
  try {
    return { html: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8' };
  } catch {
    // not UTF-8
  }
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 4096)).toLowerCase();
  const declared = (head.match(/charset\s*=\s*["']?\s*([a-z0-9_-]+)/) || [])[1] || '';
  const encoding = /^(gb2312|gbk|gb18030|x-gbk)$/.test(declared) ? 'gbk' : 'big5';
  return { html: new TextDecoder(encoding).decode(bytes), encoding };
}

async function handlePage(request, url, env, ctx) {
  const u = url.searchParams.get('u') || '';
  const target = originUrl(env, u);
  if (!target) return text('Bad path', 400);

  const cache = caches.default;
  const cacheKey = new Request(`${url.origin}/api/page?u=${encodeURIComponent(target.pathname + target.search)}`);
  const fresh = url.searchParams.has('fresh');
  if (!fresh) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }

  const upstream = await fetchOrigin(target);
  const type = (upstream.headers.get('content-type') || '').toLowerCase();
  if (!upstream.ok) {
    return text(upstream.status === 404 ? '原站沒有這個頁面' : `原站回應 ${upstream.status}`, upstream.status === 404 ? 404 : 502);
  }
  if (type && !type.includes('html') && !type.includes('text/plain')) {
    // Not a page (image, pdf...): tell the client to use the asset route.
    return text('Not an HTML page', 415, { 'x-asset': '/img' + target.pathname });
  }

  const bytes = new Uint8Array(await upstream.arrayBuffer());
  if (bytes.length > MAX_PAGE_BYTES) return text('頁面過大', 413);
  const { html, encoding } = decodeHtml(bytes);

  const final = new URL(upstream.url || target.toString());
  const headers = {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': `public, max-age=${PAGE_BROWSER_TTL}, s-maxage=${PAGE_EDGE_TTL}`,
    'x-source-encoding': encoding,
    'x-source-path': final.pathname + final.search,
    'x-content-type-options': 'nosniff',
    // This is raw third-party markup. It is only ever meant to be read by
    // the app with fetch(); if someone opens the URL directly, run nothing.
    'content-security-policy': "sandbox; default-src 'none'",
  };
  const lastModified = upstream.headers.get('last-modified');
  if (lastModified) headers['x-source-last-modified'] = lastModified;

  const response = new Response(html, { headers });
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

async function handleAsset(request, url, env, ctx) {
  const target = originUrl(env, url.pathname.slice('/img'.length) + url.search);
  if (!target) return text('Bad path', 400);

  const cache = caches.default;
  const cacheKey = new Request(url.toString());
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const upstream = await fetchOrigin(target);
  const type = (upstream.headers.get('content-type') || 'application/octet-stream').toLowerCase();
  if (!upstream.ok) return text('Not found', upstream.status === 404 ? 404 : 502);
  // HTML never goes through this route: it would run on our own origin.
  if (type.includes('html') || type.includes('javascript')) return text('Not an asset', 415);

  const headers = {
    'content-type': type,
    'cache-control': `public, max-age=${ASSET_TTL}`,
    'x-content-type-options': 'nosniff',
    'content-security-policy': "sandbox; default-src 'none'; style-src 'unsafe-inline'",
  };
  const lastModified = upstream.headers.get('last-modified');
  if (lastModified) headers['last-modified'] = lastModified;

  const response = new Response(upstream.body, { headers });
  if (request.method === 'GET') ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}
