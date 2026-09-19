import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS seeds (
      url TEXT PRIMARY KEY,
      title TEXT,
      origin TEXT NOT NULL,            -- history | like | open
      added_at INTEGER NOT NULL,
      crawled_at INTEGER,
      crawl_error TEXT
    );
    CREATE TABLE IF NOT EXISTS candidates (
      url TEXT PRIMARY KEY,
      domain TEXT NOT NULL,
      anchor TEXT,                     -- link text on the source page
      title TEXT,
      description TEXT,
      source_url TEXT,
      source_title TEXT,
      discovered_at INTEGER NOT NULL,
      enriched_at INTEGER,
      summary TEXT,                    -- one-sentence summary from the text model
      kind TEXT,                       -- ARTICLE | PAPER | BOOK | TOOL | PRODUCT | ...
      summarized_at INTEGER,
      status TEXT NOT NULL DEFAULT 'new'   -- new | shown | dead
    );
    CREATE INDEX IF NOT EXISTS candidates_status ON candidates(status, discovered_at);
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT NOT NULL,
      title TEXT,
      domain TEXT,
      shown_at INTEGER NOT NULL,
      dwell_ms INTEGER,
      action TEXT,                     -- skip | open
      scroll_pxs INTEGER,              -- scroll speed when the item left the viewport
      open_dwell_ms INTEGER,
      confidence REAL,
      reason TEXT
    );
    CREATE TABLE IF NOT EXISTS visited (url TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  // Older databases predate the summary columns.
  const cols = db.prepare('PRAGMA table_info(candidates)').all().map((c) => c.name);
  if (!cols.includes('summary')) db.exec('ALTER TABLE candidates ADD COLUMN summary TEXT; ALTER TABLE candidates ADD COLUMN summarized_at INTEGER;');
  if (!cols.includes('kind')) db.exec('ALTER TABLE candidates ADD COLUMN kind TEXT;');
  if (!cols.includes('summary_lang')) db.exec('ALTER TABLE candidates ADD COLUMN summary_lang TEXT;');
  return db;
}

export const now = () => Date.now();

export function getSetting(db, key, fallback = null) {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? fallback;
}

export function setSetting(db, key, value) {
  db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
}

export function addSeed(db, { url, title, origin }) {
  db.prepare(
    `INSERT INTO seeds (url, title, origin, added_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(url) DO NOTHING`,
  ).run(url, title ?? null, origin, now());
}

export function markVisited(db, urls) {
  const stmt = db.prepare('INSERT OR IGNORE INTO visited (url) VALUES (?)');
  for (const url of urls) stmt.run(url);
}

export function nextSeedsToCrawl(db, limit = 4) {
  return db
    .prepare(
      `SELECT url, title, origin FROM seeds WHERE crawled_at IS NULL
       ORDER BY CASE origin WHEN 'open' THEN 0 ELSE 1 END, added_at DESC LIMIT ?`,
    )
    .all(limit);
}

export function markSeedCrawled(db, url, error) {
  db.prepare('UPDATE seeds SET crawled_at = ?, crawl_error = ? WHERE url = ?').run(
    now(),
    error ?? null,
    url,
  );
}

export function addCandidates(db, rows) {
  const stmt = db.prepare(
    `INSERT INTO candidates (url, domain, anchor, source_url, source_title, discovered_at)
     VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(url) DO NOTHING`,
  );
  const visited = db.prepare('SELECT 1 FROM visited WHERE url = ?');
  const t = now();
  let added = 0;
  for (const r of rows) {
    if (visited.get(r.url)) continue;
    added += stmt.run(r.url, r.domain, r.anchor ?? null, r.sourceUrl, r.sourceTitle ?? null, t).changes;
  }
  return added;
}

export function candidatesNeedingEnrichment(db, limit = 8) {
  return db
    .prepare(
      `SELECT url, anchor FROM candidates WHERE status = 'new' AND enriched_at IS NULL
       ORDER BY discovered_at DESC LIMIT ?`,
    )
    .all(limit);
}

export function enrichCandidate(db, url, { title, description, dead }) {
  db.prepare(
    `UPDATE candidates SET title = COALESCE(?, title), description = ?, enriched_at = ?,
       status = CASE WHEN ? THEN 'dead' ELSE status END WHERE url = ?`,
  ).run(title ?? null, description ?? null, now(), dead ? 1 : 0, url);
}

export function candidatesNeedingSummary(db, limit = 4) {
  return db
    .prepare(
      `SELECT url, title, anchor FROM candidates WHERE status = 'new' AND enriched_at IS NOT NULL
         AND title IS NOT NULL AND summarized_at IS NULL ORDER BY discovered_at DESC LIMIT ?`,
    )
    .all(limit);
}

// A null summary means the model judged the page empty: it is dropped from the feed.
export function setSummary(db, url, summary, kind = null, lang = null) {
  db.prepare(
    `UPDATE candidates SET summary = ?, kind = ?, summary_lang = ?, summarized_at = ?,
       status = CASE WHEN ? THEN status ELSE 'dead' END WHERE url = ?`,
  ).run(summary, kind, lang, now(), summary ? 1 : 0, url);
}

// Stored summaries that still lack a kind, or were written in another language.
export function candidatesNeedingRefresh(db, lang, limit = 8) {
  return db
    .prepare(
      `SELECT url, title, summary FROM candidates
       WHERE status = 'new' AND summary IS NOT NULL AND (kind IS NULL OR summary_lang IS NULL OR summary_lang != ?)
       ORDER BY discovered_at DESC LIMIT ?`,
    )
    .all(lang, limit);
}

export function refreshCandidate(db, url, { summary, kind, lang }) {
  db.prepare('UPDATE candidates SET summary = ?, kind = ?, summary_lang = ? WHERE url = ?').run(summary, kind, lang, url);
}

// Unseen candidates offered to Jev. The API accepts at most 255 choices, so beyond that
// it gets the newest ones plus a random sample of the rest.
// Mirror sites and reposts produce many near-identical titles; one of each is enough.
export function titleKey(title = '') {
  return title
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .slice(0, 24);
}

export function dedupeByTitle(rows) {
  const seen = new Set();
  return rows.filter((r) => {
    const k = titleKey(r.title || r.anchor || '');
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export function unseenCandidates(db, { limit = 250, newestShare = 0.25, requireSummary = false, blockedKinds = [] } = {}) {
  const newest = Math.round(limit * newestShare);
  // Blocked kinds stay in the table, so the rule can change without re-summarizing anything.
  const block = blockedKinds.length
    ? ` AND kind IS NOT NULL AND kind NOT IN (${blockedKinds.map((k) => `'${k.replace(/\W/g, '')}'`).join(',')})`
    : '';
  const ready = `status = 'new' AND enriched_at IS NOT NULL AND title IS NOT NULL` + (requireSummary ? ' AND summary IS NOT NULL' : '') + block;
  const recent = dedupeByTitle(
    db.prepare(`SELECT * FROM candidates WHERE ${ready} ORDER BY discovered_at DESC LIMIT ?`).all(newest * 2),
  ).slice(0, newest);
  if (recent.length < newest) return recent;
  const seen = new Set(recent.map((r) => r.url));
  const keys = new Set(recent.map((r) => titleKey(r.title || r.anchor || '')));
  const rest = db
    .prepare(`SELECT * FROM candidates WHERE ${ready} ORDER BY RANDOM() LIMIT ?`)
    .all(limit)
    .filter((r) => !seen.has(r.url) && !keys.has(titleKey(r.title || r.anchor || '')))
    .slice(0, limit - newest);
  return [...recent, ...rest];
}

export function markShown(db, url) {
  db.prepare(`UPDATE candidates SET status = 'shown' WHERE url = ?`).run(url);
}

export function recordShown(db, { url, title, domain, confidence, reason }) {
  return db
    .prepare(
      `INSERT INTO events (url, title, domain, shown_at, confidence, reason) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(url, title ?? null, domain ?? null, now(), confidence ?? null, reason ?? null).lastInsertRowid;
}

export function recordFeedback(db, id, { action, dwellMs, scrollPxs, openDwellMs }) {
  // An open always wins over a later skip; dwell only grows.
  db.prepare(
    `UPDATE events SET
       action = CASE WHEN action = 'open' THEN 'open' ELSE COALESCE(?, action) END,
       dwell_ms = MAX(COALESCE(?, 0), COALESCE(dwell_ms, 0)),
       scroll_pxs = COALESCE(?, scroll_pxs),
       open_dwell_ms = COALESCE(?, open_dwell_ms) WHERE id = ?`,
  ).run(action ?? null, dwellMs ?? null, scrollPxs ?? null, openDwellMs ?? null, id);
  return db.prepare('SELECT * FROM events WHERE id = ?').get(id);
}

export function recentEvents(db, limit = 150) {
  return db
    .prepare(
      `SELECT url, title, domain, dwell_ms, action, scroll_pxs, open_dwell_ms FROM events
       WHERE action IS NOT NULL ORDER BY id DESC LIMIT ?`,
    )
    .all(limit)
    .reverse();
}

const STOP = new Set(
  'the a an and or of to in on for with by from at as is are was be this that it its your you we our how why what when new best top vs into about over under after before more most les des und der die das 的 了 和 是 在 有 与'.split(
    ' ',
  ),
);

export function keywords(text, max = 6) {
  if (!text) return [];
  const counts = new Map();
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 3 || STOP.has(raw) || /^\d+$/.test(raw)) continue;
    counts.set(raw, (counts.get(raw) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([w]) => w);
}

// Slow-moving taste profile derived from all feedback so far.
export function buildProfile(db) {
  const rows = db
    .prepare(`SELECT title, domain, action, dwell_ms, scroll_pxs, open_dwell_ms FROM events WHERE action IS NOT NULL`)
    .all();
  const score = new Map();
  const domains = new Map();
  const bump = (map, key, delta) => key && map.set(key, (map.get(key) || 0) + delta);
  for (const r of rows) {
    // Implicit signals only: opening is the strongest, then how long the item held attention.
    let w = r.action === 'open' ? 1.5 : -0.3;
    if (r.open_dwell_ms > 60_000) w += 1;
    if (r.action === 'skip' && r.dwell_ms > 6000) w += 0.6; // lingered, then passed
    if (r.action === 'skip' && r.dwell_ms < 1200 && r.scroll_pxs > 1500) w -= 0.5; // flicked past
    for (const k of keywords(r.title)) bump(score, k, w);
    bump(domains, r.domain, w);
  }
  const top = (map, sign) =>
    [...map.entries()]
      .filter(([, v]) => (sign > 0 ? v > 0 : v < 0))
      .sort((a, b) => sign * (b[1] - a[1]))
      .slice(0, 12)
      .map(([k]) => k);
  const seedTitles = db
    .prepare(`SELECT title FROM seeds WHERE origin = 'history' AND title IS NOT NULL ORDER BY added_at DESC LIMIT 60`)
    .all()
    .map((r) => r.title);
  const openedTitles = db
    .prepare(`SELECT title FROM events WHERE action = 'open' AND title IS NOT NULL ORDER BY id DESC LIMIT 25`)
    .all()
    .map((r) => r.title);
  return {
    likedTopics: top(score, 1),
    dislikedTopics: top(score, -1),
    likedDomains: top(domains, 1),
    dislikedDomains: top(domains, -1),
    recentHistoryTopics: keywords(seedTitles.join(' '), 15),
    // The raw titles are the strongest prior, especially before any feedback exists.
    browsingHistory: seedTitles.slice(0, 40).map((t) => t.slice(0, 70)),
    clickedInFeed: openedTitles.map((t) => t.slice(0, 70)),
    feedbackCount: rows.length,
  };
}

export function stats(db) {
  const one = (sql) => Object.values(db.prepare(sql).get())[0];
  return {
    seeds: one('SELECT COUNT(*) FROM seeds'),
    seedsCrawled: one('SELECT COUNT(*) FROM seeds WHERE crawled_at IS NOT NULL'),
    candidates: one(`SELECT COUNT(*) FROM candidates WHERE status = 'new'`),
    ready: one(`SELECT COUNT(*) FROM candidates WHERE status = 'new' AND enriched_at IS NOT NULL AND title IS NOT NULL`),
    summarized: one(`SELECT COUNT(*) FROM candidates WHERE status = 'new' AND summary IS NOT NULL`),
    classified: one(`SELECT COUNT(*) FROM candidates WHERE status = 'new' AND kind IS NOT NULL`),
    readable: one(`SELECT COUNT(*) FROM candidates WHERE status = 'new' AND summary IS NOT NULL AND kind IS NOT NULL AND kind NOT IN ('TOOL','PRODUCT','LISTING')`),
    translated: one(`SELECT COUNT(*) FROM candidates WHERE status = 'new' AND summary_lang IS NOT NULL`),
    events: one('SELECT COUNT(*) FROM events WHERE action IS NOT NULL'),
  };
}
