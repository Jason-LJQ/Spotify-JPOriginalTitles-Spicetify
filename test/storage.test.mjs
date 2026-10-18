import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage.mjs';

const uri = 'spotify:track:synthetic';
function adapter() {
  const disk = { artist_names: [], previous_fields: [], lookup_cache: [] };
  return {
    fail: false,
    async load() { return structuredClone(disk); },
    async write(artists, previous, lookup = new Map()) {
      if (this.fail) throw new Error('Disk failure');
      const a = new Map(disk.artist_names.map(row => [row.key, row]));
      const p = new Map(disk.previous_fields.map(row => [row.key, row]));
      for (const [key, value] of artists) a.set(key, { key, value });
      for (const [key, value] of previous) value ? p.set(key, { key, ...value }) : p.delete(key);
      disk.artist_names = [...a.values()]; disk.previous_fields = [...p.values()];
      const l = new Map(disk.lookup_cache.map(row => [row.key, row]));
      for (const [key, value] of lookup) l.set(key, { key, ...value });
      disk.lookup_cache = [...l.values()];
    },
    async clear() { disk.artist_names = []; disk.previous_fields = []; disk.lookup_cache = []; }
  };
}

test('commits previous values with source priority and preserves the first raw value across passes', async () => {
  const persistence = adapter();
  const store = await new Store({ adapter: persistence }).open();
  await store.commit({ previous: [{ uri, field: 'title', value: 'Raw', now: 'Original', priority: 3 }] });
  await store.commit({ previous: [{ uri, field: 'title', value: 'Lower', now: 'Other', priority: 1 }] });
  assert.equal(store.getPrevious(uri).title, 'Raw');
  await store.commit({ previous: [{ uri, field: 'title', value: 'Original', now: 'Revised', priority: 3 }] });
  assert.equal(store.getPrevious(uri).title, 'Raw');
  const reopened = await new Store({ adapter: persistence }).open();
  assert.equal(reopened.getPrevious(uri).title, 'Raw');
});

test('suppresses conflicts in one delivery and clears explicit empty fields', async () => {
  const store = await new Store({ adapter: adapter() }).open();
  await store.commit({ previous: [{ uri, field: 'title', value: 'One', now: 'New', priority: 3 }, { uri, field: 'title', value: 'Two', now: 'New', priority: 3 }] });
  assert.deepEqual(store.getPrevious(uri), {});
  await store.commit({ previous: [{ uri, field: 'title', value: 'Raw', now: 'New', priority: 3 }] });
  await store.commit({ previous: [{ uri, field: 'title', value: 'Raw', now: '', priority: 3 }] });
  assert.deepEqual(store.getPrevious(uri), {});
});

test('storage failure keeps both in-memory tables unchanged and rejects delivery', async () => {
  const persistence = adapter();
  const store = await new Store({ adapter: persistence }).open();
  persistence.fail = true;
  await assert.rejects(store.commit({ artistNames: new Map([['spotify:artist:a', 'Artist']]), previous: [{ uri, field: 'title', value: 'Raw', priority: 3 }] }), { code: 'JPT_STORAGE' });
  assert.equal(store.stats().artistNames, 0);
  assert.equal(store.stats().previousFields, 0);
});

test('reset is local, persistent and independent of settings', async () => {
  const persistence = adapter();
  const store = await new Store({ adapter: persistence }).open();
  await store.commit({ artistNames: new Map([['spotify:artist:a', 'Artist']]) });
  await store.reset();
  assert.equal((await new Store({ adapter: persistence }).open()).stats().artistNames, 0);
});

test('an explicit high-priority blank cannot be repopulated by a later lower-priority delivery', async () => {
  const persistence = adapter();
  let store = await new Store({ adapter: persistence }).open();
  await store.commit({ previous: [{ uri, field: 'title', value: 'Raw', now: '', priority: 3 }] });
  store = await new Store({ adapter: persistence }).open();
  await store.commit({ previous: [{ uri, field: 'title', value: 'Search raw', now: 'Enhanced', priority: 1 }] });
  assert.deepEqual(store.getPrevious(uri), {});
  assert.equal(store.stats().previousFields, 0);
  assert.equal(store.stats().suppressedFields, 1);
  await store.commit({ previous: [{ uri, field: 'title', value: 'New raw', now: 'New enhanced', priority: 3 }] });
  assert.equal(store.getPrevious(uri).title, 'New raw');
});

test('high-priority conflicts retain suppression across later track responses', async () => {
  const store = await new Store({ adapter: adapter() }).open();
  await store.commit({ previous: [{ uri, field: 'album', value: 'One', now: 'New', priority: 3 },
    { uri, field: 'album', value: 'Two', now: 'New', priority: 3 }] });
  await store.commit({ previous: [{ uri, field: 'album', value: 'Track raw', now: 'New', priority: 2 }] });
  assert.deepEqual(store.getPrevious(uri), {});
});

test('delivery validation sees projected values and rejects before either table is written', async () => {
  const persistence = adapter();
  const store = await new Store({ adapter: persistence }).open();
  const error = Object.assign(new Error('Ambiguous encoding'), { code: 'JPT_PARSE_FAILED' });
  await assert.rejects(store.commit({ artistNames: new Map([['spotify:artist:a', 'Artist']]),
    previous: [{ uri, field: 'title', value: 'Raw', now: 'Enhanced', priority: 3 }],
    prepare({ getPrevious }) { assert.deepEqual(getPrevious(uri), { title: 'Raw' }); throw error; }
  }), e => e === error);
  assert.deepEqual(store.getPrevious(uri), {});
  const reopened = await new Store({ adapter: persistence }).open();
  assert.deepEqual(reopened.getPrevious(uri), {});
  assert.equal(reopened.stats().artistNames, 0);
});

test('validation still runs for unchanged transactions and observes serialized priority', async () => {
  const store = await new Store({ adapter: adapter() }).open();
  let calls = 0;
  const first = store.commit({ previous: [{ uri, field: 'title', value: 'Identity', now: 'Enhanced', priority: 3 }] });
  const second = store.commit({ previous: [{ uri, field: 'title', value: 'Search', now: 'Enhanced', priority: 1 }],
    prepare({ getPrevious }) { calls++; assert.equal(getPrevious(uri).title, 'Identity'); }
  });
  await Promise.all([first, second]);
  assert.equal(calls, 1);
});

test('lookup evidence is atomic with previous fields and survives reopening in its own scope', async () => {
  const persistence = adapter();
  let store = await new Store({ adapter: persistence }).open();
  const lookup = { scope: 'one', entities: new Map([[uri, { name: 'Original' }]]), authorities: new Map(), aliases: new Map() };
  await assert.rejects(store.commit({ lookup, previous: [{ uri, field: 'title', value: 'Raw', now: 'Original' }], prepare() { throw new Error('Invalid delivery'); } }));
  assert.equal(store.getLookup('one').entities.size, 0);
  persistence.fail = true;
  await assert.rejects(store.commit({ lookup }), { code: 'JPT_STORAGE' });
  persistence.fail = false;
  await store.commit({ lookup, previous: [{ uri, field: 'title', value: 'Raw', now: 'Original' }] });
  store = await new Store({ adapter: persistence }).open();
  assert.equal(store.getLookup('one').entities.get(uri).name, 'Original');
  assert.equal(store.getLookup('two').entities.size, 0);
  assert.equal(store.getPrevious(uri).title, 'Raw');
  await store.reset();
  store = await new Store({ adapter: persistence }).open();
  assert.equal(store.getLookup('one').entities.size, 0);
  assert.deepEqual(store.getPrevious(uri), {});
});
