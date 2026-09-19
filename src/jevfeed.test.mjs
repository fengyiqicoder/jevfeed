import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractLinks, extractMarkdownLinks, extractMeta, mainContent } from './crawl.mjs';
import { filterHistoryRows, webkitToMs } from './history.mjs';
import { buildRequest, validateChoice, JevPicker } from './jev.mjs';
import { openDb, addSeed, addCandidates, enrichCandidate, unseenCandidates, recordShown, recordFeedback, recentEvents, buildProfile } from './db.mjs';

const page = `<html><head><title>Post &amp; Title</title>
<meta property="og:description" content="A short summary"></head><body>
<nav><a href="/about">About us page link</a><a href="/blog/nav-item-long">Navigation item here</a></nav>
<article>
  <p>See <a href="https://example.org/deep/essay">an essay about attention economics</a> and
  <a href="https://example.org/deep/other?utm_source=x">another essay worth reading</a>,
  <a href="/img.png">picture with long text</a>, <a href="https://twitter.com/x/status/1">a tweet with enough text</a>,
  <a href="/login">Please log in now</a>, <a href="https://other.net/p/1">short</a>,
  <a href="https://book.example.org/subject/1">勒内·基拉尔</a>.</p>
</article>
<footer><a href="/privacy">Privacy policy statement</a></footer></body></html>`;

test('extractLinks keeps content links, drops chrome/social/assets/tracking', () => {
  const links = extractLinks(page, 'https://blog.example.com/post/1');
  const urls = links.map((l) => l.url);
  assert.deepEqual(urls, ['https://example.org/deep/essay', 'https://example.org/deep/other', 'https://book.example.org/subject/1']);
  assert.equal(links[0].anchor, 'an essay about attention economics');
  assert.equal(links[0].domain, 'example.org');
});

test('extractMarkdownLinks parses Jina output and drops generic/date anchors and images', () => {
  const md = `## 内容简介
![cover](https://img.example.com/a.png) 见 [欲望的先知](https://book.douban.com/subject/1/) 和
[查看原文](https://book.douban.com/annotation/2/)，[2025-03-18 10:37:03](https://book.douban.com/comment/3/)，
[Mimetic theory explained](https://example.org/mimetic?_spm_id=abc)`;
  const links = extractMarkdownLinks(md, 'https://book.douban.com/subject/0/');
  assert.deepEqual(links.map((l) => [l.anchor, l.url]), [
    ['欲望的先知', 'https://book.douban.com/subject/1/'],
    ['Mimetic theory explained', 'https://example.org/mimetic'],
  ]);
});

test('extractMeta decodes entities and prefers og tags', () => {
  assert.deepEqual(extractMeta(page), { title: 'Post & Title', description: 'A short summary' });
});

test('mainContent prefers article and strips nav/footer', () => {
  const c = mainContent(page);
  assert.ok(c.includes('attention economics'));
  assert.ok(!c.includes('Privacy policy'));
});

test('history filter drops search engines, home pages, dupes and converts time', () => {
  const rows = filterHistoryRows([
    { url: 'https://www.google.com/search?q=x', title: 'x', visit_count: 1, last_visit_time: 13400000000000000 },
    { url: 'https://site.com/', title: 'home', visit_count: 1, last_visit_time: 13400000000000000 },
    { url: 'https://site.com/a#frag', title: 'A', visit_count: 2, last_visit_time: 13400000000000000 },
    { url: 'https://site.com/a', title: 'A again', visit_count: 2, last_visit_time: 13400000000000000 },
    { url: 'chrome://settings', title: 'settings', visit_count: 1, last_visit_time: 0 },
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].url, 'https://site.com/a');
  assert.ok(new Date(rows[0].lastVisitMs).getFullYear() >= 2025);
  assert.equal(webkitToMs(11644473600000000n), 0);
});

test('buildRequest offers every candidate by index and carries the behavior log', () => {
  const body = buildRequest({
    model: 'jev-latest',
    profile: { likedTopics: ['a'] },
    recentEvents: [{ title: 'T', domain: 'd.com', action: 'skip', dwell_ms: 1234, scroll_pxs: 2100, open_dwell_ms: null }],
    candidates: [{ title: 'One', domain: 'a.com', description: 'x' }, { anchor: 'Two', domain: 'b.com' }],
  });
  assert.deepEqual(Object.keys(body.questions.link.criteria), ['0', '1']);
  assert.equal(body.questions.link.criteria['1'], 'Two — b.com');
  assert.deepEqual(body.state.behaviorLog[0], { t: 'T', d: 'd.com', a: 'skip', s: 1.2, v: 2100, r: undefined });
  assert.equal(body.questions.reason, undefined);
});

test('rank shrinks the candidate set on max_tokens_exceeded and still returns top N', async () => {
  let calls = 0;
  const picker = new JevPicker({
    apiKey: 'k',
    req: async ({ body }) => {
      calls++;
      const n = Object.keys(body.questions.link.criteria).length;
      if (n > 30) throw new Error('TypeSafe HTTP 400: {"detail":{"error_type":"max_tokens_exceeded"}}');
      const probabilities = Object.fromEntries(Array.from({ length: n }, (_, i) => [String(i), i === 0 ? 1 - (n - 1) * 0.01 : 0.01]));
      return { model: 'jev-test', answers: { link: { type: 'choice', choice: '0', confidence: 0.9, probabilities } } };
    },
  });
  const cands = Array.from({ length: 60 }, (_, i) => ({ title: 'T' + i, domain: 'd' }));
  const r = await picker.rank({ profile: {}, recentEvents: [], candidates: cands, n: 2 });
  assert.ok(calls > 1 && r.offered <= 30 && r.ranked[0].title === 'T0');
});

test('validateChoice rejects malformed distributions', () => {
  const criteria = { 0: 'a', 1: 'b' };
  assert.throws(() => validateChoice({ type: 'choice', choice: '0', confidence: 0.9, probabilities: { 0: 0.2, 1: 0.8 } }, criteria));
  assert.throws(() => validateChoice({ type: 'choice', choice: '2', confidence: 0.9, probabilities: { 0: 0.5, 1: 0.5 } }, criteria));
  assert.ok(validateChoice({ type: 'choice', choice: '1', confidence: 0.7, probabilities: { 0: 0.3, 1: 0.7 } }, criteria));
});

test('JevPicker.rank returns the top N of the whole distribution', async () => {
  const picker = new JevPicker({
    apiKey: 'k',
    req: async () => ({
      model: 'jev-test',
      answers: { link: { type: 'choice', choice: '2', confidence: 0.5, probabilities: { 0: 0.1, 1: 0.3, 2: 0.5, 3: 0.1 } } },
    }),
  });
  const cands = ['A', 'B', 'C', 'D'].map((t) => ({ title: t, domain: t.toLowerCase() }));
  const r = await picker.rank({ profile: {}, recentEvents: [], candidates: cands, n: 2 });
  assert.deepEqual(r.ranked.map((x) => [x.title, x.rank, x.probability]), [['C', 1, 0.5], ['B', 2, 0.3]]);
  assert.equal(r.offered, 4);
});

test('db round trip: seeds → candidates → shown → feedback → profile', () => {
  const db = openDb(':memory:');
  addSeed(db, { url: 'https://s.com/p', title: 'Seed', origin: 'history' });
  addCandidates(db, [
    { url: 'https://a.com/x', domain: 'a.com', anchor: 'Rust async runtime', sourceUrl: 'https://s.com/p' },
    { url: 'https://b.com/y', domain: 'b.com', anchor: 'Gardening tips', sourceUrl: 'https://s.com/p' },
  ]);
  assert.equal(unseenCandidates(db).length, 0, 'unenriched candidates are not offered');
  enrichCandidate(db, 'https://a.com/x', { title: 'Rust async runtime internals', description: 'd' });
  enrichCandidate(db, 'https://b.com/y', { title: 'Gardening tips', description: null });
  assert.equal(unseenCandidates(db).length, 2);
  const id = recordShown(db, { url: 'https://a.com/x', title: 'Rust async runtime internals', domain: 'a.com', confidence: 0.9, reason: 'DEEPER' });
  recordFeedback(db, id, { action: 'open', dwellMs: 3000 });
  recordFeedback(db, id, { openDwellMs: 90000 });
  recordFeedback(db, id, { action: 'skip', dwellMs: 2000, scrollPxs: 800 }); // scrolled past later: open still wins
  const ev = recentEvents(db);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].action, 'open');
  assert.equal(ev[0].dwell_ms, 3000);
  assert.equal(ev[0].scroll_pxs, 800);
  assert.equal(ev[0].open_dwell_ms, 90000);
  const p = buildProfile(db);
  assert.ok(p.likedTopics.includes('rust'));
  assert.deepEqual(p.likedDomains, ['a.com']);
});

test('summarize returns a kind with the sentence, and EMPTY drops the page', async () => {
  const { summarize, classify, parseSummary, htmlToText, BLOCKED_KINDS, buildPrompt } = await import('./summarize.mjs');
  let seen;
  const request = async ({ messages }) => { seen = messages; return 'ARTICLE|「这是一篇讲模仿欲望的访谈」\n多余的第二行'; };
  assert.deepEqual(await summarize({ url: 'https://a.com/x', title: 'T', text: 'body' }, { apiKey: 'k', request }), {
    kind: 'ARTICLE',
    summary: '这是一篇讲模仿欲望的访谈',
  });
  assert.ok(seen[1].content.includes('https://a.com/x') && seen[1].content.includes('body'));
  assert.equal(await summarize({ url: 'u', title: 't', text: '' }, { apiKey: 'k', request: async () => 'EMPTY' }), null);
  // An unlabelled or unknown label still yields a usable sentence.
  assert.deepEqual(parseSummary('没有类型前缀的一句话'), { kind: 'OTHER', summary: '没有类型前缀的一句话' });
  assert.deepEqual(parseSummary('NONSENSE|一句话'), { kind: 'OTHER', summary: '一句话' });
  assert.equal(await classify({ url: 'u', title: 't', summary: 's' }, { apiKey: 'k', request: async () => ' tool ' }), 'TOOL');
  assert.ok(BLOCKED_KINDS.includes('TOOL') && BLOCKED_KINDS.includes('PRODUCT'));
  assert.equal(htmlToText('<p>Hello <b>world</b></p><script>x()</script>'), 'Hello world');
  // The summary language is the feed's, not the page's.
  assert.match(buildPrompt({ url: 'u', title: 't', text: 'x', lang: 'en' })[0].content, /ONE sentence of English/);
  assert.match(buildPrompt({ url: 'u', title: 't', text: 'x', lang: 'zh' })[0].content, /ONE sentence of 简体中文/);
});

test('blocked kinds never reach the pool, and the rule is reversible', async () => {
  const { setSummary, candidatesNeedingRefresh, refreshCandidate } = await import('./db.mjs');
  const db = openDb(':memory:');
  addCandidates(db, [
    { url: 'https://a.com/1', domain: 'a.com', anchor: 'A real essay here', sourceUrl: 's' },
    { url: 'https://a.com/2', domain: 'a.com', anchor: 'A qr code generator', sourceUrl: 's' },
  ]);
  enrichCandidate(db, 'https://a.com/1', { title: 'Essay', description: null });
  enrichCandidate(db, 'https://a.com/2', { title: 'Generator', description: null });
  setSummary(db, 'https://a.com/1', 'An essay', 'ARTICLE', 'en');
  setSummary(db, 'https://a.com/2', 'A QR code generator', 'TOOL', 'en');
  assert.deepEqual(
    unseenCandidates(db, { requireSummary: true, blockedKinds: ['TOOL', 'PRODUCT'] }).map((r) => r.title),
    ['Essay'],
  );
  assert.equal(unseenCandidates(db, { requireSummary: true, blockedKinds: [] }).length, 2, 'still there, just filtered');
  // Rows lacking a kind, or written in another language, queue up for a refetch-free refresh.
  db.prepare('UPDATE candidates SET kind = NULL WHERE url = ?').run('https://a.com/1');
  assert.deepEqual(candidatesNeedingRefresh(db, 'en').map((r) => r.url), ['https://a.com/1']);
  refreshCandidate(db, 'https://a.com/1', { summary: 'An essay', kind: 'PAPER', lang: 'en' });
  assert.equal(candidatesNeedingRefresh(db, 'en').length, 0);
  assert.equal(candidatesNeedingRefresh(db, 'zh').length, 2, 'switching language re-queues everything');
  assert.equal(unseenCandidates(db, { requireSummary: true, blockedKinds: ['TOOL'] }).length, 1);
});

test('unseenCandidates can require a summary; EMPTY summaries kill the candidate', async () => {
  const { candidatesNeedingSummary, setSummary } = await import('./db.mjs');
  const db = openDb(':memory:');
  addCandidates(db, [
    { url: 'https://a.com/1', domain: 'a.com', anchor: 'First article here', sourceUrl: 's' },
    { url: 'https://a.com/2', domain: 'a.com', anchor: 'Second article here', sourceUrl: 's' },
  ]);
  enrichCandidate(db, 'https://a.com/1', { title: 'One', description: null });
  enrichCandidate(db, 'https://a.com/2', { title: 'Two', description: null });
  assert.equal(candidatesNeedingSummary(db).length, 2);
  setSummary(db, 'https://a.com/1', '讲第一件事', 'ARTICLE', 'zh');
  setSummary(db, 'https://a.com/2', null);
  assert.equal(unseenCandidates(db, { requireSummary: true }).length, 1);
  assert.equal(unseenCandidates(db, { requireSummary: false }).length, 1, 'dead candidate is gone either way');
});

test('profile carries raw browsing history and feed clicks; request ranks on click probability', () => {
  const db = openDb(':memory:');
  addSeed(db, { url: 'https://h.com/a', title: '一篇关于模仿欲望的长文', origin: 'history' });
  addCandidates(db, [{ url: 'https://c.com/1', domain: 'c.com', anchor: 'Some article here', sourceUrl: 's' }]);
  enrichCandidate(db, 'https://c.com/1', { title: 'Clicked thing', description: null });
  const id = recordShown(db, { url: 'https://c.com/1', title: 'Clicked thing', domain: 'c.com' });
  recordFeedback(db, id, { action: 'open', dwellMs: 5000 });
  const p = buildProfile(db);
  assert.deepEqual(p.browsingHistory, ['一篇关于模仿欲望的长文']);
  assert.deepEqual(p.clickedInFeed, ['Clicked thing']);
  const body = buildRequest({ model: 'm', profile: p, recentEvents: [], candidates: [{ title: 'X', domain: 'd' }] });
  assert.match(body.questions.link.instructions, /probability that THIS person would click/);
  assert.deepEqual(body.state.profile.browsingHistory, ['一篇关于模仿欲望的长文']);
});

test('hex html entities are decoded in extracted anchors', () => {
  const links = extractLinks(
    `<article><a href="https://e.org/p">Please don&#x27;t throw your mind away</a></article>`,
    'https://s.com/x',
  );
  assert.equal(links[0].anchor, "Please don't throw your mind away");
});

test('near-identical titles collapse and one domain cannot own a batch', async () => {
  const { dedupeByTitle } = await import('./db.mjs');
  assert.deepEqual(
    dedupeByTitle([
      { title: '祭牲与成神：初民社会的秩序', url: 'a' },
      { title: '祭牲与成神:初民社会的秩序 ', url: 'b' },
      { title: 'Another book entirely', url: 'c' },
    ]).map((r) => r.url),
    ['a', 'c'],
  );
  const cands = Array.from({ length: 6 }, (_, i) => ({ title: 'T' + i, domain: i < 5 ? 'same.com' : 'other.com' }));
  const picker = new JevPicker({
    apiKey: 'k',
    req: async () => ({
      model: 'm',
      answers: { link: { type: 'choice', choice: '0', confidence: 0.9, probabilities: { 0: 0.5, 1: 0.2, 2: 0.15, 3: 0.08, 4: 0.05, 5: 0.02 } } },
    }),
  });
  const r = await picker.rank({ profile: {}, recentEvents: [], candidates: cands, n: 5, maxPerDomain: 2 });
  assert.deepEqual(r.ranked.map((x) => x.title), ['T0', 'T1', 'T5']);
});

test('a summary in the wrong language is asked for again', async () => {
  const { summarize, languageMatches } = await import('./summarize.mjs');
  assert.ok(languageMatches('An English sentence', 'en') && !languageMatches('一句中文说明', 'en'));
  assert.ok(languageMatches('一句中文说明', 'zh') && !languageMatches('An English sentence', 'zh'));
  let n = 0;
  const request = async () => (++n === 1 ? 'REFERENCE|这是一个中文摘要' : 'REFERENCE|An English summary');
  const r = await summarize({ url: 'u', title: 't', text: 'x', lang: 'en' }, { apiKey: 'k', request });
  assert.deepEqual(r, { kind: 'REFERENCE', summary: 'An English summary' });
  assert.equal(n, 2, 'exactly one retry');
});

test('long summaries are cut on a word boundary, not mid-word', async () => {
  const { clip, parseSummary } = await import('./summarize.mjs');
  assert.equal(clip('short', 20), 'short');
  assert.equal(clip('one two three four five', 14), 'one two three…');
  assert.equal(clip('abcdefghijklmnopqrstuvwxyz', 10), 'abcdefghij…', 'no boundary: hard cut');
  const long = 'ARTICLE|' + 'word '.repeat(60);
  assert.ok(parseSummary(long).summary.endsWith('…') && parseSummary(long).summary.length <= 201);
});
