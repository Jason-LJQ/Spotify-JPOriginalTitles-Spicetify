import test from 'node:test';
import assert from 'node:assert/strict';
import { concat, fields, ld, vi } from '../src/wire.mjs';
import { NATIVE_WIRE_SCHEMAS, overlayKnownWire } from '../src/wire-overlay.mjs';

const field = (bytes, number) => fields(bytes).find(item => item.field === number);

test('lossless overlay retains unknown fields at metadata envelope, result and Any levels', () => {
  const innerBefore = concat(ld(2, 'before'), vi(111, 42));
  const innerAfter = concat(ld(2, 'after'), vi(111, 42));
  const anyBefore = concat(ld(1, 'type/sample'), ld(2, innerBefore));
  const anyAfter = concat(ld(1, 'type/sample'), ld(2, innerAfter));
  const resultBefore = concat(ld(1, 'spotify:track:ABC'), vi(2, 178), ld(3, anyBefore), vi(4, 1));
  const resultAfter = concat(ld(1, 'spotify:track:ABC'), vi(2, 178), ld(3, anyAfter), vi(4, 1));
  const originalAny = concat(anyBefore, ld(77, new Uint8Array([255, 0])));
  const originalResult = concat(ld(1, 'spotify:track:ABC'), vi(2, 178), ld(3, originalAny), vi(88, 123), vi(4, 1));
  const original = concat(vi(99, 13), ld(1, originalResult), vi(2, 0));
  const output = overlayKnownWire(original, ld(1, resultBefore), ld(1, resultAfter), NATIVE_WIRE_SCHEMAS.metadata.observe);
  assert.deepEqual(field(output, 99).raw, field(original, 99).raw);
  assert.deepEqual(field(output, 2).raw, field(original, 2).raw);
  const result = field(output, 1).data;
  assert.deepEqual(field(result, 88).raw, field(originalResult, 88).raw);
  const any = field(result, 3).data;
  assert.deepEqual(field(any, 77).raw, field(originalAny, 77).raw);
  assert.deepEqual(field(any, 2).data, innerAfter);
  assert.deepEqual(field(field(any, 2).data, 111).raw, field(innerBefore, 111).raw);
});

test('unmodified known fields and explicit defaults retain their exact original encoding', () => {
  const noncanonicalZero = new Uint8Array([0x10, 0x80, 0x00]);
  const before = concat(ld(1, 'before'), vi(3, 1));
  const after = concat(ld(1, 'after'), vi(3, 1));
  const original = concat(noncanonicalZero, ld(1, 'before'), vi(3, 1), vi(91, 7));
  const output = overlayKnownWire(original, before, after);
  assert.deepEqual(field(output, 2).raw, noncanonicalZero);
  assert.deepEqual(field(output, 91).raw, field(original, 91).raw);
  assert.deepEqual(field(output, 1).data, new TextEncoder().encode('after'));
});

test('length-delimited string and binary fields never get guessed as protobuf messages', () => {
  const opaqueBefore = vi(1, 7);
  const opaqueAfter = vi(1, 9);
  const before = ld(1, opaqueBefore);
  const after = ld(1, opaqueAfter);
  const original = concat(before, vi(33, 1));
  const output = overlayKnownWire(original, before, after, {});
  assert.deepEqual(field(output, 1).data, opaqueAfter);
  assert.deepEqual(field(output, 33).raw, field(original, 33).raw);
});

test('repeated changed records keep their own unknown values and interleaved field order', () => {
  const before = concat(ld(1, ld(2, 'first')), ld(1, ld(2, 'second')));
  const after = concat(ld(1, ld(2, 'changed-first')), ld(1, ld(2, 'changed-second')));
  const original = concat(ld(1, concat(ld(2, 'first'), vi(90, 1))), vi(92, 17), ld(1, concat(ld(2, 'second'), vi(90, 2))));
  const output = overlayKnownWire(original, before, after, { 1: {} });
  const parsed = fields(output);
  assert.deepEqual(parsed.map(value => value.field), [1, 92, 1]);
  assert.equal(field(parsed[0].data, 90).value, 1);
  assert.equal(field(parsed[2].data, 90).value, 2);
});

test('unknown fields with a different wire type survive a known field replacement', () => {
  const before = ld(1, 'before'); const after = ld(1, 'after');
  const unknown = vi(1, 123);
  const output = overlayKnownWire(concat(unknown, before), before, after);
  assert.deepEqual(fields(output)[0].raw, unknown);
});

test('removing and inserting known fields leaves unrelated unknown fields intact', () => {
  const original = concat(ld(1, 'remove'), vi(77, 9));
  const output = overlayKnownWire(original, ld(1, 'remove'), ld(2, 'added'));
  assert.deepEqual(fields(output).map(value => value.field), [77, 2]);
});

test('ambiguous repeated message alignment rejects rather than silently dropping unknown fields', () => {
  assert.throws(() => overlayKnownWire(concat(ld(1, vi(90, 1)), ld(1, vi(90, 2))),
    concat(ld(1, ld(2, 'one')), ld(1, ld(2, 'two'))), ld(1, ld(2, 'merged')), { 1: {} }), { code: 'JPT_PARSE_FAILED' });
});

test('unchanged canonical serialization returns the original bytes by identity', () => {
  const original = concat(ld(1, 'same'), vi(99, 17));
  const known = ld(1, 'same');
  assert.equal(overlayKnownWire(original, known, known), original);
});

test('player state preserves unknown fields in ProvidedTrack, ContextTrack and metadata map entries', () => {
  const entry = value => concat(ld(1, 'title'), ld(2, value));
  const context = value => concat(ld(1, 'spotify:track:ABC'), ld(3, entry(value)));
  const provided = value => ld(1, context(value));
  const before = ld(7, provided('before'));
  const after = ld(7, provided('after'));
  const original = concat(ld(7, concat(ld(1, concat(ld(1, 'spotify:track:ABC'),
    ld(3, concat(entry('before'), vi(72, 8))), vi(73, 9))), vi(74, 10))), vi(75, 11));
  const output = overlayKnownWire(original, before, after, NATIVE_WIRE_SCHEMAS.player.getstate);
  const p = field(output, 7).data;
  const c = field(p, 1).data;
  const m = field(c, 3).data;
  assert.equal(field(p, 74).value, 10); assert.equal(field(c, 73).value, 9); assert.equal(field(m, 72).value, 8);
  assert.deepEqual(field(m, 2).data, new TextEncoder().encode('after'));
  assert.equal(field(output, 75).value, 11);
});

test('player metadata map additions preserve existing entry unknown fields by declared key', () => {
  const entry = (key, value) => concat(ld(1, key), ld(2, value));
  const before = ld(3, entry('title', 'before'));
  const after = concat(ld(3, entry('title', 'after')), ld(3, entry('album_title', 'album')));
  const original = ld(3, concat(entry('title', 'before'), vi(91, 19)));
  const output = overlayKnownWire(original, before, after, { 3: { $key: 1 } });
  assert.equal(fields(output).length, 2);
  assert.equal(field(fields(output)[0].data, 91).value, 19);
});

test('playlist track metadata retains item, album, artist and extension unknown fields', () => {
  const album = name => concat(ld(2, 'spotify:album:ABC'), ld(3, name));
  const artist = name => concat(ld(1, 'spotify:artist:ABC'), ld(2, name));
  const metadata = name => concat(ld(1, album(name)), ld(2, artist(name)), ld(3, 'spotify:track:ABC'), ld(4, name));
  const envelope = name => ld(2, ld(1, ld(4, metadata(name))));
  const rawMetadata = concat(ld(1, concat(album('before'), vi(81, 1))), ld(2, concat(artist('before'), vi(82, 2))),
    ld(3, 'spotify:track:ABC'), ld(4, 'before'), vi(83, 3));
  const rawItem = concat(ld(4, rawMetadata), ld(17, concat(vi(1, 178), ld(2, new Uint8Array([255])), vi(84, 4))), vi(85, 5));
  const original = concat(ld(2, concat(ld(1, rawItem), vi(86, 6))), vi(87, 7));
  const output = overlayKnownWire(original, envelope('before'), envelope('after'), NATIVE_WIRE_SCHEMAS.list.get);
  const data = field(output, 2).data; const item = field(data, 1).data; const track = field(item, 4).data;
  assert.equal(field(field(track, 1).data, 81).value, 1);
  assert.equal(field(field(track, 2).data, 82).value, 2);
  assert.equal(field(track, 83).value, 3); assert.equal(field(item, 85).value, 5);
  assert.equal(field(data, 86).value, 6); assert.equal(field(output, 87).value, 7);
  assert.deepEqual(field(item, 17).raw, field(rawItem, 17).raw);
  assert.deepEqual(field(track, 4).data, new TextEncoder().encode('after'));
});
