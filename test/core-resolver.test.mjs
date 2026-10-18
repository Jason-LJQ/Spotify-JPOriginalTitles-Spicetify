import test from 'node:test';
import assert from 'node:assert/strict';
import { Resolver, selection, hasCJK, japaneseNameCandidate } from '../src/resolver.mjs';
import { decodeMetadata, ld, vi, concat, uriToGID } from '../src/wire.mjs';
const uri = (type, n) => `spotify:${type}:${String(n).padStart(22, '0')}`;
const entity = (type, n, name) => concat(ld(1, uriToGID(uri(type, n))), ld(2, name));
function response(entries) {
  const kinds = new Map();
  for (const entry of entries) {
    const { kind, uri, status = 200, value } = entry;
    if (!kinds.has(kind)) kinds.set(kind, []);
    kinds.get(kind).push(ld(3, concat(ld(1, vi(1, status)), ld(2, uri), value !== undefined ? ld(3, ld(2, value)) : null)));
  }
  return concat([...kinds].map(([kind, entries]) => ld(2, concat(vi(2, kind), ...entries))));
}
function trackValue(t) {
  return concat(ld(2, t.name ?? ''), t.albumURI ? ld(3, concat(ld(1, uriToGID(t.albumURI)), ld(2, t.albumName ?? 'Album'))) : null,
    ...(t.artists ?? []).map(a => ld(4, concat(ld(1, uriToGID(a.uri)), ld(2, a.name)))),
    vi(5, t.number ?? 1), vi(6, t.disc ?? 1), vi(7, t.duration ?? 100000),
    t.isrc ? ld(10, concat(ld(1, 'isrc'), ld(2, t.isrc))) : null,
    ...(t.performanceLanguages ?? []).map(l => ld(22, l)), t.canonicalURI ? ld(36, t.canonicalURI) : null);
}
function albumValue(a) {
  return concat(ld(2, a.name ?? ''), a.originalURI ? ld(35, a.originalURI) : null,
    ld(11, concat(...(a.tracks ?? []).map(t => ld(3, ld(1, uriToGID(t)))))));
}



const record = (n, extra = {}) => ({ uri: uri('track', n), name: 'Romanized', isrc: 'JPTEST1234567', duration: 100000, number: 1, disc: 1, artists: [], performanceLanguages: [], ...extra });
function fixture(records = [], options = {}) {
  const map = new Map(records.map(r => [r.uri, r])), calls = [];
  const resolver = new Resolver({ store: { getArtistNames: () => new Map() }, ...options, request: async (entities, language, signal) => {
    calls.push({ entities, language, signal });
    if (options.request) return options.request(entities, language, signal, map, calls);
    return response(entities.map(e => {
      const r = map.get(`${e.uri}:${language}`) ?? map.get(e.uri), kind = e.kinds[0];
      return { uri: e.uri, kind, status: r ? 200 : 404, value: r ? kind === 10 ? trackValue(r) : kind === 9 ? albumValue(r) : ld(2, r.name) : undefined };
    }));
  } });
  return { resolver, calls, map };
}

test('direct canonical permits a changed ISRC with the exact same duration', async () => {
  const original = record(2, { name: '原曲', isrc: 'OTHER', number: 9 });
  const { resolver } = fixture([record(1, { canonicalURI: original.uri }), original]);
  const result = await resolver.resolve([uri('track', 1)]);
  assert.equal(result.tracks.get(uri('track', 1)).name, '原曲'); assert.equal(result.complete, true);
});
test('album field35 selects only a unique exact recording in fully fetched album', async () => {
  const a = uri('album', 1), b = uri('album', 2);
  const own = record(1, { albumURI: a }), original = record(2, { name: '原曲', albumURI: b });
  const { resolver } = fixture([own, original, { uri: a, name: 'Roman Album', originalURI: b, tracks: [own.uri] }, { uri: b, name: '原盤', tracks: [original.uri] }]);
  const result = await resolver.resolve([own.uri]);
  assert.equal(result.tracks.get(own.uri).name, '原曲'); assert.equal(result.tracks.get(own.uri).albumURI, b);
});
test('duplicate ISRC rejects album even if only one has matching position', () => {
  const own = record(1, { albumURI: uri('album', 1) }), a = record(2, { name: '原曲' }), b = record(3, { name: '別曲', number: 2 });
  const all = new Map([[a.uri, a], [b.uri, b], [own.albumURI, { name: '原盤', tracks: [a.uri, b.uri] }]]);
  assert.equal(selection.albumOriginal(own, all), undefined);
});
test('incomplete album or duration/disc/track mismatch rejects fallback', () => {
  const own = record(1, { albumURI: uri('album', 1) });
  for (const extra of [{ duration: 100001 }, { disc: 2 }, { number: 2 }]) {
    const a = record(2, { name: '原曲', ...extra });
    assert.equal(selection.albumOriginal(own, new Map([[a.uri, a], [own.albumURI, { name: '原盤', tracks: [a.uri] }]])), undefined);
  }
  assert.equal(selection.albumOriginal(own, new Map([[own.albumURI, { name: '原盤', tracks: [uri('track', 2)] }]])), undefined);
});
test('adopt keeps own artist URIs at matching positions and falls back for reordered shared artists', () => {
  const own = record(1, { artists: [{ uri: 'a', name: 'A' }, { uri: 'b', name: 'B' }] });
  const original = record(2, { name: '原曲', artists: [{ uri: 'x', name: '歌手甲' }, { uri: 'y', name: '歌手乙' }] });
  assert.deepEqual(selection.adopt(own, original).artists.map(a => a.uri), ['a', 'b']);
  original.artists[0].uri = 'b'; assert.equal(selection.adopt(own, original).artists[0].uri, 'b');
});
test('common canonical indirect path requires resolved non-CJK target and exact backlink', () => {
  const own = record(1, { canonicalURI: uri('track', 8), albumURI: uri('album', 1) });
  const sibling = record(2, { canonicalURI: uri('track', 3) }), linked = record(3, { albumURI: uri('album', 2) });
  const candidate = record(4, { name: '原曲', canonicalURI: own.canonicalURI });
  const all = new Map([[own.uri, own], [sibling.uri, sibling], [linked.uri, linked], [candidate.uri, candidate], [own.albumURI, { tracks: [sibling.uri] }], [linked.albumURI, { tracks: [candidate.uri] }]]);
  assert.equal(selection.indirectOriginal(own.uri, own, all, new Map()), undefined);
  all.set(own.canonicalURI, record(8)); assert.equal(selection.indirectOriginal(own.uri, own, all, new Map()), candidate);
  candidate.canonicalURI = own.uri; assert.equal(selection.indirectOriginal(own.uri, own, all, new Map()), undefined);
});
test('reverse candidate remains restricted to source URI and refuses competing matches', () => {
  const own = record(1), a = record(2, { name: '原曲', canonicalURI: own.uri, albumURI: uri('album', 1) }), b = record(3, { name: '原曲別', canonicalURI: own.uri, albumURI: uri('album', 2) });
  const all = new Map([[a.uri, a], [b.uri, b], [a.albumURI, { tracks: [a.uri] }], [b.albumURI, { tracks: [b.uri] }]]);
  assert.equal(selection.indirectOriginal(own.uri, own, all, new Map([[own.uri, new Set([a.uri])]])), a);
  assert.equal(selection.indirectOriginal(own.uri, own, all, new Map([[own.uri, new Set([a.uri, b.uri])]])), undefined);
});
test('sibling performance language gate permits missing/ja/und/zxx but excludes en', () => {
  for (const languages of [[], ['ja'], ['und'], ['zxx'], ['en', 'ja']]) assert.equal(selection.allowsSibling({ performanceLanguages: languages }), true);
  assert.equal(selection.allowsSibling({ performanceLanguages: ['en'] }), false);
});
test('zh artist CJK wins, ja permits hiragana/kanji and rejects pure katakana', async () => {
  const artists = [1, 2, 3, 4].map(n => uri('artist', n));
  const { resolver, calls, map } = fixture([record(1, { name: '原曲', artists: artists.map(uri => ({ uri, name: 'Latin' })) })]);
  for (let i = 0; i < 4; i++) map.set(artists[i], { name: i === 0 ? '中文名' : i === 3 ? '' : 'Latin' });
  map.set(`${artists[1]}:ja`, { name: 'ひらがな' }); map.set(`${artists[2]}:ja`, { name: 'カタカナ' });
  const result = await resolver.resolve([uri('track', 1)]);
  assert.equal(result.artistNames.get(artists[0]), '中文名'); assert.equal(result.artistNames.get(artists[1]), 'ひらがな');
  assert.equal(result.artistNames.get(artists[2]), 'Latin');
  assert.deepEqual(calls.filter(c => c.language === 'ja')[0].entities.map(e => e.uri), [artists[1], artists[2]]);
  assert.equal(japaneseNameCandidate('カタカナ'), false); assert.equal(hasCJK('カタカナ'), true);
});
test('empty and completed absence produce no failure or negative cache', async () => {
  const { resolver } = fixture([record(1, { name: '' })]);
  const result = await resolver.resolve([uri('track', 1), uri('track', 2)]);
  assert.equal(result.complete, true); assert.equal(result.tracks.size, 0); assert.equal(resolver.cache.has(uri('track', 2)), false);
});
test('missing or duplicate entry retries only affected URI once', async () => {
  const ids = [1, 2, 3].map(n => uri('track', n));
  const { resolver, calls } = fixture([], { request: async (entities, language, signal, map, calls) => {
    const value = trackValue({ name: '曲' });
    return calls.length === 1 ? response([{ kind: 10, uri: ids[0], value }, { kind: 10, uri: ids[1], value }, { kind: 10, uri: ids[1], value }]) : response(entities.map(e => ({ kind: 10, uri: e.uri, value })));
  } });
  const result = await resolver.resolve(ids);
  assert.equal(result.complete, true); assert.deepEqual(calls[1].entities.map(e => e.uri), ids.slice(1)); assert.equal(calls.length, 2);
});
test('whole failure splits 256 to 64 then only failed 64 to 16 with concurrency at most three', async () => {
  let active = 0, max = 0;
  const ids = Array.from({ length: 256 }, (_, i) => uri('track', i + 1));
  const { resolver, calls } = fixture([], { request: async entities => {
    active++; max = Math.max(max, active); await new Promise(resolve => setTimeout(resolve, 1)); active--;
    if (entities.length === 256 || entities.length === 64 && entities[0].uri === ids[0]) throw Object.assign(new Error('HTTP 500'), { status: 500 });
    return response(entities.map(e => ({ kind: 10, uri: e.uri, value: trackValue({ name: '曲' }) })));
  } });
  const result = await resolver.resolve(ids);
  assert.equal(result.complete, true); assert.equal(result.tracks.size, 256); assert.equal(max, 3);
  assert.deepEqual(calls.map(c => c.entities.length), [256, 64, 64, 64, 64, 16, 16, 16, 16]);
});
test('all failed 64 subbatches stop without expanding to 16', async () => {
  const { resolver, calls } = fixture([], { request: async () => { throw Object.assign(new Error('HTTP 500'), { status: 500 }); } });
  const result = await resolver.resolve(Array.from({ length: 256 }, (_, i) => uri('track', i + 1)));
  assert.equal(result.complete, false); assert.deepEqual(calls.map(c => c.entities.length), [256, 64, 64, 64, 64]);
});
test('failed entry retry never starts a split tree and retains other valid tracks', async () => {
  const ids = [1, 2].map(n => uri('track', n));
  const { resolver, calls } = fixture([], { request: async (entities, lang, signal, map, calls) => {
    if (calls.length > 1) throw Object.assign(new Error('HTTP 500'), { status: 500 });
    return response([{ uri: ids[0], kind: 10, value: trackValue({ name: '曲' }) }]);
  } });
  const result = await resolver.resolve(ids);
  assert.equal(result.complete, false); assert.equal(result.tracks.size, 1); assert.equal(calls.length, 2);
});
test('429, auth rejection, cancellation and offline stop later queued lookups without retry', async () => {
  for (const error of [Object.assign(new Error('429'), { status: 429 }), Object.assign(new Error('401'), { status: 401 }), Object.assign(new Error('offline'), { offline: true }), Object.assign(new Error('cancel'), { name: 'AbortError' })]) {
    const { resolver, calls } = fixture([], { request: async () => { throw error; } });
    const result = await resolver.resolve(Array.from({ length: 300 }, (_, i) => uri('track', i + 1)));
    assert.equal(result.complete, false); assert.equal(calls.length, 1);
  }
});
test('already aborted request performs no transport and strict final failure blocks later batches', async () => {
  const controller = new AbortController(); controller.abort();
  const first = fixture(); assert.equal((await first.resolver.resolve([uri('track', 1)], { signal: controller.signal })).complete, false); assert.equal(first.calls.length, 0);
  const { resolver, calls } = fixture([], { isStrict: () => true, request: async () => response([]) });
  assert.equal((await resolver.resolve(Array.from({ length: 300 }, (_, i) => uri('track', i + 1)))).complete, false); assert.equal(calls.length, 2);
});
test('client metadata is merged with original-language data without mutating caller input', async () => {
  const own = record(1, { name: 'Romanized' }), { resolver } = fixture([record(1, { name: '原曲' })]);
  resolver.ingest(decodeMetadata(response([{ kind: 10, uri: own.uri, value: trackValue(own) }])));
  const result = await resolver.resolve([own.uri]); assert.equal(result.tracks.get(own.uri).name, '原曲'); assert.equal(resolver.clients.get(own.uri).name, 'Romanized');
});

test('concurrent resolutions share global three-request limit', async () => {
  let active = 0, max = 0;
  const { resolver } = fixture([], { request: async entities => {
    active++; max = Math.max(max, active); await new Promise(resolve => setTimeout(resolve, 1)); active--;
    return response(entities.map(e => ({ uri: e.uri, kind: 10, value: trackValue({ name: '曲' }) })));
  } });
  const results = await Promise.all(Array.from({ length: 14 }, (_, i) => resolver.resolve([uri('track', i + 1)])));
  assert.equal(results.every(result => result.complete), true); assert.equal(max, 3); assert.equal(resolver.stats().active, 0); assert.equal(resolver.stats().queued, 0);
});
test('clearing resolver during an active lookup invalidates its later delivery and cache', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { resolver } = fixture([], { request: async entities => { await gate; return response(entities.map(e => ({ uri: e.uri, kind: 10, value: trackValue({ name: '曲' }) }))); } });
  const pending = resolver.resolve([uri('track', 1)]);
  await Promise.resolve(); resolver.clear(); release();
  await assert.rejects(pending, { name: 'AbortError' }); assert.equal(resolver.stats().cachedEntities, 0);
});

test('HTTP-level completed absences do not retry or write negative cache', async () => {
  for (const status of [204, 404, 410]) {
    const { resolver, calls } = fixture([], { request: async () => { throw Object.assign(new Error('Absent'), { status }); } });
    const result = await resolver.resolve([uri('track', 1)]);
    assert.equal(result.complete, true); assert.equal(result.tracks.size, 0); assert.equal(calls.length, 1); assert.equal(resolver.cache.size, 0);
  }
});

test('same ISRC canonical remains valid across duration and release-position changes', async () => {
  const original = record(2, { name: '原曲', duration: 100124, number: 17, disc: 3 });
  const { resolver } = fixture([record(1, { canonicalURI: original.uri }), original]);
  assert.equal((await resolver.resolve([uri('track', 1)])).tracks.get(uri('track', 1)).name, original.name);
});
test('direct canonical with both different ISRC and duration is rejected without a verified fallback', async () => {
  const original = record(2, { name: '別録音', isrc: 'OTHER', duration: 100124 });
  const { resolver } = fixture([record(1, { canonicalURI: original.uri }), original]);
  const result = await resolver.resolve([uri('track', 1)]);
  assert.equal(result.tracks.get(uri('track', 1)).name, 'Romanized'); assert.equal(result.complete, true);
});
test('a contradicted direct canonical yields to the existing exact album recording match', async () => {
  const own = record(1, { canonicalURI: uri('track', 2), albumURI: uri('album', 1) });
  const wrong = record(2, { name: '別録音の伴奏', isrc: 'OTHER', duration: 104000 });
  const correct = record(3, { name: '原曲', albumURI: uri('album', 2) });
  const { resolver } = fixture([own, wrong, correct,
    { uri: own.albumURI, name: 'Album', originalURI: correct.albumURI, tracks: [own.uri] },
    { uri: correct.albumURI, name: '原盤', tracks: [correct.uri] }]);
  const result = await resolver.resolve([own.uri]);
  assert.equal(result.tracks.get(own.uri).name, correct.name); assert.equal(result.tracks.get(own.uri).albumURI, correct.albumURI);
});
test('rejected CJK canonical permits an already bounded exact shared-canonical candidate', () => {
  const own = record(1, { canonicalURI: uri('track', 8), albumURI: uri('album', 1) });
  const wrong = record(8, { name: '別録音', isrc: 'OTHER', duration: 110000 });
  const sibling = record(2, { canonicalURI: uri('track', 3) }), linked = record(3, { albumURI: uri('album', 2) });
  const candidate = record(4, { name: '原曲', canonicalURI: own.canonicalURI });
  const all = new Map([[own.uri, own], [wrong.uri, wrong], [sibling.uri, sibling], [linked.uri, linked], [candidate.uri, candidate], [own.albumURI, { tracks: [sibling.uri] }], [linked.albumURI, { tracks: [candidate.uri] }]]);
  assert.equal(selection.selectedOriginal(own.uri, own, all, new Map()), candidate);
});
test('independent artist identity overrides positional naming on a valid canonical recording', async () => {
  const a = uri('artist', 1), b = uri('artist', 2);
  const own = record(1, { canonicalURI: uri('track', 2), artists: [{ uri: a, name: 'Latin Actor' }] });
  const original = record(2, { name: '原曲', artists: [{ uri: b, name: '別歌手' }] });
  const { resolver, map } = fixture([own, original]);
  map.set(a, { name: '本来の歌手' }); map.set(b, { name: '別歌手' });
  const result = await resolver.resolve([own.uri]);
  assert.equal(result.tracks.get(own.uri).artists[0].uri, a);
  assert.equal(result.tracks.get(own.uri).artists[0].name, '本来の歌手');
  assert.equal(result.artistNames.get(a), '本来の歌手');
  assert.equal(result.sourceTracks.get(own.uri).artists[0].name, 'Latin Actor');
});
test('Latin artist survives a rejected katakana fallback when the recording duration differs', async () => {
  const a = uri('artist', 1), b = uri('artist', 2);
  const own = record(1, { canonicalURI: uri('track', 2), artists: [{ uri: a, name: 'Latin Singer' }] });
  const { resolver, map, calls } = fixture([own, record(2, { name: '原曲', duration: 100124, artists: [{ uri: b, name: '別歌手' }] })]);
  map.set(a, { name: 'Latin Singer' }); map.set(`${a}:ja`, { name: 'シンガー' });
  const first = await resolver.resolve([own.uri]);
  assert.equal(first.tracks.get(own.uri).artists[0].name, 'Latin Singer');
  assert.equal(first.artistNames.get(a), 'Latin Singer');
  const count = calls.length;
  const next = await resolver.resolve([own.uri]);
  assert.equal(next.artistNames.get(a), 'Latin Singer'); assert.equal(calls.length, count);
});
test('persistent aliases have no authority until independently verified in the new process', async () => {
  const a = uri('artist', 1);
  const { resolver, map, calls } = fixture([record(1, { name: '原曲', artists: [{ uri: a, name: 'Latin Actor' }] })], { store: { getArtistNames: () => new Map([[a, '誤った歌手']]) } });
  map.set(a, { name: '正しい歌手' });
  const result = await resolver.resolve([uri('track', 1)]);
  assert.equal(result.artistNames.get(a), '正しい歌手'); assert.equal(result.tracks.get(uri('track', 1)).artists[0].name, '正しい歌手');
  assert.equal(calls.some(c => c.entities.some(e => e.uri === a && e.kinds[0] === 8)), true);
});
test('valid empty artist identity suppresses positional learning without replacing the existing name', async () => {
  const a = uri('artist', 1), b = uri('artist', 2);
  const own = record(1, { canonicalURI: uri('track', 2), artists: [{ uri: a, name: 'Original Latin' }] });
  const { resolver, map } = fixture([own, record(2, { name: '原曲', artists: [{ uri: b, name: '別歌手' }] })]);
  map.set(a, { name: '' });
  const result = await resolver.resolve([own.uri]);
  assert.equal(result.artistNames.has(a), false); assert.equal(result.tracks.get(own.uri).artists[0].name, 'Original Latin');
});

test('a failed Japanese artist lookup is retried later while the verified zh identity remains protected', async () => {
  const a = uri('artist', 1); let failJapanese = true;
  const { resolver, calls } = fixture([], { request: async (entities, language) => {
    if (language === 'ja' && failJapanese) throw Object.assign(new Error('HTTP 500'), { status: 500 });
    return response(entities.map(e => ({ uri: e.uri, kind: e.kinds[0], value: e.kinds[0] === 10 ? trackValue(record(1, { name: '原曲', artists: [{ uri: a, name: 'Latin Artist' }] })) : ld(2, language === 'ja' ? '本来の歌手' : 'Latin Artist') })));
  } });
  const first = await resolver.resolve([uri('track', 1)]);
  assert.equal(first.complete, false); assert.equal(first.artistNames.get(a), 'Latin Artist');
  assert.equal(resolver.artistAuthorities.get(a).complete, false);
  const prior = calls.length; failJapanese = false;
  const next = await resolver.resolve([uri('track', 1)]);
  assert.equal(next.complete, true); assert.equal(next.artistNames.get(a), '本来の歌手');
  assert.equal(calls.slice(prior).some(c => c.language === 'ja'), true);
});
test('new process rechecks independently cached Latin identity instead of trusting persistent aliases', async () => {
  const a = uri('artist', 1);
  const { resolver, map, calls } = fixture([record(1, { name: '原曲', artists: [{ uri: a, name: 'Latin Artist' }] })], { store: { getArtistNames: () => new Map([[a, '別歌手']]) } });
  map.set(a, { name: 'Latin Artist' }); map.set(`${a}:ja`, { name: 'シンガー' });
  const result = await resolver.resolve([uri('track', 1)]);
  assert.equal(result.artistNames.get(a), 'Latin Artist'); assert.equal(result.tracks.get(uri('track', 1)).artists[0].name, 'Latin Artist');
  assert.equal(calls.filter(c => c.entities.some(e => e.uri === a)).length, 2);
});

test('observed URIs record requested client entities without adding lookup dependencies', async () => {
  const own = record(1, { canonicalURI: uri('track', 2) });
  const { resolver } = fixture([own, record(2, { name: '原曲' })]);
  await resolver.resolve([own.uri, own.uri, 'spotify:local:ignored']);
  assert.deepEqual([...resolver.observedUris], [own.uri]); assert.equal(resolver.stats().viewedEntities, 1);
  assert.equal(resolver.cache.has(uri('track', 2)), true);
  const saved = new Set(resolver.observedUris); resolver.clear();
  assert.equal(resolver.observedUris.size, 0); assert.equal(resolver.stats().viewedEntities, 0); assert.deepEqual([...saved], [own.uri]);
});

test('exact recording and safe artist positions permit CJK aliases over a Latin independent name', async () => {
  const a = uri('artist', 1), b = uri('artist', 2);
  const own = record(1, { canonicalURI: uri('track', 2), artists: [{ uri: a, name: 'Latin Singer' }] });
  const original = record(2, { name: '原曲', artists: [{ uri: b, name: '原文の歌手' }] });
  const { resolver, map } = fixture([own, original]);
  map.set(a, { name: 'Latin Singer' }); map.set(`${a}:ja`, { name: 'シンガー' });
  const result = await resolver.resolve([own.uri]);
  assert.equal(result.tracks.get(own.uri).artists[0].name, '原文の歌手'); assert.equal(result.artistNames.get(a), '原文の歌手');
  assert.equal(resolver.artistAuthorities.get(a).name, 'Latin Singer');
  assert.equal(resolver.verifiedAliases.get(a).isrc, own.isrc); assert.equal(resolver.verifiedAliases.get(a).duration, own.duration);
  const artistPage = await resolver.resolve([a]);
  assert.equal(artistPage.artistNames.get(a), '原文の歌手');
  resolver.clear(); assert.equal(resolver.verifiedAliases.size, 0);
});
test('different ISRC with matching duration may localize a title but cannot teach positional artist aliases', async () => {
  const a = uri('artist', 1), b = uri('artist', 2);
  const own = record(1, { canonicalURI: uri('track', 2), artists: [{ uri: a, name: 'Latin Singer' }] });
  const { resolver, map } = fixture([own, record(2, { name: '原曲', isrc: 'DIFFERENT', artists: [{ uri: b, name: '別の歌手' }] })]);
  map.set(a, { name: 'Latin Singer' }); map.set(`${a}:ja`, { name: 'シンガー' });
  const result = await resolver.resolve([own.uri]);
  assert.equal(result.tracks.get(own.uri).name, '原曲'); assert.equal(result.tracks.get(own.uri).artists[0].name, 'Latin Singer'); assert.equal(resolver.verifiedAliases.has(a), false);
});
test('same recording with reordered shared artists cannot produce positional aliases', () => {
  const a = uri('artist', 1), b = uri('artist', 2), c = uri('artist', 3);
  const own = record(1, { artists: [{ uri: a, name: 'A' }, { uri: b, name: 'B' }] });
  const original = record(2, { artists: [{ uri: c, name: '原文A' }, { uri: a, name: '原文B' }] });
  const { resolver } = fixture(); resolver.learnVerifiedAliases(own, original);
  assert.equal(resolver.verifiedAliases.size, 0);
});
test('conflicting verified aliases are suppressed instead of last-write-wins', () => {
  const a = uri('artist', 1), own = record(1, { artists: [{ uri: a, name: 'Latin' }] });
  const first = record(2, { artists: [{ uri: uri('artist', 2), name: '原文A' }] });
  const second = record(3, { artists: [{ uri: uri('artist', 3), name: '原文B' }] });
  const { resolver } = fixture(); resolver.artistAuthorities.set(a, { name: 'Latin', complete: true });
  resolver.learnVerifiedAliases(own, first); resolver.learnVerifiedAliases(own, second);
  const names = new Map(); resolver.applyArtistAuthorities(names);
  assert.equal(names.get(a), 'Latin'); assert.equal(resolver.verifiedAliases.get(a).conflict, true);
});
test('empty and CJK independent identities outrank even previously verified aliases', async () => {
  const a = uri('artist', 1), own = record(1, { canonicalURI: uri('track', 2), artists: [{ uri: a, name: 'Latin' }] });
  const { resolver } = fixture([own, record(2, { name: '原曲', artists: [{ uri: uri('artist', 2), name: '位置からの原文' }] })]);
  resolver.verifiedAliases.set(a, { name: '以前の原文', isrc: own.isrc, duration: own.duration });
  resolver.artistAuthorities.set(a, { name: '', complete: true });
  const empty = await resolver.resolve([own.uri]); assert.equal(empty.artistNames.has(a), false); assert.equal(empty.tracks.get(own.uri).artists[0].name, 'Latin');
  resolver.artistAuthorities.set(a, { name: '独立の原文', complete: true });
  const named = await resolver.resolve([own.uri]); assert.equal(named.artistNames.get(a), '独立の原文'); assert.equal(named.tracks.get(own.uri).artists[0].name, '独立の原文');
});
