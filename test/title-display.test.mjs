import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage.mjs';
import { createTransformer } from '../src/transform.mjs';
import { concat, ld, vi, fields, uriToGID, decodeMetadata, text } from '../src/wire.mjs';

const uri = 'spotify:track:0000000000000000000001';
const album = 'spotify:album:0000000000000000000002';
const artist = 'spotify:artist:0000000000000000000003';
const preferred = { name: '原曲', albumName: '原盤', artists: [{ uri: artist, name: '歌手' }] };
const fieldText = (bytes, number) => text(fields(bytes).find(item => item.field === number));
const response = entries => concat(...entries.map(([kind, value]) => ld(2, concat(vi(2, kind), ld(3, concat(ld(1, vi(1, 200)), ld(2, uri), ld(3, concat(ld(1, 'Test'), ld(2, value)))))))));
async function fixture() {
  const writes = [];
  const store = await new Store({ adapter: { load: async () => ({}), async write(...args) { writes.push(args); } } }).open();
  const resolver = { resolve: async () => ({ tracks: new Map([[uri, preferred]]), artistNames: new Map([[artist, '歌手']]), albums: new Map([[album, { name: '原盤' }]]) }) };
  let combined = true;
  const transformer = createTransformer({ resolver, store, combineTitles: () => combined });
  return { store, transformer, writes, toggle: value => { combined = value; } };
}

test('combined JSON uses raw old title while keeping album, artist and Credits separate', async () => {
  const { transformer, store } = await fixture();
  const input = { uri, name: 'Roman', album: { uri: album, name: 'Album' }, artists: [{ uri: artist, name: 'Artist' }], creditsTrait: { contributors: { items: [] } } };
  const output = await transformer.rewriteJSON(input);
  assert.equal(output.name, '原曲 - Roman');
  assert.equal(output.album.name, '原盤');
  assert.equal(output.artists[0].name, '歌手');
  assert.equal(store.getPrevious(uri).title, 'Roman');
  assert.equal(store.getPreviousRecord(uri, 'title').now, '原曲');
  assert.deepEqual(output.creditsTrait.contributors.items.map(item => item.name), ['Roman', 'Artist', 'Album']);
  assert.equal(input.name, 'Roman');
});

test('repeated native, JSON and player delivery plus mode toggles never accumulate suffixes', async () => {
  const f = await fixture();
  let result = await f.transformer.rewriteNative({ [uri]: { 178: { name: 'Roman' } } });
  assert.equal(result[uri][178].name, '原曲 - Roman');
  assert.deepEqual(await f.transformer.rewriteNative(result), result);
  let player = await f.transformer.rewritePlayer({ track: { uri, metadata: { title: result[uri][178].name } } });
  assert.equal(player.track.metadata.title, '原曲 - Roman');
  f.toggle(false);
  player = await f.transformer.rewritePlayer(player);
  assert.equal(player.track.metadata.title, '原曲');
  f.toggle(true);
  assert.equal((await f.transformer.rewriteJSON({ uri, name: player.track.metadata.title })).name, '原曲 - Roman');
  assert.equal(f.store.getPrevious(uri).title, 'Roman');
});

test('all HTTP track title traits use the same highest-priority old name', async () => {
  const f = await fixture();
  const input = response([[10, concat(ld(1, uriToGID(uri)), ld(2, 'Track Roman'))], [178, ld(2, 'Identity Roman')], [128, ld(1, 'Name Roman')], [97, concat(ld(2, 'Card Roman'), ld(6, 'Card Roman'))], [186, new Uint8Array()]]);
  const output = await f.transformer.rewriteMetadata(input);
  const entries = decodeMetadata(output).entries;
  for (const item of entries.filter(item => item.kind !== 186)) assert.equal(fieldText(item.value, item.kind === 128 ? 1 : 2), '原曲 - Identity Roman');
  assert.equal(fieldText(entries.find(item => item.kind === 97).value, 6), '原曲 - Identity Roman');
  assert.equal(fieldText(fields(entries.find(item => item.kind === 186).value)[0].data, 1), 'Identity Roman');
  assert.deepEqual(await f.transformer.rewriteMetadata(output), output);
  assert.equal(f.store.getPrevious(uri).title, 'Identity Roman');
  f.toggle(false);
  for (const item of decodeMetadata(await f.transformer.rewriteMetadata(output)).entries.filter(item => item.kind !== 186)) assert.equal(fieldText(item.value, item.kind === 128 ? 1 : 2), '原曲');
});

test('native raw Any and repeated SimpleCard name/title are formatted once', async () => {
  const f = await fixture();
  const input = { extensionResult: [{ entityUri: uri, extensionKind: 128, status: 1, extensionData: { typeUrl: 'NameTrait', value: ld(1, 'Roman') } }], [uri]: { 97: { name: 'Roman', title: 'Roman' } } };
  const output = await f.transformer.rewriteNative(input);
  assert.equal(fieldText(output.extensionResult[0].extensionData.value, 1), '原曲 - Roman');
  assert.equal(output[uri][97].name, '原曲 - Roman');
  assert.equal(output[uri][97].title, '原曲 - Roman');
  assert.deepEqual(await f.transformer.rewriteNative(output), output);
});

test('unchanged, missing, local and conflicting titles never gain a suffix', async () => {
  const f = await fixture();
  assert.equal((await f.transformer.rewriteJSON({ uri, name: '原曲' })).name, '原曲');
  assert.equal((await f.transformer.rewriteJSON({ uri, name: '' })).name, '原曲');
  const local = { uri: 'spotify:local:a:b:c:1', name: 'Roman' };
  assert.deepEqual(await f.transformer.rewriteJSON(local), local);
  const conflict = await f.transformer.rewriteJSON([{ uri, name: 'One' }, { uri, name: 'Two' }]);
  assert.deepEqual(conflict.map(item => item.name), ['原曲', '原曲']);
  assert.equal(f.store.getPrevious(uri).title, undefined);
});

test('final combined candidate is validated before durable writes', async () => {
  const f = await fixture();
  await assert.rejects(f.transformer.rewriteJSON({ uri, name: 'Roman' }, { validate(candidate) {
    assert.equal(candidate.name, '原曲 - Roman');
    assert.equal(f.writes.length, 0);
    throw new Error('Rejected candidate');
  } }), /Rejected candidate/);
  assert.equal(f.writes.length, 0);
  assert.equal(f.store.getPrevious(uri).title, undefined);
});

test('Resolver never ingests its proven combined presentation as matching metadata', async () => {
  const { Resolver } = await import('../src/resolver.mjs');
  const f = await fixture();
  await f.transformer.rewriteJSON({ uri, name: 'Roman' });
  const resolver = new Resolver({ store: f.store, request: async () => { throw new Error('Unexpected lookup'); } });
  const input = { uri, name: '原曲 - Roman', artists: [] };
  resolver.ingest({ tracks: new Map([[uri, input]]) });
  assert.equal(resolver.clients.get(uri).name, '原曲');
  assert.equal(input.name, '原曲 - Roman');
  const actualTitle = { uri, name: 'Real - Song - Name', artists: [] };
  resolver.ingest({ tracks: new Map([[uri, actualTitle]]) });
  assert.equal(resolver.clients.get(uri).name, 'Real - Song - Name');
});
