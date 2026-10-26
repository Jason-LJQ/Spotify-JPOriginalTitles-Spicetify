import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/storage.mjs';
import { createTransformer } from '../src/transform.mjs';
import { concat, ld, vi, fields, text, decodeMetadata } from '../src/wire.mjs';

const uri = 'spotify:track:0000000000000000000001';
const albumURI = 'spotify:album:0000000000000000000002';
const otherAlbum = 'spotify:album:0000000000000000000005';
const artistURI = 'spotify:artist:0000000000000000000003';
const otherArtist = 'spotify:artist:0000000000000000000004';
const fieldText = (bytes, number) => text(fields(bytes).find(item => item.field === number));
const identity = (title, album, albumUri, artists) => concat(ld(1, 'Track'), ld(2, title), ld(4, concat(ld(1, album), ld(2, albumUri))),
  ...artists.map(([name, artist]) => ld(5, concat(ld(1, name), ld(2, artist)))));
const response = value => ld(2, concat(vi(2, 178), ld(3, concat(ld(1, vi(1, 200)), ld(2, uri), ld(3, concat(ld(1, 'type'), ld(2, value)))))));
const track = (name, albumName, artistName) => ({ uri, name, albumName, albumURI, artists: [{ uri: artistURI, name: artistName }] });

async function transformer(preferred, artistNames = new Map()) {
  const store = await new Store({ adapter: { load: async () => ({}), async write() {} } }).open();
  const resolver = { resolve: async () => ({ tracks: new Map([[uri, preferred]]), albums: new Map(), artistNames, failures: [] }) };
  return { store, transformer: createTransformer({ resolver, store, combineTitles: () => true }) };
}
async function deliver(preferred, value, artistNames) {
  const f = await transformer(preferred, artistNames);
  const output = await f.transformer.rewriteMetadata(response(value));
  return { value: decodeMetadata(output).entries[0].value, previous: f.store.getPrevious(uri) };
}

test('Chinese IdentityTrait names are not replaced by other Chinese names', async () => {
  const input = identity('你若三冬（将军进行曲） - DJ沈乐版', '你若三冬（将军进行曲）（DJ沈乐版）', otherAlbum, [['阿悠悠', artistURI]]);
  const result = await deliver(track('你若三冬（将军进行曲）', '你若三冬（将军进行曲）', '阿悠悠'), input);
  assert.deepEqual(result.value, input);
  assert.deepEqual(result.previous, {});
});

test('Latin IdentityTrait title, album and artists are not replaced by Latin names', async () => {
  const input = identity('Welcome to New York', 'Party Time Hits', otherAlbum, [['Kids Party Music Players', otherArtist]]);
  const result = await deliver(track('Welcome To New York', '#swifty', 'Swifty'), input);
  assert.deepEqual(result.value, input);
  assert.deepEqual(result.previous, {});
});

test('Japanese IdentityTrait title and album stay while a Latin artist gains its Japanese name', async () => {
  const input = identity('百花繚乱', '百花繚乱', otherAlbum, [['Lilas', artistURI]]);
  const result = await deliver(track('In Bloom', 'In Bloom', 'Lilas'), input, new Map([[artistURI, '幾田りら']]));
  assert.equal(fieldText(result.value, 2), '百花繚乱');
  const parent = fields(result.value).find(item => item.field === 4).data;
  assert.equal(fieldText(parent, 1), '百花繚乱');
  assert.equal(fieldText(parent, 2), otherAlbum);
  assert.equal(fieldText(fields(result.value).find(item => item.field === 5).data, 1), '幾田りら');
  assert.deepEqual(result.previous, { artists: 'Lilas' });
});

test('romanized IdentityTrait still receives the Japanese title, album and artist', async () => {
  const result = await deliver(track('救世主', '救世主', 'ツクヨミ'), identity('Kyuseishu', 'Kyuseishu', otherAlbum, [['Tsukuyomi', artistURI]]));
  assert.equal(fieldText(result.value, 2), '救世主｜Kyuseishu');
  const parent = fields(result.value).find(item => item.field === 4).data;
  assert.equal(fieldText(parent, 1), '救世主');
  assert.equal(fieldText(parent, 2), albumURI);
  assert.equal(fieldText(fields(result.value).find(item => item.field === 5).data, 1), 'ツクヨミ');
  assert.equal(result.previous.title, 'Kyuseishu');
});

test('an artist list that already has CJK text still renames the same-URI Latin artist', async () => {
  const preferred = { uri, name: 'ボカロ曲', albumName: 'アルバム', albumURI, artists: [{ uri: otherArtist, name: '初音ミク produced by ワカバ' }, { uri: artistURI, name: '初音ミク' }] };
  const result = await deliver(preferred, identity('ボカロ曲', 'アルバム', otherAlbum, [['初音ミク produced by ワカバ', otherArtist], ['Hatsune Miku', artistURI]]));
  const artists = fields(result.value).filter(item => item.field === 5).map(item => [fieldText(item.data, 1), fieldText(item.data, 2)]);
  assert.deepEqual(artists, [['初音ミク produced by ワカバ', otherArtist], ['初音ミク', artistURI]]);
  assert.equal(fieldText(result.value, 2), 'ボカロ曲');
});

test('typed JSON and player state keep Latin names that would only become other Latin names', async () => {
  const f = await transformer(track('Welcome To New York', '#swifty', 'Swifty'));
  const json = { uri, name: 'Welcome to New York', album: { uri: otherAlbum, name: 'Party Time Hits' }, artists: [{ uri: artistURI, name: 'Kids Party Music Players' }] };
  assert.deepEqual(await f.transformer.rewriteJSON(json), json);
  const player = { track: { uri, metadata: { title: 'Welcome to New York', album_title: 'Party Time Hits', artist_name: 'Kids Party Music Players', artist_uri: artistURI } } };
  assert.deepEqual(await f.transformer.rewritePlayer(player), player);
  assert.deepEqual(f.store.getPrevious(uri), {});
});
