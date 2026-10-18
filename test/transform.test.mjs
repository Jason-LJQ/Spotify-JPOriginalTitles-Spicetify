import test from 'node:test';
import assert from 'node:assert/strict';
import { createTransformer } from '../src/transform.mjs';
import { concat, ld, vi, fields, uriToGID, decodeMetadata, parseTrack, text } from '../src/wire.mjs';

const trackURI = 'spotify:track:0000000000000000000001';
const artistURI = 'spotify:artist:0000000000000000000002';
const albumURI = 'spotify:album:0000000000000000000003';
const originalAlbum = 'spotify:album:0000000000000000000004';
const preferred = { uri: trackURI, name: '原曲', originalTitle: '原曲', versionTitle: '', albumName: '原盤', albumURI: originalAlbum, artists: [{ uri: artistURI, name: '歌手' }] };
function setup({ failStore = false, strict = false, failures = [], sourceTracks = new Map([[trackURI, { name: 'Roman', artists: [{ uri: artistURI, name: 'Artist' }] }]]) } = {}) {
  const commits = [];
  const saved = new Map();
  const resolver = { resolve: async () => ({ sourceTracks, tracks: new Map([[trackURI, preferred]]), albums: new Map([[albumURI, { name: '原盤', originalURI: originalAlbum }]]), artistNames: new Map([[artistURI, '歌手']]), failures }), ingest() {} };
  const store = { getPrevious: uri => saved.get(uri) || {}, commit: async delta => {
    const staged = new Map([...saved].map(([uri, record]) => [uri, { ...record }]));
    for (const item of delta.previous) {
      if (JSON.stringify(item.value) === JSON.stringify(item.now)) continue;
      const previous = staged.get(item.uri) || {};
      previous[item.field] = item.value;
      staged.set(item.uri, previous);
    }
    await delta.prepare?.({ getPrevious: uri => staged.get(uri) || {} });
    if (failStore) throw new Error('disk full');
    commits.push(delta);
    saved.clear();
    for (const [uri, record] of staged) saved.set(uri, record);
  } };
  return { transformer: createTransformer({ resolver, store, isStrict: () => strict }), commits, saved };
}
const artist = name => ({ uri: artistURI, profile: { name } });
const jsonTrack = () => ({ uri: trackURI, name: 'Roman', albumOfTrack: { uri: albumURI, name: 'Album' }, artists: { items: [artist('Artist')] }, playback: { uri: trackURI, restrictions: [2] } });
const entity = (uri, name) => concat(ld(1, uriToGID(uri)), ld(2, name), vi(90, 99));
const wireTrack = () => concat(ld(1, uriToGID(trackURI)), ld(2, 'Roman'), ld(3, entity(albumURI, 'Album')), ld(4, entity(artistURI, 'Artist')), ld(27, 'Roman'), ld(28, 'Mix'), vi(100, 42));
const identity = () => concat(ld(1, 'Track'), ld(2, 'Identity Roman'), ld(4, concat(ld(1, 'Identity Album'), ld(2, albumURI))), ld(5, concat(ld(1, 'Identity Artist'), ld(2, artistURI))), vi(100, 42));
const entry = (uri, value, status = 200) => concat(ld(1, vi(1, status)), ld(2, uri), ld(3, concat(ld(1, 'type.googleapis.com/example'), ld(2, value))), vi(99, 5));
const response = entries => concat(vi(98, 9), ...entries.map(([kind, value, uri = trackURI]) => ld(2, concat(vi(2, kind), ld(3, entry(uri, value)), vi(97, 8)))));
const fieldText = (bytes, number) => text(fields(bytes).find(f => f.field === number));

test('GraphQL names are rewritten, playback identity and input are preserved', async () => {
  const { transformer, commits } = setup();
  const input = { data: { trackUnion: jsonTrack() }, playlist: { uri: 'spotify:playlist:abc', name: 'My Roman playlist' }, local: { uri: 'spotify:local:a:b:c:1', name: 'Local' } };
  const before = JSON.stringify(input);
  const output = await transformer.rewriteJSON(input);
  assert.equal(output.data.trackUnion.name, '原曲');
  assert.equal(output.data.trackUnion.albumOfTrack.name, '原盤');
  assert.equal(output.data.trackUnion.albumOfTrack.uri, originalAlbum);
  assert.equal(output.data.trackUnion.artists.items[0].profile.name, '歌手');
  assert.deepEqual(output.data.trackUnion.playback, input.data.trackUnion.playback);
  assert.equal(output.playlist.name, 'My Roman playlist');
  assert.equal(output.local.name, 'Local');
  assert.equal(JSON.stringify(input), before);
  assert.equal(commits.length, 1);
  assert.deepEqual(commits[0].previous.find(item => item.field === 'artists').value, ['Artist']);
});
test('Credits uses committed previous values and deduplicates matching roles', async () => {
  const { transformer, saved } = setup();
  const track = jsonTrack();
  track.creditsTrait = { contributors: { items: [{ name: 'Composer', role: 'Writer', roleGroup: { name: 'Writers' }, uri: artistURI }] }, sources: { items: [] } };
  const output = await transformer.rewriteJSON({ data: { trackUnion: track } });
  const names = output.data.trackUnion.creditsTrait.contributors.items;
  assert.equal(saved.get(trackURI).title, 'Roman');
  assert.deepEqual(names.slice(1).map(item => [item.name, item.role, item.roleGroup.name]), [['Roman', 'Title', 'Original Metadata'], ['Artist', 'Artist', 'Original Metadata'], ['Album', 'Album', 'Original Metadata']]);
  const repeated = await transformer.rewriteJSON(output);
  assert.equal(repeated.data.trackUnion.creditsTrait.contributors.items.length, 4);
});
test('Credits without an entity URI uses the request URI and keeps same-name roles', async () => {
  const { transformer, saved } = setup();
  saved.set(trackURI, { title: 'Shared', album: 'Shared', artists: '' });
  const output = await transformer.rewriteJSON({ data: { trackUnion: { name: 'Anything', creditsTrait: { contributors: { items: [] } } } } }, { uri: trackURI });
  assert.deepEqual(output.data.trackUnion.creditsTrait.contributors.items.map(item => item.role), ['Title', 'Album']);
});
test('storage failure always rejects before a modified response is delivered', async () => {
  for (const strict of [false, true]) {
    const { transformer } = setup({ failStore: true, strict });
    const input = jsonTrack();
    await assert.rejects(transformer.rewriteJSON(input), error => error.code === 'JPT_STORAGE_FAILED' && error.fatal);
    assert.equal(input.name, 'Roman');
  }
});
test('lookup failures keep verified mappings in default mode and reject strict mode', async () => {
  const { transformer } = setup({ failures: [{ uri: 'missing' }] });
  assert.equal((await transformer.rewriteJSON(jsonTrack())).name, '原曲');
  const strict = setup({ strict: true, failures: [{}] });
  await assert.rejects(strict.transformer.rewriteJSON(jsonTrack()), { code: 'JPT_LOOKUP_FAILED' });
});
test('HTTP TRACK_V4 preserves album GID, unknown fields and artist identities', async () => {
  const { transformer, commits } = setup();
  const input = response([[10, wireTrack()]]);
  const original = input.slice();
  const output = await transformer.rewriteMetadata(input);
  const rewritten = decodeMetadata(output).entries[0].value;
  const track = parseTrack(rewritten, trackURI);
  assert.equal(track.name, '原曲');
  assert.equal(track.albumURI, albumURI);
  assert.equal(track.albumName, '原盤');
  assert.equal(track.artists[0].uri, artistURI);
  assert.equal(track.artists[0].name, '歌手');
  assert.equal(track.originalTitle, '原曲');
  assert.equal(track.versionTitle, '');
  assert.equal(fields(rewritten).find(item => item.field === 100).value, 42);
  assert.deepEqual(input, original);
  assert.equal(commits[0].previous.find(item => item.field === 'title').priority, 2);
});
test('HTTP Identity wins previous fields and Credits appends only actual replaced originals', async () => {
  const { transformer, commits } = setup();
  const existing = ld(1, concat(ld(1, 'Composer'), ld(2, 'Writer'), ld(6, ld(1, 'Writers'))));
  const output = await transformer.rewriteMetadata(response([[10, wireTrack()], [178, identity()], [186, existing]]));
  const entries = decodeMetadata(output).entries;
  const trait = entries.find(item => item.kind === 178).value;
  assert.equal(fieldText(trait, 2), '原曲');
  assert.equal(fieldText(fields(trait).find(item => item.field === 4).data, 2), originalAlbum);
  const previous = commits[0].previous.find(item => item.field === 'title');
  assert.equal(previous.value, 'Identity Roman');
  assert.equal(previous.priority, 3);
  const contributors = fields(entries.find(item => item.kind === 186).value).filter(item => item.field === 1);
  assert.equal(contributors.length, 4);
  assert.equal(fieldText(contributors[1].data, 1), 'Identity Roman');
  assert.equal(fieldText(contributors[1].data, 2), 'Title');
});
test('one malformed entry does not discard a valid rewrite; strict rejects it', async () => {
  const good = response([[10, wireTrack()]]);
  const broken = ld(2, concat(vi(2, 10), ld(3, concat(ld(1, vi(1, 200)), ld(2, 'spotify:track:0000000000000000000009'), ld(3, ld(2, Uint8Array.of(18, 12, 4)))))));
  const input = concat(good, broken);
  const { transformer } = setup();
  const output = await transformer.rewriteMetadata(input);
  assert.equal(decodeMetadata(output).entries[0] && parseTrack(decodeMetadata(output).entries[0].value, trackURI).name, '原曲');
  assert.deepEqual(fields(output).at(-1).raw, fields(input).at(-1).raw);
  await assert.rejects(setup({ strict: true }).transformer.rewriteMetadata(input), { code: 'JPT_PARSE_FAILED' });
});
test('native typed maps rewrite identity and keep native Credits shape', async () => {
  const { transformer } = setup();
  const input = { [trackURI]: { 10: { typeUrl: 'type.googleapis.com/spotify.metadata.Track', value: wireTrack() }, 178: { name: 'Roman', contentHierarchyParent: { name: 'Album', uri: albumURI }, contributors: [{ name: 'Artist', uri: artistURI }] }, 186: { contributors: [], sources: [{ name: 'Label' }] } } };
  const output = await transformer.rewriteNative(input);
  assert.equal(parseTrack(output[trackURI][10].value, trackURI).name, '原曲');
  assert.equal(output[trackURI][178].name, '原曲');
  assert.equal(output[trackURI][178].contentHierarchyParent.uri, originalAlbum);
  assert.equal(output[trackURI][186].contributors.length, 3);
  assert.deepEqual(output[trackURI][186].sources, input[trackURI][186].sources);
});
test('player metadata names are changed without changing playback and context fields', async () => {
  const { transformer } = setup();
  const input = { state: { track: { uri: trackURI, metadata: { title: 'Roman', album_title: 'Album', artist_name: 'Artist', artist_uri: artistURI, context_description: 'Playlist Roman', album_uri: albumURI } } }, queue: [{ uri: trackURI, metadata: { title: 'Roman' } }] };
  const output = await transformer.rewritePlayer(input);
  assert.equal(output.state.track.metadata.title, '原曲');
  assert.equal(output.state.track.metadata.album_title, '原盤');
  assert.equal(output.state.track.metadata.artist_name, '歌手');
  assert.equal(output.state.track.metadata.context_description, 'Playlist Roman');
  assert.equal(output.state.track.metadata.album_uri, albumURI);
  assert.equal(output.queue[0].metadata.title, '原曲');
});
test('cancellation is propagated before delivery', async () => {
  const { transformer } = setup();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(transformer.rewriteJSON(jsonTrack(), { signal: controller.signal }), { name: 'AbortError' });
});
test('Esperanto Observe extensionResult entries rewrite inner Any and preserve envelope', async () => {
  const { transformer } = setup();
  const input = { pendingResponse: false, extensionResult: [
    { entityUri: trackURI, extensionKind: 10, extensionData: { typeUrl: 'type.googleapis.com/spotify.metadata.Track', value: wireTrack() }, details: { cacheStatus: 2, fresh: true } },
    { entityUri: trackURI, extensionKind: 178, extensionData: { typeUrl: 'type.googleapis.com/spotify.contentagnostic.v2.IdentityTrait', value: identity() }, details: { fresh: false } },
    { entityUri: trackURI, extensionKind: 186, extensionData: { typeUrl: 'type.googleapis.com/spotify.contentagnostic.v2.CreditsTrait', value: new Uint8Array() }, details: {} },
  ] };
  const output = await transformer.rewriteNative(input);
  assert.equal(parseTrack(output.extensionResult[0].extensionData.value, trackURI).name, '原曲');
  assert.equal(fieldText(output.extensionResult[1].extensionData.value, 2), '原曲');
  assert.equal(fields(output.extensionResult[2].extensionData.value).length, 3);
  assert.deepEqual(output.extensionResult[0].details, input.extensionResult[0].details);
  assert.equal(output.pendingResponse, false);
  assert.equal(parseTrack(input.extensionResult[0].extensionData.value, trackURI).name, 'Roman');
});
test('malformed native entry leaves valid sibling rewrite intact in default mode', async () => {
  const { transformer } = setup();
  const broken = Uint8Array.of(18, 12, 4);
  const output = await transformer.rewriteNative({ extensionResult: [
    { entityUri: trackURI, extensionKind: 10, extensionData: { typeUrl: 'Track', value: wireTrack() } },
    { entityUri: trackURI, extensionKind: 178, extensionData: { typeUrl: 'IdentityTrait', value: broken } },
  ] });
  assert.equal(parseTrack(output.extensionResult[0].extensionData.value, trackURI).name, '原曲');
  assert.deepEqual(output.extensionResult[1].extensionData.value, broken);
});
test('same delivery conflicting old values are suppressed at highest priority', async () => {
  const { transformer, commits } = setup();
  const other = concat(ld(2, 'Different Roman'), ld(4, concat(ld(1, 'Other Album'), ld(2, albumURI))));
  await transformer.rewriteMetadata(response([[178, identity()], [178, other]]));
  assert.equal(commits[0].previous.find(item => item.field === 'title').conflict, true);
});
test('native raw tracks and albums are ingested before lookup with original client names', async () => {
  const order = [];
  const clientTrack = concat(ld(1, uriToGID(trackURI)), ld(2, 'Client 原曲'));
  const clientAlbum = concat(ld(1, uriToGID(albumURI)), ld(2, 'Client 原盤'));
  const resolver = {
    ingest(decoded) { order.push(['ingest', decoded]); },
    async resolve(uris) {
      order.push(['resolve', uris]);
      return { tracks: new Map(), albums: new Map(), artistNames: new Map() };
    },
  };
  const transformer = createTransformer({ resolver, store: { commit: async ({ prepare } = {}) => prepare?.({ getPrevious: () => ({}) }), getPrevious: () => ({}) } });
  await transformer.rewriteNative({ pendingResponse: false, extensionResult: [
    { entityUri: trackURI, extensionKind: 10, status: 1, extensionData: { typeUrl: 'Track', value: clientTrack } },
    { entityUri: albumURI, extensionKind: 9, status: 1, extensionData: { typeUrl: 'Album', value: clientAlbum } },
  ] });
  assert.equal(order[0][0], 'ingest');
  assert.equal(order[1][0], 'resolve');
  assert.equal(order[0][1].tracks.get(trackURI).name, 'Client 原曲');
  assert.equal(order[0][1].albums.get(albumURI).name, 'Client 原盤');
  assert.deepEqual(new Set(order[1][1]), new Set([trackURI, albumURI]));
});
test('GraphQL URI-only discography pointers do not trigger lookups or new display fields', async () => {
  const calls = [];
  const pointerURI = 'spotify:track:0000000000000000000010';
  const hiddenArtist = 'spotify:artist:0000000000000000000011';
  const resolver = { async resolve(uris) { calls.push(uris); return { tracks: new Map(), albums: new Map(), artistNames: new Map() }; } };
  const transformer = createTransformer({ resolver, store: { commit: async ({ prepare } = {}) => prepare?.({ getPrevious: () => ({}) }), getPrevious: () => ({}) } });
  const input = { data: { trackUnion: { uri: trackURI, name: 'Shown', artists: { items: [{ uri: artistURI }] }, discography: { tracks: { items: [{ track: { trackNumber: 1, uri: pointerURI } }] }, hidden: { uri: hiddenArtist } } } } };
  const output = await transformer.rewriteJSON(input);
  assert.deepEqual(calls[0], [trackURI]);
  assert.deepEqual(output, input);
});
test('request-scoped Credits trackUnion title is rewritten and captured without a URI', async () => {
  const { transformer, commits } = setup();
  const input = { data: { trackUnion: { __typename: 'Track', name: 'Roman', artists: { items: [{ uri: artistURI }] }, creditsTrait: { contributors: { items: [] } } }, unrelated: { name: 'Roman' } } };
  const output = await transformer.rewriteJSON(input, { uri: trackURI });
  assert.equal(output.data.trackUnion.name, '原曲');
  assert.equal(output.data.unrelated.name, 'Roman');
  assert.equal(input.data.trackUnion.name, 'Roman');
  assert.equal(commits[0].previous.find(item => item.field === 'title').value, 'Roman');
  assert.deepEqual(output.data.trackUnion.creditsTrait.contributors.items.map(item => [item.name, item.role]), [['Roman', 'Title']]);
});
test('Identity parent and URI-matched contributor preserve unknown nested bytes', async () => {
  const { transformer } = setup();
  const parentUnknown = vi(78, 121);
  const contributorUnknown = ld(79, 'unknown-contributor-data');
  const input = concat(ld(2, 'Roman'), ld(4, concat(ld(1, 'Album'), ld(2, albumURI), parentUnknown)), ld(5, concat(ld(1, 'Artist'), ld(2, artistURI), contributorUnknown)));
  const output = decodeMetadata(await transformer.rewriteMetadata(response([[178, input]]))).entries[0].value;
  const parent = fields(output).find(item => item.field === 4).data;
  const contributor = fields(output).find(item => item.field === 5).data;
  assert.deepEqual(fields(parent).find(item => item.field === 78).raw, parentUnknown);
  assert.deepEqual(fields(contributor).find(item => item.field === 79).raw, contributorUnknown);
  assert.equal(fieldText(parent, 1), '原盤');
  assert.equal(fieldText(contributor, 1), '歌手');
});
test('SimpleCard artist names update repeated title only when it matched the original name', async () => {
  const { transformer } = setup();
  const output = await transformer.rewriteMetadata(response([[97, concat(ld(2, 'Artist'), ld(6, 'Artist'), vi(80, 77)), artistURI], [97, concat(ld(2, 'Artist'), ld(6, 'Unrelated title')), artistURI]]));
  const entries = decodeMetadata(output).entries;
  assert.equal(fieldText(entries[0].value, 2), '歌手');
  assert.equal(fieldText(entries[0].value, 6), '歌手');
  assert.equal(fields(entries[0].value).find(item => item.field === 80).value, 77);
  assert.equal(fieldText(entries[1].value, 6), 'Unrelated title');
});
test('typed SimpleCard artist name and duplicate title follow the same rule', async () => {
  const { transformer } = setup();
  const output = await transformer.rewriteNative({ [artistURI]: { 97: { name: 'Artist', title: 'Artist', extra: 19 } } });
  assert.deepEqual(output[artistURI][97], { name: '歌手', title: '歌手', extra: 19 });
});
test('NameTrait rewrites verified field 1 and preserves unrelated field 2 and unknown bytes', async () => {
  const { transformer, commits } = setup();
  const output = await transformer.rewriteMetadata(response([[128, concat(ld(1, 'Roman'), ld(2, 'Unknown'), vi(90, 71))], [128, ld(1, 'Artist'), artistURI], [128, ld(1, 'Album'), albumURI]]));
  const entries = decodeMetadata(output).entries;
  assert.equal(fieldText(entries[0].value, 1), '原曲');
  assert.equal(fieldText(entries[0].value, 2), 'Unknown');
  assert.equal(fields(entries[0].value).find(item => item.field === 90).value, 71);
  assert.equal(fieldText(entries[1].value, 1), '歌手');
  assert.equal(fieldText(entries[2].value, 1), '原盤');
  assert.equal(commits[0].previous.find(item => item.field === 'title').priority, 1);
});
test('SimpleCard track artist children use verified source URI correspondence', async () => {
  const { transformer, commits } = setup();
  const input = concat(ld(1, 'image-url'), ld(2, 'Roman'), ld(3, 'Artist'), ld(4, trackURI), ld(6, 'Roman'), ld(8, concat(ld(1, 'Artist'), vi(81, 91))), vi(82, 92));
  const output = decodeMetadata(await transformer.rewriteMetadata(response([[97, input]]))).entries[0].value;
  assert.equal(fieldText(output, 1), 'image-url');
  assert.equal(fieldText(output, 2), '原曲');
  assert.equal(fieldText(output, 3), '歌手');
  assert.equal(fieldText(output, 4), trackURI);
  assert.equal(fieldText(output, 6), '原曲');
  const child = fields(output).find(item => item.field === 8).data;
  assert.equal(fieldText(child, 1), '歌手');
  assert.equal(fields(child).find(item => item.field === 81).value, 91);
  assert.equal(fields(output).find(item => item.field === 82).value, 92);
  assert.deepEqual(commits[0].previous.find(item => item.field === 'artists').value, ['Artist']);
});
test('SimpleCard track artist count or old-name mismatch preserves all artist text', async () => {
  const { transformer } = setup();
  const input = concat(ld(2, 'Roman'), ld(3, 'Different Artist'), ld(6, 'Roman'), ld(8, ld(1, 'Different Artist')));
  const output = decodeMetadata(await transformer.rewriteMetadata(response([[97, input]]))).entries[0].value;
  assert.equal(fieldText(output, 2), '原曲');
  assert.equal(fieldText(output, 3), 'Different Artist');
  assert.equal(fieldText(fields(output).find(item => item.field === 8).data, 1), 'Different Artist');
});
test('mixed raw and already-rewritten duplicates retain a single verified original', async () => {
  const { transformer, commits } = setup();
  const input = response([[128, ld(1, 'Roman')], [128, ld(1, '原曲')]]);
  await transformer.rewriteMetadata(input);
  const old = commits[0].previous.find(item => item.field === 'title');
  assert.equal(old.value, 'Roman');
  assert.equal(old.now, '原曲');
  assert.notEqual(old.conflict, true);
});
test('lower-priority NameTrait cannot suppress Identity previous title in one delivery', async () => {
  const { transformer, commits } = setup();
  await transformer.rewriteMetadata(response([[178, identity()], [128, ld(1, '')]]));
  const old = commits[0].previous.find(item => item.field === 'title');
  assert.equal(old.value, 'Identity Roman');
  assert.equal(old.priority, 3);
});
test('native raw NameTrait and SimpleCard use their own field layouts', async () => {
  const { transformer } = setup();
  const output = await transformer.rewriteNative({ extensionResult: [
    { entityUri: trackURI, extensionKind: 128, status: 1, extensionData: { typeUrl: 'NameTrait', value: ld(1, 'Roman') } },
    { entityUri: trackURI, extensionKind: 97, status: 1, extensionData: { typeUrl: 'SimpleCardTrait', value: concat(ld(2, 'Roman'), ld(3, 'Artist'), ld(8, ld(1, 'Artist'))) } },
  ] });
  assert.equal(fieldText(output.extensionResult[0].extensionData.value, 1), '原曲');
  assert.equal(fieldText(output.extensionResult[1].extensionData.value, 3), '歌手');
});
test('strict invalid HTTP Credits fails before storing undelivered title observations', async () => {
  const { transformer, commits } = setup({ strict: true });
  const malformedContributor = ld(1, concat(ld(1, 'Duplicate'), ld(1, 'Duplicate again')));
  await assert.rejects(transformer.rewriteMetadata(response([[178, identity()], [186, malformedContributor]])), { code: 'JPT_PARSE_FAILED' });
  assert.equal(commits.length, 0);
});
test('strict invalid native Credits fails before storing undelivered title observations', async () => {
  const { transformer, commits } = setup({ strict: true });
  await assert.rejects(transformer.rewriteNative({ extensionResult: [
    { entityUri: trackURI, extensionKind: 178, status: 1, extensionData: { typeUrl: 'IdentityTrait', value: identity() } },
    { entityUri: trackURI, extensionKind: 186, status: 1, extensionData: { typeUrl: 'CreditsTrait', value: vi(1, 19) } },
  ] }), { code: 'JPT_PARSE_FAILED' });
  assert.equal(commits.length, 0);
});
test('local-file subtrees remain untouched including artist and player metadata', async () => {
  const { transformer } = setup();
  const local = { uri: 'spotify:local:Artist:Album:Roman:100', name: 'Roman', artists: [{ uri: artistURI, name: 'Artist' }], metadata: { title: 'Roman', artist_name: 'Artist', artist_uri: artistURI } };
  const output = await transformer.rewritePlayer({ queue: [local, { uri: trackURI, metadata: { title: 'Roman' } }] });
  assert.deepEqual(output.queue[0], local);
  assert.equal(output.queue[1].metadata.title, '原曲');
});
test('native playlist Get link metadata rewrites delivered row names without changing identity or playlist title', async () => {
  const { transformer, commits } = setup();
  const opaque = Uint8Array.of(8, 2, 18, 1, 9);
  const input = { status: 0, data: { item: [{ uri: trackURI, rowId: 17n, addedBy: 'user', trackMetadata: { link: trackURI, name: 'Roman', length: 180000, playable: true, album: { link: albumURI, name: 'Album', artist: [{ link: artistURI, name: 'Artist' }] }, artist: [{ link: artistURI, name: 'Artist' }], extension: [{ extensionKind: 182, data: opaque }] }, extension: [{ extensionKind: 85, data: new Uint8Array() }] }], playlist: { playlistMetadata: { link: 'spotify:playlist:personal', name: 'My Roman playlist' } } } };
  const output = await transformer.rewriteJSON(input, { priority: 3 });
  const row = output.data.item[0];
  assert.equal(row.trackMetadata.name, '原曲');
  assert.equal(row.trackMetadata.album.name, '原盤');
  assert.equal(row.trackMetadata.artist[0].name, '歌手');
  assert.equal(row.trackMetadata.album.artist[0].name, '歌手');
  assert.equal(row.uri, trackURI);
  assert.equal(row.trackMetadata.link, trackURI);
  assert.equal(row.trackMetadata.album.link, albumURI);
  assert.equal(row.trackMetadata.artist[0].link, artistURI);
  assert.equal(row.rowId, 17n);
  assert.equal(output.data.playlist.playlistMetadata.name, 'My Roman playlist');
  assert.deepEqual(row.trackMetadata.extension[0].data, opaque);
  assert.equal(input.data.item[0].trackMetadata.name, 'Roman');
  const title = commits[0].previous.find(item => item.field === 'title');
  assert.equal(title.value, 'Roman');
  assert.equal(title.priority, 2);
  assert.deepEqual(commits[0].previous.find(item => item.field === 'artists').value, ['Artist']);
});
test('unrecognized arbitrary link properties are not entity carriers', async () => {
  const { transformer } = setup();
  const input = { arbitrary: { link: trackURI, name: 'Roman' }, data: { item: [{ uri: trackURI, trackMetadata: { link: trackURI, name: 'Roman' } }] } };
  const output = await transformer.rewriteJSON(input);
  assert.equal(output.arbitrary.name, 'Roman');
  assert.equal(output.data.item[0].trackMetadata.name, '原曲');
});
test('track-adopted parent album name is not overwritten by standalone album-page mapping', async () => {
  const store = { commit: async ({ prepare } = {}) => prepare?.({ getPrevious: () => ({}) }), getPrevious: () => ({}) };
  const resolver = { resolve: async () => ({ tracks: new Map([[trackURI, preferred]]), albums: new Map([[albumURI, { name: 'Standalone Latin Album' }]]), artistNames: new Map([[artistURI, '歌手']]) }) };
  const transformer = createTransformer({ resolver, store });
  const input = { data: { item: [{ uri: trackURI, trackMetadata: { link: trackURI, name: 'Roman', album: { link: albumURI, name: 'Album' }, artist: [{ link: artistURI, name: 'Artist' }] } }], albumMetadata: { link: albumURI, name: 'Album' } } };
  const output = await transformer.rewriteNative(input);
  assert.equal(output.data.item[0].trackMetadata.album.name, '原盤');
  assert.equal(output.data.albumMetadata.name, 'Standalone Latin Album');
});
test('complete JSON Credits candidate is validated before persistence and remains unchanged afterward', async () => {
  const { transformer, commits, saved } = setup();
  let validated, snapshot;
  const input = { data: { trackUnion: { ...jsonTrack(), creditsTrait: { contributors: { items: [] } } } } };
  const output = await transformer.rewriteJSON(input, { validate: async candidate => {
    assert.equal(commits.length, 0);
    assert.equal(saved.size, 0);
    assert.equal(candidate.data.trackUnion.name, '原曲');
    assert.deepEqual(candidate.data.trackUnion.creditsTrait.contributors.items.map(item => item.role), ['Title', 'Artist', 'Album']);
    validated = candidate;
    snapshot = JSON.stringify(candidate);
  } });
  assert.equal(output, validated);
  assert.equal(JSON.stringify(output), snapshot);
  assert.equal(commits.length, 1);
});
test('candidate validation error is preserved and saves no previous values', async () => {
  const { transformer, commits, saved } = setup();
  const rejected = new Error('Ambiguous native field');
  rejected.code = 'JPT_WIRE_AMBIGUOUS';
  await assert.rejects(transformer.rewriteJSON(jsonTrack(), { validate: async () => { throw rejected; } }), error => error === rejected && !error.fatal);
  assert.equal(commits.length, 0);
  assert.equal(saved.size, 0);
});
test('complete HTTP Credits bytes are validated using projected old values before persistence', async () => {
  const { transformer, commits, saved } = setup();
  let validated;
  const input = response([[178, identity()], [186, new Uint8Array()]]);
  const output = await transformer.rewriteMetadata(input, { validate: async candidate => {
    assert.equal(commits.length, 0);
    assert.equal(saved.size, 0);
    const credits = decodeMetadata(candidate).entries.find(item => item.kind === 186).value;
    assert.equal(fieldText(fields(credits).find(item => item.field === 1).data, 1), 'Identity Roman');
    validated = candidate;
  } });
  assert.equal(output, validated);
  assert.equal(commits.length, 1);
});
test('native raw Credits final candidate is prepared and validated before committing', async () => {
  const { transformer, commits, saved } = setup();
  let snapshot;
  const output = await transformer.rewriteNative({ extensionResult: [
    { entityUri: trackURI, extensionKind: 178, status: 1, extensionData: { typeUrl: 'IdentityTrait', value: identity() } },
    { entityUri: trackURI, extensionKind: 186, status: 1, extensionData: { typeUrl: 'CreditsTrait', value: new Uint8Array() } },
  ] }, { validate: async candidate => {
    assert.equal(commits.length, 0);
    assert.equal(saved.size, 0);
    const credits = candidate.extensionResult[1].extensionData.value;
    assert.equal(fields(credits).length, 3);
    assert.equal(fieldText(fields(credits)[0].data, 1), 'Identity Roman');
    snapshot = credits.slice();
  } });
  assert.deepEqual(output.extensionResult[1].extensionData.value, snapshot);
  assert.equal(commits.length, 1);
});
