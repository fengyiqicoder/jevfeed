// Fetches a page and extracts links from its main content, plus lightweight metadata.
// No HTML parser dependency: a few forgiving regexes are enough for link discovery.

const UA = 'Mozilla/5.0 (Macintosh) JevFeed/0.1 (personal link explorer)';
const BAD_PATH =
  /\/(login|signin|signup|register|account|cart|checkout|privacy|terms|about|contact|careers|jobs|press|legal|cookie|sitemap|feed|rss|tag|tags|category|author|search|share|print|people|user|users|u|member|members|new_review|reviews|comments|blockquotes)(\/|$|\?)/i;
const BAD_HOST = /(^|\.)(facebook|twitter|x|instagram|linkedin|tiktok|youtube|pinterest|reddit|t|amazon|apple|google|microsoft|doubleclick|googletagmanager)\.com$/i;
const GENERIC_ANCHOR = /^(我要.*|全部\s*\d+\s*条|全部|查看原文|查看更多|查看全部|阅读全文|阅读更多|更多|下一页|上一页|第\d+页.*|返回.*|点击.*|这里|here|click here|read more|learn more|more|next|previous|continue reading|view all|see all|show more|link|source|via)$/i;
const DATE_LIKE = /^[\d\s:\-./年月日]+$/;
const BAD_EXT = /\.(png|jpe?g|gif|svg|webp|pdf|zip|mp4|mp3|css|js|json|xml|ico|woff2?)(\?|$)/i;

export async function fetchHtml(url, { timeoutMs = 10_000, maxBytes = 1_500_000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = res.headers.get('content-type') || '';
    if (!/html/i.test(type)) throw new Error(`Not HTML (${type.split(';')[0]})`);
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    while (size < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.length;
    }
    reader.cancel().catch(() => {});
    return { html: Buffer.concat(chunks).toString('utf8'), finalUrl: res.url || url };
  } finally {
    clearTimeout(timer);
  }
}

const decode = (s) =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/\s+/g, ' ')
    .trim();

export function extractMeta(html) {
  const pick = (re) => {
    const m = html.match(re);
    return m ? decode(m[1]) : null;
  };
  const title =
    pick(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ||
    pick(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i) ||
    pick(/<title[^>]*>([^<]+)<\/title>/i);
  const description =
    pick(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i) ||
    pick(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i) ||
    pick(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i) ||
    pick(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i);
  return { title: title?.slice(0, 200) || null, description: description?.slice(0, 400) || null };
}

// Keep the part of the document most likely to be authored content.
export function mainContent(html) {
  let h = html.replace(/<(script|style|noscript|svg|template)[\s\S]*?<\/\1>/gi, '');
  h = h.replace(/<(nav|header|footer|aside|form)[\s\S]*?<\/\1>/gi, '');
  const region =
    h.match(/<article[\s\S]*?<\/article>/i)?.[0] ||
    h.match(/<main[\s\S]*?<\/main>/i)?.[0] ||
    h.match(/<body[\s\S]*?<\/body>/i)?.[0] ||
    h;
  return region;
}

function acceptLink(raw, anchorRaw, base, found, perDomain, maxPerDomain) {
  let u;
  try {
    u = new URL(raw, base);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(u.protocol)) return null;
  if (BAD_HOST.test(u.hostname) || BAD_EXT.test(u.pathname) || BAD_PATH.test(u.pathname)) return null;
  if (u.pathname === '/' || u.pathname === '') return null;
  u.hash = '';
  for (const p of [...u.searchParams.keys()]) if (/^utm_|^ref$|^source$|^_spm/i.test(p)) u.searchParams.delete(p);
  const url = u.toString();
  if (url === base.toString() || found.has(url)) return null;
  const anchor = decode(anchorRaw.replace(/<[^>]+>/g, ''));
  // CJK anchors are short by nature: 4 characters of Chinese carry as much as 8 of English.
  const minLen = /[\u3400-\u9fff]/.test(anchor) ? 4 : 8;
  if (anchor.length < minLen || anchor.length > 200 || GENERIC_ANCHOR.test(anchor) || DATE_LIKE.test(anchor)) return null;
  const dom = u.hostname.replace(/^www\./, '');
  const n = perDomain.get(dom) || 0;
  if (n >= maxPerDomain) return null;
  perDomain.set(dom, n + 1);
  return { url, domain: dom, anchor };
}

export function extractLinks(html, baseUrl, { maxPerDomain = 4, max = 60 } = {}) {
  const base = new URL(baseUrl);
  const content = mainContent(html);
  const found = new Map();
  const perDomain = new Map();
  const re = /<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(content)) && found.size < max) {
    const link = acceptLink(m[1], m[2], base, found, perDomain, maxPerDomain);
    if (link) found.set(link.url, link);
  }
  return [...found.values()];
}

// Links from Jina Reader markdown: the page is browser-rendered, so JS-only sites work too.
export function extractMarkdownLinks(markdown, baseUrl, { maxPerDomain = 4, max = 60 } = {}) {
  const base = new URL(baseUrl);
  const found = new Map();
  const perDomain = new Map();
  const re = /\[([^\]]{1,200})\]\((https?:\/\/[^)\s]+)\)/g;
  let m;
  while ((m = re.exec(markdown)) && found.size < max) {
    if (/^!/.test(markdown[m.index - 1] || '')) continue; // image
    const link = acceptLink(m[2], m[1], base, found, perDomain, maxPerDomain);
    if (link) found.set(link.url, link);
  }
  return [...found.values()];
}

export async function fetchViaJina(url, { timeoutMs = 25_000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers = { Accept: 'text/plain', 'X-Retain-Images': 'none' };
    if (process.env.JINA_API_KEY) headers.Authorization = `Bearer ${process.env.JINA_API_KEY}`;
    const res = await fetch(`https://r.jina.ai/${url}`, { signal: ctrl.signal, headers });
    if (!res.ok) throw new Error(`Jina HTTP ${res.status}`);
    const text = await res.text();
    const title = text.match(/^Title:\s*(.+)$/m)?.[1]?.trim() || null;
    const body = text.split(/^Markdown Content:\s*$/m)[1] ?? text;
    return { title, markdown: body };
  } finally {
    clearTimeout(timer);
  }
}

// Jina Reader first (rendered page, clean main content); raw HTML as the fallback.
export async function crawlSeed(url, { useJina = process.env.JEVFEED_CRAWLER !== 'raw' } = {}) {
  if (useJina) {
    try {
      const { title, markdown } = await fetchViaJina(url);
      const links = extractMarkdownLinks(markdown, url);
      if (links.length) return { meta: { title, description: null }, links, via: 'jina' };
    } catch {
      /* fall through to raw */
    }
  }
  const { html, finalUrl } = await fetchHtml(url);
  const meta = extractMeta(html);
  return { meta, links: extractLinks(html, finalUrl), via: 'raw' };
}

// Metadata is a bonus, not a requirement: a blocked or slow page still has its anchor text.
export async function enrich(url, anchor) {
  try {
    const { html } = await fetchHtml(url, { timeoutMs: 8000, maxBytes: 300_000 });
    const meta = extractMeta(html);
    return { title: meta.title || anchor || null, description: meta.description, dead: !(meta.title || anchor) };
  } catch (e) {
    const gone = /HTTP (404|410)/.test(e.message);
    return { title: gone ? null : anchor || null, description: null, dead: gone || !anchor };
  }
}

export async function mapLimit(items, limit, fn) {
  const out = [];
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx]);
      }
    }),
  );
  return out;
}
