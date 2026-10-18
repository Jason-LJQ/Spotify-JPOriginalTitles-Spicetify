import { concat, fields, ld } from './wire.mjs';

const equal = (left, right) => left.length === right.length && left.every((value, index) => value === right[index]);
const key = field => `${field.field}:${field.wire}`;
const group = parsed => {
  const result = new Map();
  for (const field of parsed) {
    const name = key(field);
    if (!result.has(name)) result.set(name, []);
    result.get(name).push(field);
  }
  return result;
};
const encoded = values => concat((values ?? []).map(field => field.raw));
function keyed(values, number) {
  const result = new Map();
  for (const value of values) {
    const identifier = fields(value.data).find(field => field.field === number && field.wire === 2);
    const identity = identifier ? Array.from(identifier.data).join(',') : '';
    if (result.has(identity)) throw Object.assign(new Error('Duplicate bridge map keys cannot be aligned losslessly.'), { code: 'JPT_PARSE_FAILED' });
    result.set(identity, value);
  }
  return result;
}

// Only schema-declared message fields recurse; strings and byte blobs remain opaque.
export function overlayKnownWire(original, canonicalBefore, canonicalAfter, children = {}) {
  if (equal(canonicalBefore, canonicalAfter)) return original;
  const source = fields(original);
  const old = group(fields(canonicalBefore));
  const next = group(fields(canonicalAfter));
  const originals = group(source);
  const replacements = new Map();
  for (const name of new Set([...old.keys(), ...next.keys()])) {
    const before = old.get(name) ?? [];
    const after = next.get(name) ?? [];
    if (equal(encoded(before), encoded(after))) continue;
    const existing = originals.get(name) ?? [];
    const [number, wire] = name.split(':').map(Number);
    if (wire === 2 && Object.hasOwn(children, number) && before.length && after.length) {
      if (children[number].$key) {
        const oldKeys = keyed(before, children[number].$key);
        const rawKeys = keyed(existing, children[number].$key);
        const nextKeys = keyed(after, children[number].$key);
        const output = [];
        for (const [identity, value] of nextKeys) {
          const prior = oldKeys.get(identity);
          const raw = rawKeys.get(identity);
          if (prior && !raw) throw Object.assign(new Error('A bridge map entry is missing its original bytes.'), { code: 'JPT_PARSE_FAILED' });
          if (prior) output.push(ld(number, overlayKnownWire(raw.data, prior.data, value.data, children[number])));
          else if (!raw) output.push(value.raw);
          else throw Object.assign(new Error('A bridge map entry has an ambiguous original value.'), { code: 'JPT_PARSE_FAILED' });
        }
        for (const [identity, raw] of rawKeys) if (!oldKeys.has(identity)) {
          if (nextKeys.has(identity)) throw Object.assign(new Error('A bridge map key collides with unmodeled original data.'), { code: 'JPT_PARSE_FAILED' });
          output.push(raw.raw);
        }
        replacements.set(name, output);
        continue;
      }
      if (before.length !== after.length || existing.length !== before.length) {
        throw Object.assign(new Error('A changed bridge message cannot be aligned losslessly.'), { code: 'JPT_PARSE_FAILED' });
      }
      replacements.set(name, after.map((field, index) => ld(number,
        overlayKnownWire(existing[index].data, before[index].data, field.data, children[number]))));
    } else replacements.set(name, after.map(field => field.raw));
  }
  const output = [];
  const positions = new Map();
  for (const field of source) {
    const name = key(field);
    if (!replacements.has(name)) { output.push(field.raw); continue; }
    const replacement = replacements.get(name);
    const position = positions.get(name) ?? 0;
    if (replacement.length === originals.get(name).length) {
      output.push(replacement[position]);
    } else if (position === 0) output.push(...replacement);
    positions.set(name, position + 1);
  }
  for (const [name, replacement] of replacements) if (!originals.has(name)) output.push(...replacement);
  return concat(output);
}

// These paths are taken from the generated service codecs, never from payload guesses.
const contextTrack = { 3: { $key: 1 } };
const providedTrack = { 1: contextTrack };
const trackMetadata = { 1: { 1: {} }, 2: {}, 20: {} };
const listItem = { 4: trackMetadata, 17: {}, 21: {} };
const listData = { 1: listItem, 10: { 1: trackMetadata } };
export const NATIVE_WIRE_SCHEMAS = {
  metadata: { observe: { 1: { 3: {} } }, fetch: { 1: {} } },
  player: { getstate: { 7: providedTrack, 20: providedTrack, 21: providedTrack },
    getqueue: { 2: providedTrack, 3: providedTrack, 4: providedTrack }, getplayhistory: { 1: contextTrack } },
  list: { get: { 2: listData }, subscribe: { 2: listData } },
};
