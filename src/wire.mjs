// Lossless protobuf primitives; unknown fields retain their original bytes.
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
export const bytes = value => value instanceof Uint8Array ? value : value instanceof ArrayBuffer ? new Uint8Array(value) : encoder.encode(String(value ?? ''));
export function concat(...parts) {
  if (parts.length === 1 && Array.isArray(parts[0])) parts = parts[0];
  parts = parts.filter(Boolean).map(bytes);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
}
function varint(value) {
  let n = BigInt(value); if (n < 0n || n > 0xffffffffffffffffn) throw new RangeError('Invalid uint64');
  const out = [];
  do { const b = Number(n & 127n); n >>= 7n; out.push(b | (n ? 128 : 0)); } while (n);
  return Uint8Array.from(out);
}
export const vi = (field, value) => concat(varint(BigInt(field) << 3n), varint(value));
export const ld = (field, value) => { const data = bytes(value); return concat(varint((BigInt(field) << 3n) | 2n), varint(data.length), data); };
export function fields(input) {
  const data = bytes(input), out = []; let offset = 0;
  const read = () => {
    let n = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      if (offset >= data.length) throw new Error('Truncated protobuf varint');
      const b = data[offset++];
      if (shift === 63n && b > 1) throw new Error('Overflow protobuf varint');
      n |= BigInt(b & 127) << shift;
      if (!(b & 128)) return n;
    }
    throw new Error('Overflow protobuf varint');
  };
  while (offset < data.length) {
    const start = offset, tag = read(), field = Number(tag >> 3n), wire = Number(tag & 7n);
    if (!field || field > 0x1fffffff) throw new Error('Invalid protobuf field');
    const item = { field, wire };
    if (wire === 0) { const n = read(); item.value = n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n; item.varint = item.value; }
    else if (wire === 2) {
      const length = read();
      if (length > BigInt(data.length - offset)) throw new Error('Truncated protobuf bytes');
      item.data = data.subarray(offset, offset + Number(length)); offset += Number(length);
    } else if (wire === 1 || wire === 5) {
      const length = wire === 1 ? 8 : 4;
      if (offset + length > data.length) throw new Error('Truncated protobuf fixed field');
      item.data = data.subarray(offset, offset + length); offset += length;
    } else throw new Error('Unsupported protobuf wire type');
    item.raw = data.subarray(start, offset); out.push(item);
  }
  return out;
}
export function text(field) { if (field?.wire !== 2) return undefined; try { return decoder.decode(field.data); } catch { return undefined; } }
export function replaceString(input, number, value) {
  let written = false;
  const out = fields(input).map(f => { if (!written && f.field === number && f.wire === 2) { written = true; return ld(number, value); } return f.raw; });
  if (!written) out.push(ld(number, value));
  return concat(out);
}
const alphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
export function gidToURI(gid, type) {
  if (gid?.length !== 16) return undefined;
  let n = 0n; for (const b of gid) n = (n << 8n) | BigInt(b);
  let id = ''; for (let i = 0; i < 22; i++) { id = alphabet[Number(n % 62n)] + id; n /= 62n; }
  return `spotify:${type}:${id}`;
}
export function uriToGID(uri) {
  const id = String(uri).split(':').at(-1);
  if (!/^[0-9a-zA-Z]{22}$/.test(id)) throw new Error('Invalid Spotify ID');
  let n = 0n; for (const c of id) n = n * 62n + BigInt(alphabet.indexOf(c));
  if (n >= 1n << 128n) throw new Error('Spotify ID overflow');
  const gid = new Uint8Array(16); for (let i = 15; i >= 0; i--) { gid[i] = Number(n & 255n); n >>= 8n; }
  return gid;
}
function parseEntity(input, type) {
  const info = { name: '', uri: undefined };
  for (const f of fields(input)) {
    if (f.field === 1 && f.wire === 2 && f.data.length === 16) info.uri = gidToURI(f.data, type);
    else if (f.field === 2) info.name = text(f) ?? '';
  }
  return info;
}
export function parseTrack(input, uri) {
  const info = { uri, name: '', originalTitle: '', versionTitle: '', albumName: '', albumURI: undefined,
    artists: [], canonicalURI: undefined, isrc: undefined, duration: 0, number: 0, disc: 0, performanceLanguages: [] };
  for (const f of fields(input)) {
    if (f.wire === 0) { const key = { 5: 'number', 6: 'disc', 7: 'duration' }[f.field]; if (key) info[key] = f.value; continue; }
    if (f.wire !== 2) continue;
    const key = { 2: 'name', 27: 'originalTitle', 28: 'versionTitle', 36: 'canonicalURI' }[f.field];
    if (key) info[key] = text(f) ?? '';
    else if (f.field === 3 || f.field === 4) {
      // The iOS parser ignores malformed nested album/artist references.
      try { const entity = parseEntity(f.data, f.field === 3 ? 'album' : 'artist');
        if (f.field === 3) { info.albumName = entity.name; info.albumURI = entity.uri; }
        else if (entity.uri && fields(f.data).some(x => x.field === 2 && text(x) !== undefined)) info.artists.push(entity);
      } catch { /* Preserve the outer valid track. */ }
    } else if (f.field === 22) { const lang = text(f); if (lang) info.performanceLanguages.push(lang); }
    else if (f.field === 10) {
      let type, value; for (const x of fields(f.data)) { if (x.field === 1) type = text(x); if (x.field === 2) value = text(x); }
      if (type === 'isrc') info.isrc = value;
    }
  }
  return info;
}
export function parseAlbum(input, uri) {
  const info = { uri, name: '', originalTitle: '', originalURI: undefined, canonicalURI: undefined, tracks: [], complete: true };
  const tracks = new Set();
  for (const f of fields(input)) {
    if (f.field === 2) info.name = text(f) ?? '';
    else if (f.field === 18) info.originalTitle = text(f) ?? '';
    else if (f.field === 35) { const value = text(f); if (/^spotify:album:[0-9a-zA-Z]{22}$/.test(value ?? '')) info.originalURI = info.canonicalURI = value; }
    else if (f.field === 11 && f.wire === 2) for (const d of fields(f.data)) {
      if (d.field === 3 && d.wire === 2) { const track = parseEntity(d.data, 'track'); if (track.uri) tracks.add(track.uri); }
    }
  }
  info.tracks = [...tracks]; return info;
}
export function parseArtist(input, uri) { return { ...parseEntity(input, 'artist'), uri }; }
export function decodeMetadata(input) {
  const result = { entries: [], tracks: new Map(), albums: new Map(), artists: new Map() };
  for (const array of fields(input)) {
    if (array.field !== 2 || array.wire !== 2) continue;
    const parts = fields(array.data), kind = parts.find(f => f.field === 2 && f.wire === 0)?.value ?? 0;
    for (const part of parts) {
      if (part.field !== 3 || part.wire !== 2) continue;
      const entry = { uri: undefined, kind, status: 0, value: undefined, raw: part.raw };
      try {
        for (const f of fields(part.data)) {
          if (f.field === 1 && f.wire === 2) entry.status = fields(f.data).find(x => x.field === 1 && x.wire === 0)?.value ?? 0;
          else if (f.field === 2) entry.uri = text(f);
          else if (f.field === 3 && f.wire === 2) entry.value = fields(f.data).find(x => x.field === 2 && x.wire === 2)?.data;
        }
        if (entry.status === 200) {
          if (!entry.value) throw new Error('Missing metadata value');
          if (kind === 10) result.tracks.set(entry.uri, parseTrack(entry.value, entry.uri));
          else if (kind === 9) result.albums.set(entry.uri, parseAlbum(entry.value, entry.uri));
          else if (kind === 8) result.artists.set(entry.uri, parseArtist(entry.value, entry.uri));
        }
      } catch (error) { entry.parseError = error; }
      result.entries.push(entry);
    }
  }
  return result;
}
export function encodeRequest(entities, context) {
  const header = context instanceof Uint8Array ? context : context?.header;
  return concat(header ? ld(1, header) : null, ...entities.map(({ uri, kinds = [uri.startsWith('spotify:album:') ? 9 : uri.startsWith('spotify:artist:') ? 8 : 10] }) =>
    ld(2, concat(ld(1, uri), ...kinds.map(kind => ld(2, vi(1, kind)))))));
}
