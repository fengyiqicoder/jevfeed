import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  openDb, addSeed, markVisited, nextSeedsToCrawl, markSeedCrawled, addCandidates,
  candidatesNeedingEnrichment, enrichCandidate, candidatesNeedingSummary, setSummary, candidatesNeedingRefresh, refreshCandidate, getSetting, setSetting, unseenCandidates, markShown, recordShown,
  recordFeedback, recentEvents, buildProfile, stats,
} from './db.mjs';
import { readRecentHistory, findHistoryFile, listHistorySources } from './history.mjs';
import { crawlSeed, enrich, mapLimit } from './crawl.mjs';
import { JevPicker } from './jev.mjs';
import { summarizerEnabled, summarize, refreshSummary, pageText, currentModel, BLOCKED_KINDS, LANGS, DEFAULT_LANG, kindLabel } from './summarize.mjs';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
loadEnv(join(root, '.env.local'));
const PORT = Number(process.env.JEVFEED_PORT || 3050);
const db = openDb(join(root, 'data', 'jevfeed.sqlite'));
const jev = new JevPicker();
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const lang = () => getSetting(db, 'lang', process.env.JEVFEED_LANG || DEFAULT_LANG);

function loadEnv(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

// ---------- background pipeline: crawl seeds, enrich candidates ----------
let busy = false;
async function pump() {
  if (busy) return;
  busy = true;
  try {
    // Jina's free tier allows ~20 requests/min; a key raises that a lot.
    const width = process.env.JINA_API_KEY ? 6 : 2;
    const seeds = nextSeedsToCrawl(db, width);
    await mapLimit(seeds, width, async (seed) => {
      try {
        const { meta, links, via } = await crawlSeed(seed.url);
        const added = addCandidates(
          db,
          links.map((l) => ({ ...l, sourceUrl: seed.url, sourceTitle: meta.title || seed.title })),
        );
        markSeedCrawled(db, seed.url, null);
        log(`crawled[${via}] ${seed.url.slice(0, 80)} → ${links.length} links, ${added} new`);
      } catch (e) {
        markSeedCrawled(db, seed.url, e.message);
        log(`crawl failed ${seed.url.slice(0, 80)}: ${e.message}`);
      }
    });
    const todo = candidatesNeedingEnrichment(db, 12);
    if (todo.length) {
      await mapLimit(todo, 6, async ({ url, anchor }) => enrichCandidate(db, url, await enrich(url, anchor)));
    }
  } finally {
    busy = false;
  }
}
setInterval(pump, process.env.JINA_API_KEY ? 3000 : 6000);

// Summaries run on their own clock: one cheap text-model call per candidate before it can reach Jev.
let summarizing = false;
async function summarizePump() {
  if (summarizing || !summarizerEnabled()) return;
  summarizing = true;
  try {
    // Backfill first: labelling and re-languaging a stored summary needs no page fetch, so it drains fast.
    const to = lang();
    const stale = candidatesNeedingRefresh(db, to, 8);
    if (stale.length) {
      await mapLimit(stale, 8, async (row) => {
        try {
          const r = await refreshSummary({ ...row, lang: to });
          refreshCandidate(db, row.url, { summary: r.summary, kind: r.kind, lang: to });
        } catch (e) {
          if (/HTTP 401|HTTP 402/.test(e.message)) throw e;
          refreshCandidate(db, row.url, { summary: row.summary, kind: 'OTHER', lang: to });
        }
      });
      log(`refreshed ${stale.length} summaries for ${to}`);
      return;
    }
    const todo = candidatesNeedingSummary(db, 8);
    await mapLimit(todo, 8, async ({ url, title, anchor }) => {
      try {
        const text = await pageText(url);
        const result = await summarize({ url, title: title || anchor, text, lang: to });
        setSummary(db, url, result?.summary ?? null, result?.kind ?? null, result ? to : null);
        log(`summary ${result ? result.kind : 'EMPTY'} ${url.slice(0, 60)}${result ? ' → ' + result.summary.slice(0, 50) : ''}`);
      } catch (e) {
        log(`summary failed ${url.slice(0, 70)}: ${e.message}`);
        if (/HTTP 401|HTTP 402/.test(e.message)) throw e; // bad key or no credit: stop the loop
        setSummary(db, url, null);
      }
    });
  } catch (e) {
    log('summarizer stopped:', e.message);
    summarizeTimer && clearInterval(summarizeTimer);
  } finally {
    summarizing = false;
  }
}
const summarizeTimer = setInterval(summarizePump, 2000);

// ---------- feed ----------
// Batches run one at a time so every ranking sees the feedback recorded before it.
let chain = Promise.resolve();
const nextBatch = (n) => (chain = chain.catch(() => {}).then(() => rankBatch(n)));
async function rankBatch(n = 10) {
  const candidates = unseenCandidates(db, {
    limit: 250,
    requireSummary: summarizerEnabled(),
    blockedKinds: summarizerEnabled() ? BLOCKED_KINDS : [],
  });
  if (candidates.length < 5) return { pending: true, stats: stats(db) };
  const profile = buildProfile(db);
  const events = recentEvents(db, 150);
  const r = await jev.rank({ profile, recentEvents: events, candidates, n });
  const items = r.ranked.map((c) => {
    markShown(db, c.url);
    const id = recordShown(db, { url: c.url, title: c.title, domain: c.domain, confidence: c.probability, reason: null });
    return {
      id, url: c.url, title: c.title, description: c.description, domain: c.domain, anchor: c.anchor,
      foundOn: c.source_title, foundOnUrl: c.source_url, probability: c.probability, rank: c.rank,
      summary: c.summary, kind: c.kind, kindLabel: kindLabel(c.kind, lang()),
    };
  });
  log(`ranked ${r.offered} unseen links in ${r.latencyMs}ms with ${events.length} events → batch of ${items.length}`);
  return { items, offered: r.offered, latencyMs: r.latencyMs, model: r.model, logSize: events.length };
}

// ---------- http ----------
const json = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
};
const readBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks)) : {});
      } catch (e) {
        reject(e);
      }
    });
  });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  // Local-only: refuse cross-origin browser requests.
  const origin = req.headers.origin;
  if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return json(res, 403, { error: 'forbidden' });
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(readFileSync(join(root, 'public', 'index.html')));
    }
    if (req.method === 'GET' && url.pathname === '/api/status') {
      const sources = listHistorySources().map(({ id, browser, name, profile, mtime }) => ({ id, browser, name, profile, mtime }));
      return json(res, 200, { ...stats(db), historyFile: findHistoryFile(), sources, model: jev.model, hasKey: Boolean(jev.apiKey), summarizer: summarizerEnabled() ? currentModel() : null, lang: lang(), langs: LANGS });
    }
    if (req.method === 'POST' && url.pathname === '/api/import-history') {
      const { source } = await readBody(req);
      const chosen = listHistorySources().find((x) => x.id === source) || listHistorySources()[0];
      if (!chosen) throw new Error('No browser history found.');
      const rows = readRecentHistory(chosen.path, { limit: 200 });
      log(`importing from ${chosen.id} (${chosen.name})`);
      for (const r of rows) addSeed(db, { url: r.url, title: r.title, origin: 'history' });
      markVisited(db, rows.map((r) => r.url));
      log(`imported ${rows.length} history pages as seeds`);
      pump();
      return json(res, 200, { imported: rows.length, ...stats(db) });
    }
    if (req.method === 'POST' && url.pathname === '/api/settings') {
      const { lang: next } = await readBody(req);
      if (!Object.hasOwn(LANGS, next)) return json(res, 400, { error: 'unsupported language' });
      setSetting(db, 'lang', next);
      log(`feed language set to ${next}`);
      return json(res, 200, { ok: true, lang: next });
    }
    if (req.method === 'POST' && url.pathname === '/api/seed') {
      const { url: seedUrl, title } = await readBody(req);
      if (!/^https?:\/\//.test(seedUrl || '')) return json(res, 400, { error: 'valid url required' });
      addSeed(db, { url: seedUrl, title: title ?? null, origin: 'manual' });
      pump();
      return json(res, 200, { ok: true, ...stats(db) });
    }
    if (req.method === 'GET' && url.pathname === '/api/batch') {
      const n = Math.min(20, Math.max(1, Number(url.searchParams.get('n')) || 10));
      return json(res, 200, await nextBatch(n));
    }
    if (req.method === 'POST' && url.pathname === '/api/feedback') {
      const { id, action, dwellMs, scrollPxs, openDwellMs } = await readBody(req);
      if (!id) return json(res, 400, { error: 'id required' });
      const ev = recordFeedback(db, id, { action, dwellMs, scrollPxs, openDwellMs });
      if (ev && action === 'open') {
        addSeed(db, { url: ev.url, title: ev.title, origin: action });
        markVisited(db, [ev.url]);
      }
      return json(res, 200, { ok: true, event: ev });
    }
    if (req.method === 'GET' && url.pathname === '/api/profile') {
      return json(res, 200, { profile: buildProfile(db), recent: recentEvents(db, 150), ...stats(db) });
    }
    if (req.method === 'POST' && url.pathname === '/api/reset-taste') {
      db.exec('DELETE FROM events');
      return json(res, 200, { ok: true });
    }
    json(res, 404, { error: 'not found' });
  } catch (e) {
    log('error', e.message);
    json(res, 500, { error: e.message });
  }
});

server.listen(PORT, '127.0.0.1', () => log(`JevFeed on http://127.0.0.1:${PORT}  (model ${jev.model})`));
