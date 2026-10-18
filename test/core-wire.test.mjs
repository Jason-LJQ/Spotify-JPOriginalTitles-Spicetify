import test from 'node:test';
import assert from 'node:assert/strict';
import { fields, ld, vi, concat, text, parseTrack, parseAlbum, parseArtist, decodeMetadata, encodeRequest, replaceString, uriToGID, gidToURI } from '../src/wire.mjs';
const uri = (type, n) => `spotify:${type}:${String(n).padStart(22, '0')}`;
const entity = (type, n, name) => concat(ld(1, uriToGID(uri(type, n))), ld(2, name));
export function response(entries) {
  const kinds = new Map();
  for (const entry of entries) {
    const { kind, uri, status = 200, value } = entry;
    if (!kinds.has(kind)) kinds.set(kind, []);
    kinds.get(kind).push(ld(3, concat(ld(1, vi(1, status)), ld(2, uri), value !== undefined ? ld(3, ld(2, value)) : null)));
  }
  return concat([...kinds].map(([kind, entries]) => ld(2, concat(vi(2, kind), ...entries))));
}
export function trackValue(t) {
  return concat(ld(2, t.name ?? ''), t.albumURI ? ld(3, concat(ld(1, uriToGID(t.albumURI)), ld(2, t.albumName ?? 'Album'))) : null,
    ...(t.artists ?? []).map(a => ld(4, concat(ld(1, uriToGID(a.uri)), ld(2, a.name)))),
    vi(5, t.number ?? 1), vi(6, t.disc ?? 1), vi(7, t.duration ?? 100000),
    t.isrc ? ld(10, concat(ld(1, 'isrc'), ld(2, t.isrc))) : null,
    ...(t.performanceLanguages ?? []).map(l => ld(22, l)), t.canonicalURI ? ld(36, t.canonicalURI) : null);
}
export function albumValue(a) {
  return concat(ld(2, a.name ?? ''), a.originalURI ? ld(35, a.originalURI) : null,
    ld(11, concat(...(a.tracks ?? []).map(t => ld(3, ld(1, uriToGID(t)))))));
}
export { uri };

test('wire preserves unknown fields and exact uint64 while replacing first string', () => {
  const unknown = concat(vi(47, 9007199254740993n), Uint8Array.from([0x7d, 1, 2, 3, 4]));
  const out = fields(replaceString(concat(ld(2, 'old'), unknown, ld(2, 'duplicate')), 2, '日本語'));
  assert.equal(text(out[0]), '日本語'); assert.equal(out[1].value, 9007199254740993n);
  assert.deepEqual(concat(out.slice(1, 3).map(f => f.raw)), unknown); assert.equal(text(out[3]), 'duplicate');
});
test('wire rejects truncated lengths, uint64 overflow, invalid tags and unsupported groups', () => {
  for (const malformed of [[0], [10, 3, 1], [8, ...Array(9).fill(255), 2], [11]]) assert.throws(() => fields(Uint8Array.from(malformed)));
});
test('Spotify GIDs round trip without number precision loss', () => {
  const gid = Uint8Array.from([255, 2, 45, 67, 89, 120, 123, 243, 65, 43, 29, 1, 254, 243, 150, 145]);
  assert.deepEqual(uriToGID(gidToURI(gid, 'track')), gid); assert.throws(() => uriToGID('spotify:track:ZZZZZZZZZZZZZZZZZZZZZZ'));
});
test('track parses exact positions, languages and nested references', () => {
  const t = { uri: uri('track', 1), name: '日本語', albumURI: uri('album', 2), albumName: '作品', artists: [{ uri: uri('artist', 3), name: '歌手' }], canonicalURI: uri('track', 4), isrc: 'JPTEST1234567', number: 7, disc: 2, duration: 123456, performanceLanguages: ['ja', 'und'] };
  const parsed = parseTrack(trackValue(t), t.uri);
  for (const key of Object.keys(t)) assert.deepEqual(parsed[key], t[key]);
});
test('empty name is a valid track, artist and album', () => {
  assert.equal(parseTrack(new Uint8Array(), uri('track', 1)).name, '');
  assert.equal(parseArtist(new Uint8Array(), uri('artist', 1)).name, '');
  assert.equal(parseAlbum(new Uint8Array(), uri('album', 1)).name, '');
});
test('album parses field35 and deduplicates complete disc track list', () => {
  const a = { uri: uri('album', 1), name: 'Album', originalURI: uri('album', 2), tracks: [uri('track', 3), uri('track', 3), uri('track', 4)] };
  const parsed = parseAlbum(albumValue(a), a.uri);
  assert.equal(parsed.originalURI, a.originalURI); assert.deepEqual(parsed.tracks, [uri('track', 3), uri('track', 4)]);
});
test('metadata isolates invalid successful values and retains completed absence', () => {
  const data = response([{ kind: 10, uri: uri('track', 1), value: Uint8Array.from([10, 5]) }, { kind: 10, uri: uri('track', 2), value: trackValue({ name: 'Valid' }) }, { kind: 10, uri: uri('track', 3), status: 404 }]);
  const parsed = decodeMetadata(data);
  assert.equal(parsed.tracks.size, 1); assert.ok(parsed.entries[0].parseError); assert.equal(parsed.entries[2].status, 404);
});
test('request reuses opaque header and asks only explicit kinds without etags', () => {
  const header = concat(ld(1, 'US'), ld(2, 'premium'));
  const request = fields(encodeRequest([{ uri: uri('track', 1), kinds: [10, 178] }], { header }));
  assert.deepEqual(request[0].data, header);
  const body = fields(request[1].data); assert.equal(text(body[0]), uri('track', 1));
  assert.deepEqual(body.slice(1).map(f => fields(f.data)[0].value), [10, 178]);
});
