import test from 'node:test';
import assert from 'node:assert/strict';
import { Resolver } from '../src/resolver.mjs';
import { Store } from '../src/storage.mjs';
import { createTransformer } from '../src/transform.mjs';
import { concat, ld, vi, uriToGID } from '../src/wire.mjs';

const uri = (type, n) => `spotify:${type}:${String(n).padStart(22, '0')}`;
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const own = { uri: uri('track', 1), name: 'Roman', canonicalURI: uri('track', 2), albumURI: uri('album', 1), artists: [{ uri: uri('artist', 1), name: 'Latin' }] };
const original = { uri: uri('track', 2), name: '原曲', albumURI: uri('album', 2), artists: [{ uri: uri('artist', 2), name: '歌手' }] };

function response(entities, records, language) {
  const groups = new Map();
  for (const { uri: id, kinds: [kind] } of entities) {
    const item = records.get(`${id}:${language}`) ?? records.get(id);
    let value;
    if (item && kind === 10) value = concat(ld(2, item.name), vi(5, 1), vi(6, 1), vi(7, 100000),
      ld(10, concat(ld(1, 'isrc'), ld(2, 'JPTEST1234567'))),
      item.canonicalURI ? ld(36, item.canonicalURI) : null,
      item.albumURI ? ld(3, concat(ld(1, uriToGID(item.albumURI)), ld(2, 'Album'))) : null,
      ...(item.artists ?? []).map(a => ld(4, concat(ld(1, uriToGID(a.uri)), ld(2, a.name)))));
    if (item && kind === 9) value = concat(ld(2, item.name), item.originalURI ? ld(35, item.originalURI) : null,
      ld(11, concat(...(item.tracks ?? []).map(t => ld(3, ld(1, uriToGID(t)))))));
    if (item && kind === 8) value = ld(2, item.name);
    if (!groups.has(kind)) groups.set(kind, []);
    groups.get(kind).push(ld(3, concat(ld(1, vi(1, item ? 200 : 404)), ld(2, id), value ? ld(3, ld(2, value)) : null)));
  }
  return concat([...groups].map(([kind, entries]) => ld(2, concat(vi(2, kind), ...entries))));
}
function persistence() {
  const tables = { artist_names: new Map(), previous_fields: new Map(), lookup_cache: new Map() };
  return {
    async load() { return Object.fromEntries(Object.entries(tables).map(([key, rows]) => [key, structuredClone([...rows.values()])])); },
    async write(artists, previous, lookup = new Map()) {
      for (const [key, value] of artists) tables.artist_names.set(key, { key, value });
      for (const [key, value] of previous) value ? tables.previous_fields.set(key, { key, ...value }) : tables.previous_fields.delete(key);
      for (const [key, value] of lookup) tables.lookup_cache.set(key, structuredClone({ key, ...value }));
    },
    async clear() { for (const rows of Object.values(tables)) rows.clear(); }
  };
}
function fixture(records = [], options = {}) {
  const map = new Map(records.map(item => [item.uri, item]));
  const calls = [];
  const resolver = new Resolver({ ...options, request: async (entities, language, signal) => {
    calls.push({ entities, language, signal });
    await options.gate?.(signal);
    return response(entities, map, language);
  } });
  return { resolver, calls, map };
}

test('simultaneous identical and overlapping lookups request each entity once', async () => {
  const gate = deferred();
  const records = [1, 2, 3].map(n => ({ uri: uri('track', n), name: '原曲' }));
  const { resolver, calls } = fixture(records, { gate: () => gate.promise });
  const pending = Array.from({ length: 8 }, () => resolver.resolve([records[0].uri, records[1].uri]));
  pending.push(resolver.resolve([records[1].uri, records[2].uri]));
  await tick();
  assert.equal(calls.length, 2);
  assert.equal(calls.flatMap(call => call.entities).filter(item => item.uri === records[1].uri).length, 1);
  gate.resolve();
  assert.ok((await Promise.all(pending)).every(result => result.complete));
  assert.equal(resolver.inFlight.size, 0);
});

test('one cancelled consumer leaves the shared request available to another', async () => {
  const gate = deferred();
  const { resolver, calls } = fixture([{ uri: own.uri, name: '原曲' }], { gate: () => gate.promise });
  const controller = new AbortController();
  const cancelled = resolver.resolve([own.uri], { signal: controller.signal });
  const retained = resolver.resolve([own.uri]);
  await tick(); controller.abort();
  assert.equal((await cancelled).complete, false);
  assert.equal(calls[0].signal.aborted, false);
  gate.resolve();
  assert.equal((await retained).tracks.get(own.uri).name, '原曲');
  assert.equal(calls.length, 1);
});

test('cancelling every consumer aborts transport and prevents stale cache publication', async () => {
  const gate = deferred();
  const { resolver, calls } = fixture([{ uri: own.uri, name: '原曲' }], { gate: () => gate.promise });
  const controllers = [new AbortController(), new AbortController()];
  const pending = controllers.map(controller => resolver.resolve([own.uri], { signal: controller.signal }));
  await tick(); controllers.forEach(controller => controller.abort());
  await Promise.all(pending);
  assert.equal(calls[0].signal.aborted, true);
  gate.resolve(); await tick();
  assert.equal(resolver.cache.size, 0);
  assert.equal(resolver.inFlight.size, 0);
});

test('overlapping queued consumers retain the global limit and share the queued entity', async () => {
  const gate = deferred();
  const records = [1, 2, 3, 4].map(n => ({ uri: uri('track', n), name: '原曲' }));
  const { resolver, calls } = fixture(records, { gate: () => gate.promise });
  const pending = records.map(item => resolver.resolve([item.uri]));
  pending.push(resolver.resolve([records[3].uri]));
  await tick(); assert.equal(calls.length, 3); assert.equal(resolver.stats().queued, 1);
  gate.resolve(); await Promise.all(pending);
  assert.equal(calls.length, 4); assert.equal(resolver.stats().maxActive, 3);
});

test('verified direct canonical skips unrelated album lookups while explicit album views still resolve', async () => {
  const { resolver, calls } = fixture([{ ...own, artists: [] }, { ...original, artists: [] }]);
  assert.equal((await resolver.resolve([own.uri])).tracks.get(own.uri).name, '原曲');
  assert.equal(calls.length, 2);
  assert.equal(calls.flatMap(call => call.entities).some(item => item.kinds[0] === 9), false);
  await resolver.resolve([own.uri]); assert.equal(calls.length, 2);
  await resolver.resolve([own.albumURI]); assert.equal(calls.at(-1).entities[0].kinds[0], 9);
});

test('a shared terminal rejection stops later queued batches of the affected response', async () => {
  let requests = 0;
  const resolver = new Resolver({ request: async () => { requests++; throw Object.assign(new Error('Rate limited'), { status: 429 }); } });
  const context = { failures: [], stopped: undefined, generation: 0 };
  await resolver.query(Array.from({ length: 1024 }, (_, i) => uri('track', i + 1)), context);
  assert.equal(requests, 3);
  assert.ok(context.stopped);
  assert.equal(resolver.stats().queued, 0);
  assert.equal(resolver.stats().active, 0);
});

test('tracks, albums, independent artist evidence and verified aliases survive a new store and resolver', async () => {
  const adapter = persistence();
  let store = await new Store({ adapter }).open();
  const records = [own, original, { uri: own.albumURI, name: 'Album', originalURI: original.albumURI, tracks: [own.uri] },
    { uri: original.albumURI, name: '原盤', tracks: [original.uri] }, { uri: uri('artist', 1), name: 'Latin' }];
  const first = fixture(records, { store });
  const value = { items: [{ uri: own.uri, name: 'Roman' }, { uri: own.albumURI, name: 'Album' }, { uri: uri('artist', 1), name: 'Latin' }] };
  const output = await createTransformer({ resolver: first.resolver, store }).rewriteJSON(value);
  assert.deepEqual(output.items.map(item => item.name), ['原曲', '原盤', '歌手']);
  assert.ok(first.calls.length > 0);
  assert.equal(first.resolver.dirty.entities.size, 0);
  store = await new Store({ adapter }).open();
  const second = fixture([], { store });
  const reopened = await createTransformer({ resolver: second.resolver, store }).rewriteJSON(value);
  assert.deepEqual(reopened, output);
  assert.equal(second.calls.length, 0);
  assert.ok(second.resolver.verifiedAliases.get(uri('artist', 1)).isrc);
  assert.equal(store.getPrevious(own.uri).title, 'Roman');
  second.resolver.clear(); second.resolver.restore();
  await second.resolver.resolve([own.uri]); assert.equal(second.calls.length, 0);
  const otherScope = fixture(records, { store, scope: 'JP:premium' });
  await otherScope.resolver.resolve([own.uri]); assert.ok(otherScope.calls.length > 0);
  await store.reset(); second.resolver.clear();
  const cleared = fixture(records, { store });
  await cleared.resolver.resolve([own.uri]); assert.ok(cleared.calls.length > 0);
});

test('legacy artist strings do not bypass independent verification and failed lookups are not persisted', async () => {
  const store = await new Store({ adapter: persistence() }).open();
  await store.commit({ artistNames: new Map([[uri('artist', 1), 'Wrong legacy alias']]) });
  const { resolver, calls } = fixture([{ uri: uri('artist', 1), name: '正しい名前' }], { store });
  await createTransformer({ resolver, store }).rewriteJSON({ uri: uri('artist', 1), name: 'Latin' });
  assert.equal(calls.length, 1);
  assert.equal(resolver.artistAuthorities.get(uri('artist', 1)).name, '正しい名前');
  await createTransformer({ resolver, store }).rewriteJSON({ uri: uri('track', 99), name: 'Missing' });
  assert.equal(store.getLookup(resolver.scope).entities.has(uri('track', 99)), false);
});

test('an older completed commit cannot clear newer pending evidence for the same URI', () => {
  const { resolver } = fixture();
  const before = { uri: own.uri, name: 'Before' }, after = { uri: own.uri, name: 'After' };
  resolver.dirty.entities.set(own.uri, before);
  const saved = resolver.lookupChanges();
  resolver.dirty.entities.set(own.uri, after);
  resolver.didPersist(saved);
  assert.equal(resolver.dirty.entities.get(own.uri), after);
  resolver.clear(); resolver.didPersist(saved);
  assert.equal(resolver.dirty.entities.size, 0);
});
