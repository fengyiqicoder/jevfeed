import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, mkdtempSync, rmSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';

const BROWSERS = [
  { browser: 'Chrome', dir: 'Google/Chrome' },
  { browser: 'Arc', dir: 'Arc/User Data' },
  { browser: 'Brave', dir: 'BraveSoftware/Brave-Browser' },
  { browser: 'Edge', dir: 'Microsoft Edge' },
];

// Every browser profile with a History file, most recently used first; Chrome's last-used profile leads.
export function listHistorySources() {
  const base = join(homedir(), 'Library', 'Application Support');
  const out = [];
  for (const { browser, dir } of BROWSERS) {
    const root = join(base, dir);
    if (!existsSync(root)) continue;
    let names = {}, lastUsed = null;
    try {
      const state = JSON.parse(readFileSync(join(root, 'Local State'), 'utf8'));
      for (const [k, v] of Object.entries(state.profile?.info_cache || {})) names[k] = v.name;
      lastUsed = state.profile?.last_used || null;
    } catch { /* no Local State */ }
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || /^(System|Guest) Profile$/.test(entry.name)) continue;
      const file = join(root, entry.name, 'History');
      if (!existsSync(file)) continue;
      out.push({
        id: `${browser}:${entry.name}`,
        browser,
        profile: entry.name,
        name: names[entry.name] || entry.name,
        path: file,
        mtime: statSync(file).mtimeMs,
        lastUsed: entry.name === lastUsed,
      });
    }
  }
  return out.sort((a, b) => (b.browser === 'Chrome' && b.lastUsed) - (a.browser === 'Chrome' && a.lastUsed) || b.mtime - a.mtime);
}

export function findHistoryFile() {
  return listHistorySources()[0]?.path || null;
}

// Hosts and paths that carry no crawlable content: search engines, app UIs, auth flows, JS-only social feeds.
const SKIP_HOSTS =
  /(^|\.)(google|bing|baidu|duckduckgo|localhost|127\.0\.0\.1|accounts\.|login\.|mail\.|calendar\.|drive\.|docs\.google|notion\.so|slack\.com|figma\.com|linear\.app|github\.com\/.*\/(pull|issues)|chatgpt|claude\.(ai|com)|openai\.com|x\.com|twitter\.com|facebook\.com|instagram\.com|linkedin\.com|youtube\.com|tiktok\.com)/i;
const SKIP_PATH = /(\/(login|signin|sign-in|auth|oauth|logout|search|subject_search|cart|checkout|settings)(\/|$)|[?&](q|query|search_text|search)=)/i;

// Chrome stores microseconds since 1601-01-01.
const WEBKIT_EPOCH_OFFSET_US = 11644473600n * 1000000n;
export const webkitToMs = (t) => Number((BigInt(t) - WEBKIT_EPOCH_OFFSET_US) / 1000n);

// Copies the locked History file, then returns the most recent readable pages.
export function readRecentHistory(file = findHistoryFile(), { limit = 200 } = {}) {
  if (!file) throw new Error('No Chrome/Arc/Brave/Edge history file found in this user profile.');
  const dir = mkdtempSync(join(tmpdir(), 'jevfeed-'));
  const copy = join(dir, 'History');
  copyFileSync(file, copy);
  try {
    const db = new DatabaseSync(copy, { readOnly: true });
    const rows = db
      .prepare(
        `SELECT url, title, visit_count,
                (last_visit_time / 1000000 - 11644473600) * 1000 AS last_visit_ms
         FROM urls WHERE hidden = 0 AND title != '' ORDER BY last_visit_time DESC LIMIT ?`,
      )
      .all(limit * 4);
    db.close();
    return filterHistoryRows(rows).slice(0, limit);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function filterHistoryRows(rows) {
  const out = [];
  const seen = new Set();
  for (const r of rows) {
    let u;
    try {
      u = new URL(r.url);
    } catch {
      continue;
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') continue;
    if (SKIP_HOSTS.test(u.hostname + u.pathname) || SKIP_PATH.test(u.pathname + u.search)) continue;
    if (u.pathname === '/' && !u.search) continue; // home pages carry little signal
    u.hash = '';
    const key = u.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      url: key,
      title: r.title,
      visitCount: r.visit_count,
      lastVisitMs: r.last_visit_ms ?? (r.last_visit_time ? webkitToMs(r.last_visit_time) : null),
    });
  }
  return out;
}
