# MDC 閱讀器

A personal reading UI for [MDC軍武狂人夢](http://www.mdc.idv.tw/). The original
site has excellent content inside a 2000s FrontPage shell (framesets, nested
iframes, Big5, `<font>` tags, navigation hidden in `<select>` boxes). This
project puts a modern reader in front of it.

Nothing is copied or stored. Every page, picture and table is fetched from the
original site at the moment you open it; this repo contains only the UI.

## How it works

```
browser ──► Cloudflare Worker ──► http://www.mdc.idv.tw
  │            /api/page   one HTML page, transcoded to UTF-8
  │            /img/*      pictures and other files, passed through
  └─ static app (public/) cleans the HTML and lays it out
```

- **`src/worker.js`** – the only server-side code. The origin is HTTP-only and
  sends no CORS headers, so a browser cannot read it directly. The Worker
  fetches one page, detects whether the bytes are Big5 or UTF-8 (the site
  mixes both and labels them wrongly), and returns UTF-8. Responses sit in
  the edge cache (pages 6 h, images 30 days) so repeat views do not hit the
  origin again.
- **`public/js/extract.js`** – parses the page into an inert document and
  rebuilds it from an allowlist of elements. Along the way it follows
  frames and iframes and inlines them, turns `<select>` jump menus and
  link lists into a directory, turns tab wrappers into multi-part
  articles, drops layout tables but keeps data tables, merges hard-wrapped
  caption lines into one `<figcaption>`, and promotes bold one-liners to
  headings. No script, style or attribute of the original survives.
- **`public/js/app.js`** – routing and UI. URLs mirror the original site
  one-to-one (`/mdc/navy/usanavy/CVN78.htm` here is the same page there),
  so any original link can be opened by swapping the host.

Features: section directory with filtering, sidebar that keeps the directory
you came through, multi-part article tabs, table of contents, image lightbox,
light/dark theme, font size and typeface, bookmarks and reading history
(stored in your browser only), "open original" on every page.

## Run locally

```bash
npm install
npm run dev
```

Then open http://localhost:8787.

## Deploy to Cloudflare

Either from your machine:

```bash
npx wrangler login
npm run deploy
```

or connect the GitHub repo in the Cloudflare dashboard
(Workers & Pages → Create → Import a repository). No build command is
needed; the deploy command is `npx wrangler deploy`.

The free plan is more than enough for one reader.

### Keep it personal

The app sends `noindex` headers and a `robots.txt` that disallows everything,
so it will not show up in search engines. To make it truly private, put
[Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/)
in front of the Worker (free for up to 50 users) and allow only your own
e-mail address.

## Notes

- All content belongs to its original authors. Every page links back to its
  source.
- If the original site changes its markup, `extract.js` is the place to
  adjust. The "重新抓取" link at the bottom of each page bypasses the cache.
