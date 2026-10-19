import { fields, ld, concat, replaceString, decodeMetadata, gidToURI, parseTrack, parseAlbum } from './wire.mjs';

const textDecoder = new TextDecoder('utf-8', { fatal: true });
const GROUP = 'Original Metadata';
const ROLES = { title: 'Title', artists: 'Artist', album: 'Album' };
const entityPattern = /^spotify:(track|album|artist):[A-Za-z0-9]+$/;
const hasText = value => typeof value === 'string' && value.length <= 4096 && value.trim().length > 0;
const entityURI = value => typeof value === 'string' && entityPattern.test(value) ? value : undefined;
const directURI = object => entityURI(object?.uri) || entityURI(object?.entityUri) || entityURI(object?.entityURI) || entityURI(object?.trackUri);
const contextualURI = (object, keyHint) => directURI(object) || (['trackMetadata', 'albumMetadata', 'artistMetadata', 'album', 'artist'].includes(keyHint) ? entityURI(object?.link) : undefined);
const mapGet = (map, key) => map instanceof Map ? map.get(key) : map?.[key];
const scalar = value => typeof value === 'object' && value !== null ? value.value : value;
const decode = field => field?.wire === 2 ? textDecoder.decode(field.data) : undefined;
const find = (bytes, number) => fields(bytes).find(field => field.field === number);
const stringAt = (bytes, number) => decode(find(bytes, number));
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const bytesEqual = (a, b) => a.length === b.length && a.every((value, i) => value === b[i]);
function draft(value) {
  if (!value || typeof value !== 'object' || ArrayBuffer.isView(value)) return { value, finish: () => value };
  let copy;
  const children = new Map();
  const current = () => copy || value;
  const writable = () => copy || (copy = Array.isArray(value) ? value.slice() : { ...value });
  const proxy = new Proxy(Array.isArray(value) ? [] : {}, {
    get(_, key) {
      const item = Reflect.get(current(), key);
      if (!item || typeof item !== 'object' || ArrayBuffer.isView(item)) return item;
      if (!children.has(key)) children.set(key, draft(item));
      return children.get(key).value;
    },
    set(_, key, item) {
      if (Reflect.get(current(), key) !== item) { writable()[key] = item; children.delete(key); }
      return true;
    },
    deleteProperty(_, key) { delete writable()[key]; children.delete(key); return true; },
    has: (_, key) => key in current(),
    ownKeys: () => Reflect.ownKeys(current()),
    getOwnPropertyDescriptor(_, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(current(), key);
      return descriptor && { ...descriptor, configurable: key !== 'length' || !Array.isArray(value) };
    }
  });
  return { value: proxy, finish() {
    for (const [key, child] of children) {
      const item = child.finish();
      if (item !== Reflect.get(current(), key)) writable()[key] = item;
    }
    return current();
  } };
}
function failure(code, message, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.code = code;
  error.strict = code !== 'JPT_STORAGE_FAILED';
  error.fatal = code === 'JPT_STORAGE_FAILED';
  return error;
}
function checkAbort(signal) {
  if (signal?.aborted) throw signal.reason || new DOMException('Aborted', 'AbortError');
}
function list(value) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.items)) return value.items;
  if (Array.isArray(value?.edges)) return value.edges.map(item => item.node ?? item);
  return [];
}
function artistList(object) {
  const value = object.artists ?? object.contributors ?? object.artist;
  if (value) return list(value).map(item => item.artist ?? item);
  return [...list(object.firstArtist), ...list(object.otherArtists)].map(item => item.artist ?? item);
}
function displayName(object) {
  if (typeof object?.name === 'string') return object.name;
  if (typeof object?.title === 'string') return object.title;
  return object?.profile?.name;
}
function setName(object, name) {
  if (!hasText(name)) return;
  if (typeof object.name === 'string') object.name = name;
  else if (typeof object.title === 'string') object.title = name;
  else if (typeof object.profile?.name === 'string') object.profile.name = name;
}
function previousNames(object) {
  const result = {};
  const name = displayName(object);
  if (name !== undefined) result.title = name;
  const album = object.albumOfTrack ?? object.album ?? object.contentHierarchyParent;
  if (album && displayName(album) !== undefined) result.album = displayName(album);
  const artists = artistList(object);
  if (artists.length) result.artists = artists.every(item => hasText(displayName(item))) ? artists.map(displayName) : [];
  return result;
}
function previousWire(bytes, kind) {
  if (kind === 128) {
    const title = stringAt(bytes, 1);
    return title === undefined ? {} : { title };
  }
  if (kind === 97) {
    const result = {};
    const title = stringAt(bytes, 2);
    if (title !== undefined) result.title = title;
    const artists = fields(bytes).filter(field => field.field === 8 && field.wire === 2).map(field => stringAt(field.data, 1));
    if (artists.length) result.artists = artists.every(hasText) ? artists : [];
    return result;
  }
  const identity = kind === 178;
  const result = {};
  for (const field of fields(bytes)) {
    if (field.wire !== 2) continue;
    if (field.field === 2) result.title = decode(field);
    if (field.field === (identity ? 4 : 3)) result.album = stringAt(field.data, identity ? 1 : 2);
  }
  const artists = fields(bytes).filter(field => field.field === (identity ? 5 : 4) && field.wire === 2)
    .map(field => stringAt(field.data, identity ? 1 : 2));
  if (artists.length) result.artists = artists.every(hasText) ? artists : [];
  return result;
}
function observationDeltas(observations) {
  const groups = new Map();
  const normalized = value => Array.isArray(value) ? value.every(hasText) ? value.join(', ') : '' : value;
  for (const item of observations) {
    const key = `${item.uri}|${item.field}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return [...groups.values()].map(items => {
    const rank = Math.max(...items.map(item => item.priority));
    const highest = items.filter(item => item.priority === rank);
    const finals = new Set(highest.map(item => normalized(item.now)));
    const changed = highest.filter(item => hasText(normalized(item.value)) && hasText(normalized(item.now)) && normalized(item.value) !== normalized(item.now));
    const originals = new Set(changed.map(item => normalized(item.value)));
    const chosen = changed[0] || highest[0];
    return { ...chosen, ...(finals.size > 1 || originals.size > 1 || highest.some(item => item.conflict) ? { conflict: true } : {}) };
  });
}
function capture(observations, uri, before, after, priority, previousTitle) {
  if (!uri?.startsWith('spotify:track:')) return;
  // A delivered combined title is presentation, never a new original value.
  if (hasText(previousTitle) && before.title === `${after.title} - ${previousTitle}`) before = { ...before, title: after.title };
  for (const field of ['title', 'artists', 'album']) {
    if (!(field in before) && !(field in after)) continue;
    const old = before[field] ?? (field === 'artists' ? [] : '');
    const now = after[field] ?? (field === 'artists' ? [] : '');
    observations.push({ uri, field, value: old, now, priority });
  }
}
function presentWireTitle(bytes, kind, uri, resolved, title) {
  if (!uri?.startsWith('spotify:track:') || !mapGet(resolved.tracks, uri) || ![10, 97, 128, 178].includes(kind)) return bytes;
  const field = kind === 128 ? 1 : 2;
  const old = stringAt(bytes, field);
  const name = title(uri, old);
  if (!hasText(old) || name === old) return bytes;
  let output = replaceString(bytes, field, name);
  if (kind === 97 && stringAt(bytes, 6) === old) output = replaceString(output, 6, name);
  return output;
}
function previousEntries(previous) {
  const result = [];
  for (const field of ['title', 'artists', 'album']) {
    let value = previous?.[field];
    if (Array.isArray(value)) value = value.every(hasText) ? value.join(', ') : '';
    if (hasText(value)) result.push({ name: value, role: ROLES[field], roleGroup: { name: GROUP } });
  }
  return result;
}
function addCredits(value, previous, graphQL = false) {
  const entries = previousEntries(previous);
  if (!entries.length) return;
  const container = graphQL ? value.contributors?.items : value.contributors;
  if (!Array.isArray(container)) return;
  for (const entry of entries) {
    if (container.some(item => !item.uri && !item.url && !item.reference?.uri && item.name === entry.name && item.role === entry.role && item.roleGroup?.name === GROUP)) continue;
    container.push(graphQL ? { ...entry, uri: null, url: null } : entry);
  }
}
function singularFields(bytes, numbers) {
  const items = fields(bytes);
  for (const number of numbers) if (items.filter(item => item.field === number).length > 1) throw new Error('Ambiguous singular protobuf field');
  return items;
}
function creditsWire(bytes, previous) {
  const parts = fields(bytes).map(field => field.raw);
  const known = new Set();
  for (const field of fields(bytes)) {
    if (field.field !== 1) continue;
    if (field.wire !== 2) throw new Error('Invalid credits contributor');
    const contributor = singularFields(field.data, [1, 2, 6]);
    for (const item of contributor) if ([1, 2, 6].includes(item.field) && item.wire !== 2) throw new Error('Invalid credits contributor field');
    if (contributor.some(item => item.field === 3 || item.field === 5)) continue;
    const group = find(field.data, 6);
    if (group?.wire === 2) singularFields(group.data, [1]);
    if (group?.wire === 2 && stringAt(group.data, 1) === GROUP) known.add(`${stringAt(field.data, 2)}|${stringAt(field.data, 1)}`);
  }
  for (const entry of previousEntries(previous)) {
    if (!known.has(`${entry.role}|${entry.name}`)) parts.push(ld(1, concat(ld(1, entry.name), ld(2, entry.role), ld(6, ld(1, GROUP)))));
  }
  return concat(parts);
}
function rewriteWireValue(bytes, kind, uri, resolved) {
  const preferred = mapGet(resolved.tracks, uri);
  const name = mapGet(resolved.artistNames, uri);
  const album = mapGet(resolved.albums, uri);
  if (kind === 128) {
    const selectedName = uri.startsWith('spotify:track:') ? preferred?.name : uri.startsWith('spotify:album:') ? album?.name : name;
    return hasText(selectedName) ? replaceString(bytes, 1, selectedName) : bytes;
  }
  if (kind === 97 && uri.startsWith('spotify:track:') && preferred) {
    const originalName = stringAt(bytes, 2);
    const source = mapGet(resolved.sourceTracks, uri);
    const children = fields(bytes).filter(field => field.field === 8 && field.wire === 2);
    const originalArtists = children.map(field => stringAt(field.data, 1));
    const complete = source?.artists?.length > 0 && children.length === source.artists.length && originalArtists.every((old, index) => hasText(old) && old === source.artists[index].name);
    const replacements = complete ? source.artists.map(artist => mapGet(resolved.artistNames, artist.uri) || preferred.artists?.find(item => item.uri === artist.uri)?.name || artist.name) : [];
    let index = 0;
    return concat(fields(bytes).map(field => {
      if (field.wire !== 2) return field.raw;
      if (field.field === 2 && hasText(preferred.name)) return ld(2, preferred.name);
      if (field.field === 6 && hasText(preferred.name) && decode(field) === originalName) return ld(6, preferred.name);
      if (complete && field.field === 8) return ld(8, replaceString(field.data, 1, replacements[index++]));
      if (complete && field.field === 3 && decode(field) === originalArtists.join(', ')) return ld(3, replacements.join(', '));
      return field.raw;
    }));
  }
  if (uri.startsWith('spotify:artist:') && [8, 97, 178].includes(kind) && hasText(name)) {
    const old = stringAt(bytes, 2);
    let output = replaceString(bytes, 2, name);
    if (kind === 97 && stringAt(bytes, 6) === old) output = replaceString(output, 6, name);
    return output;
  }
  if (uri.startsWith('spotify:album:') && [9, 178].includes(kind) && hasText(album?.name)) {
    let output = replaceString(bytes, 2, album.name);
    if (kind === 9 && hasText(album.originalTitle)) output = replaceString(output, 18, album.originalTitle);
    return output;
  }
  if (!preferred || ![10, 178].includes(kind)) return bytes;
  if (kind === 178) {
    const parts = [];
    for (const field of fields(bytes)) {
      if (field.field === 2 && hasText(preferred.name)) continue;
      if (field.field === 4 && hasText(preferred.albumName) && hasText(preferred.albumURI)) {
        parts.push(ld(4, replaceString(replaceString(field.data, 1, preferred.albumName), 2, preferred.albumURI)));
      } else if (field.field === 5 && preferred.artists?.length) continue;
      else parts.push(field.raw);
    }
    if (hasText(preferred.name)) parts.push(ld(2, preferred.name));
    if (preferred.artists?.length) for (const artist of preferred.artists) {
      const own = fields(bytes).find(field => field.field === 5 && field.wire === 2 && stringAt(field.data, 2) === artist.uri);
      const name = mapGet(resolved.artistNames, artist.uri) || artist.name;
      const contributor = own ? replaceString(own.data, 1, name) : concat(ld(1, name), ld(2, artist.uri));
      parts.push(ld(5, contributor));
    }
    return concat(parts);
  }
  return concat(fields(bytes).map(field => {
    if (field.wire !== 2) return field.raw;
    if (field.field === 2 && hasText(preferred.name)) return ld(2, preferred.name);
    if ([27, 28].includes(field.field) && hasText(preferred.originalTitle)) return ld(field.field, field.field === 27 ? preferred.originalTitle : preferred.versionTitle || '');
    if (field.field === 3 && hasText(preferred.albumName)) return ld(3, replaceString(field.data, 2, preferred.albumName));
    if ([4, 32].includes(field.field)) {
      // TRACK_V4 artist IDs stay intact; only URI-matched names are replaced.
      const artistURI = gidToURI(find(field.data, 1)?.data, 'artist');
      const selected = preferred.artists?.find(artist => artist.uri === artistURI);
      const selectedName = mapGet(resolved.artistNames, artistURI) || selected?.name;
      if (hasText(selectedName)) return ld(field.field, replaceString(field.data, 2, selectedName));
    }
    return field.raw;
  }));
}
function typedRewrite(object, uri, resolved, priority, observations, kind, previousTitle) {
  const before = previousNames(object);
  const preferred = mapGet(resolved.tracks, uri);
  if (uri.startsWith('spotify:track:') && preferred) {
    setName(object, preferred.name);
    if (kind === 97 && hasText(preferred.name) && object.title === before.title) object.title = preferred.name;
    for (const key of ['originalTitle', 'original_title']) if (key in object && hasText(preferred.originalTitle)) object[key] = preferred.originalTitle;
    for (const key of ['versionTitle', 'version_title']) if (key in object && hasText(preferred.originalTitle)) object[key] = preferred.versionTitle || '';
    const album = object.albumOfTrack ?? object.album ?? object.contentHierarchyParent;
    if (album && hasText(preferred.albumName)) {
      setName(album, preferred.albumName);
      // Typed IdentityTrait and GraphQL parents follow the adopted album URI.
      if (priority !== 2 && hasText(preferred.albumURI) && 'uri' in album) album.uri = preferred.albumURI;
    }
    const artists = artistList(object);
    for (const artist of artists) {
      const artistURI = contextualURI(artist, 'artist');
      const preferredArtist = preferred.artists?.find(item => item.uri === artistURI);
      setName(artist, mapGet(resolved.artistNames, artistURI) || preferredArtist?.name);
    }
  } else if (uri.startsWith('spotify:album:')) setName(object, mapGet(resolved.albums, uri)?.name);
  else if (uri.startsWith('spotify:artist:')) {
    const old = displayName(object);
    const name = mapGet(resolved.artistNames, uri);
    setName(object, name);
    if (kind === 97 && hasText(name) && object.title === old) object.title = name;
  }
  capture(observations, uri, before, previousNames(object), priority, previousTitle);
}

export function createTransformer({ resolver, store, isStrict = () => false, combineTitles = () => false, log = () => {} }) {
  const strict = () => typeof isStrict === 'function' ? isStrict() : !!isStrict;
  function presentation(getPrevious, resolved) {
    const combine = typeof combineTitles === 'function' ? combineTitles() : !!combineTitles;
    return (uri, name) => {
      const previous = getPrevious(uri)?.title;
      if (name !== mapGet(resolved.tracks, uri)?.name) return name;
      const joined = `${name} - ${previous}`;
      return combine && hasText(name) && hasText(previous) && name !== previous && hasText(joined) ? joined : name;
    };
  }
  async function resolve(uris, signal) {
    checkAbort(signal);
    try {
      const result = await resolver.resolve([...uris], { signal });
      checkAbort(signal);
      if (strict() && result.failures?.length) throw failure('JPT_LOOKUP_FAILED', 'Metadata lookup failed');
      return result;
    } catch (error) {
      if (error?.name === 'AbortError' || signal?.aborted || strict()) throw error?.code ? error : failure('JPT_LOOKUP_FAILED', 'Metadata lookup failed', error);
      log('lookup-failed', { code: error?.code || 'unknown' });
      return { tracks: new Map(), albums: new Map(), artistNames: new Map(), failures: [error] };
    }
  }
  async function commit(resolved, observations, signal, prepare) {
    checkAbort(signal);
    let preparationFailed = false;
    try {
      await store.commit({ artistNames: resolved.artistNames || new Map(), previous: observationDeltas(observations), lookup: resolved.lookup, prepare: async projected => {
        try {
          checkAbort(signal);
          resolver.assertCurrent?.(resolved);
          await prepare?.(projected);
          checkAbort(signal);
        } catch (error) { preparationFailed = true; throw error; }
      } });
      resolver.didPersist?.(resolved.lookup);
    } catch (error) {
      if (preparationFailed) throw error;
      throw failure('JPT_STORAGE_FAILED', 'Metadata storage transaction failed', error);
    }
    checkAbort(signal);
  }
  function parseGuard(operation, original) {
    try { return operation(); }
    catch (error) {
      if (strict()) throw failure('JPT_PARSE_FAILED', 'Metadata structure is invalid', error);
      log('parse-failed', { code: 'JPT_PARSE_FAILED' });
      return original;
    }
  }
  async function rewriteMetadata(bytes, { signal, validate } = {}) {
    let decoded;
    try { decoded = decodeMetadata(bytes); }
    catch (error) {
      if (strict()) throw failure('JPT_PARSE_FAILED', 'Metadata response is invalid', error);
      return bytes;
    }
    if (strict() && decoded.entries.some(entry => entry.parseError)) throw failure('JPT_PARSE_FAILED', 'Metadata entry is invalid');
    resolver.ingest?.(decoded);
    const uris = new Set(decoded.entries.filter(entry => entityURI(entry.uri)).map(entry => entry.uri));
    const resolved = await resolve(uris, signal);
    const observations = [];
    const output = parseGuard(() => concat(fields(bytes).map(arrayField => {
      if (arrayField.field !== 2 || arrayField.wire !== 2) return arrayField.raw;
      const kind = Number(find(arrayField.data, 2)?.value);
      return ld(2, concat(fields(arrayField.data).map(entryField => {
        if (entryField.field !== 3 || entryField.wire !== 2) return entryField.raw;
        return parseGuard(() => {
          if (kind === 186) {
            singularFields(entryField.data, [1, 2, 3]);
            const wrapper = find(entryField.data, 3);
            if (wrapper?.wire !== 2) throw new Error('Missing credits Any');
            singularFields(wrapper.data, [2]);
          }
          const uri = stringAt(entryField.data, 2);
          const header = find(entryField.data, 1);
          const status = header?.wire === 2 ? Number(find(header.data, 1)?.value) : 0;
          if (status !== 200 || !entityURI(uri)) return entryField.raw;
          const any = find(entryField.data, 3);
          if (any?.wire !== 2) throw new Error('Missing Any wrapper');
          const value = find(any.data, 2);
          if (value?.wire !== 2) throw new Error('Missing Any value');
          if (kind === 186) creditsWire(value.data, {});
          const rewritten = kind === 186 ? value.data : rewriteWireValue(value.data, kind, uri, resolved);
          if ([10, 97, 128, 178].includes(kind) && uri.startsWith('spotify:track:')) capture(observations, uri, previousWire(value.data, kind), previousWire(rewritten, kind), kind === 178 ? 3 : kind === 10 ? 2 : 1, store.getPrevious(uri)?.title);
          return ld(3, concat(fields(entryField.data).map(field => field.field === 3 && field.wire === 2 ? ld(3, concat(fields(any.data).map(item => item.field === 2 && item.wire === 2 ? ld(2, rewritten) : item.raw))) : field.raw)));
        }, entryField.raw);
      })));
    })), bytes);
    let finalOutput;
    await commit(resolved, observations, signal, async ({ getPrevious }) => {
    const title = presentation(getPrevious, resolved);
    // Credits and delivery validation use the transaction's projected values.
    finalOutput = parseGuard(() => concat(fields(output).map(arrayField => {
      if (arrayField.field !== 2 || arrayField.wire !== 2) return arrayField.raw;
      const kind = Number(find(arrayField.data, 2)?.value);
      if (![10, 97, 128, 178, 186].includes(kind)) return arrayField.raw;
      return ld(2, concat(fields(arrayField.data).map(entryField => {
        if (entryField.field !== 3 || entryField.wire !== 2) return entryField.raw;
        return parseGuard(() => {
          if (kind === 186) singularFields(entryField.data, [1, 2, 3]);
          const wrapper = find(entryField.data, 3);
          if (wrapper?.wire !== 2) throw new Error('Missing credits Any');
          if (kind === 186) singularFields(wrapper.data, [2]);
          const uri = stringAt(entryField.data, 2);
          const header = find(entryField.data, 1);
          if (Number(find(header?.data || new Uint8Array(), 1)?.value) !== 200) return entryField.raw;
          const any = find(entryField.data, 3);
          const value = find(any.data, 2);
          const rewritten = kind === 186 ? creditsWire(value.data, getPrevious(uri)) : presentWireTitle(value.data, kind, uri, resolved, title);
          if (bytesEqual(rewritten, value.data)) return entryField.raw;
          return ld(3, concat(fields(entryField.data).map(field => field.field === 3 && field.wire === 2 ? ld(3, concat(fields(any.data).map(item => item.field === 2 && item.wire === 2 ? ld(2, rewritten) : item.raw))) : field.raw)));
        }, entryField.raw);
      })));
    })), output);
    await validate?.(finalOutput);
    });
    return bytesEqual(bytes, finalOutput) ? bytes : finalOutput;
  }
  async function rewriteStructured(value, options = {}, mode = 'json') {
    const { signal, priority = mode === 'native' ? 3 : 1 } = options;
    const candidate = draft(value);
    const output = candidate.value;
    const uris = new Set();
    const native = { tracks: new Map(), albums: new Map() };
    const collect = (object, inheritedURI, inheritedKind, keyHint) => {
      if (!object || typeof object !== 'object' || object instanceof Uint8Array) return;
      if (Array.isArray(object)) { object.forEach(item => collect(item, inheritedURI, inheritedKind, keyHint)); return; }
      if (typeof object.uri === 'string' && object.uri.startsWith('spotify:local:')) return;
      if (object.entityUri && object.extensionKind !== undefined && typeof object.status === 'number' && ![1, 200].includes(object.status)) return;
      const uri = contextualURI(object, keyHint) || entityURI(keyHint) || inheritedURI;
      const kind = Number(scalar(object.extensionKind ?? object.extension_kind ?? object.kind) ?? inheritedKind) || undefined;
      const raw = object.value instanceof Uint8Array && (object.typeUrl || object.type_url) ? object.value : undefined;
      const displayCarrier = displayName(object) !== undefined || (mode === 'player' && object.metadata && ['title', 'album_title', 'artist_name'].some(key => key in object.metadata));
      // GraphQL track-list pointers contain no delivered name and need no lookup.
      if (uri && (displayCarrier || (mode === 'native' && (raw || object.extensionData || object.extensionResult)))) uris.add(uri);
      if (mode === 'native' && raw && uri && [9, 10].includes(kind)) parseGuard(() => {
        const info = kind === 10 ? parseTrack(raw, uri) : parseAlbum(raw, uri);
        (kind === 10 ? native.tracks : native.albums).set(uri, info);
      });
      for (const [key, item] of Object.entries(object)) {
        const nextKind = /^\d+$/.test(key) ? Number(key) : kind;
        collect(item, uri, nextKind, key);
      }
    };
    collect(value);
    if (mode === 'native') resolver.ingest?.(native);
    const suppliedURI = entityURI(options.uri || options.trackURI || options.trackUri);
    if (suppliedURI) uris.add(suppliedURI);
    const resolved = await resolve(uris, signal);
    const observations = [];
    const credits = [];
    const titles = [];
    const visit = (object, inheritedURI, inheritedKind, keyHint, suppressEntity = false) => {
      if (!object || typeof object !== 'object' || object instanceof Uint8Array) return;
      if (Array.isArray(object)) { object.forEach(item => visit(item, inheritedURI, inheritedKind, keyHint, suppressEntity)); return; }
      if (typeof object.uri === 'string' && object.uri.startsWith('spotify:local:')) return;
      if (object.entityUri && object.extensionKind !== undefined && typeof object.status === 'number' && ![1, 200].includes(object.status)) return;
      const uri = contextualURI(object, keyHint) || entityURI(keyHint) || inheritedURI;
      const kind = Number(scalar(object.extensionKind ?? object.extension_kind ?? object.kind) ?? inheritedKind) || undefined;
      if (uri && kind === 186 && object.extensionResult?.value instanceof Uint8Array) credits.push({ holder: object.extensionResult, uri, raw: true });
      if (uri && object.extensionResult?.value instanceof Uint8Array) {
        const raw = object.extensionResult.value;
        const rewritten = parseGuard(() => rewriteWireValue(raw, kind, uri, resolved), raw);
        if ([10, 97, 128, 178].includes(kind)) parseGuard(() => capture(observations, uri, previousWire(raw, kind), previousWire(rewritten, kind), kind === 178 ? 3 : kind === 10 ? 2 : 1, store.getPrevious(uri)?.title));
        object.extensionResult.value = bytesEqual(raw, rewritten) ? raw : rewritten;
        titles.push(title => { object.extensionResult.value = presentWireTitle(object.extensionResult.value, kind, uri, resolved, title); });
      }
      if (uri && object.value instanceof Uint8Array && (object.typeUrl || object.type_url)) {
        const inferredKind = kind || (/\.Track$/.test(object.typeUrl || object.type_url) ? 10 : undefined);
        const raw = object.value;
        const rewritten = parseGuard(() => rewriteWireValue(raw, inferredKind, uri, resolved), raw);
        if ([10, 97, 128, 178].includes(inferredKind)) parseGuard(() => capture(observations, uri, previousWire(raw, inferredKind), previousWire(rewritten, inferredKind), inferredKind === 178 ? 3 : inferredKind === 10 ? 2 : 1, store.getPrevious(uri)?.title));
        object.value = bytesEqual(raw, rewritten) ? raw : rewritten;
        titles.push(title => { object.value = presentWireTitle(object.value, inferredKind, uri, resolved, title); });
        if (inferredKind === 186) credits.push({ holder: object, uri, raw: true });
      }
      const suppliedTrackCarrier = suppliedURI?.startsWith('spotify:track:') && uri === suppliedURI && keyHint === 'trackUnion' && typeof displayName(object) === 'string';
      const isEntity = !!contextualURI(object, keyHint) || !!entityURI(keyHint) || suppliedTrackCarrier || (uri && (keyHint === 'extensionResult' || (kind && (object.name !== undefined || object.contributors))));
      if (isEntity && !suppressEntity && uri && kind !== 186) {
        typedRewrite(object, uri, resolved, kind === 178 ? 3 : kind === 10 || keyHint === 'trackMetadata' ? 2 : [97, 128].includes(kind) ? 1 : priority, observations, kind, store.getPrevious(uri)?.title);
        if (uri.startsWith('spotify:track:') && mapGet(resolved.tracks, uri)) titles.push(title => {
          const old = displayName(object);
          if (!hasText(old)) return;
          const name = title(uri, old);
          setName(object, name);
          if (kind === 97 && object.title === old) object.title = name;
        });
      }
      if (uri && object.creditsTrait) credits.push({ value: object.creditsTrait, uri, graphQL: true });
      if (uri && kind === 186 && Array.isArray(object.contributors)) credits.push({ value: object, uri });
      if (uri && mode === 'player' && object.metadata && typeof object.metadata === 'object') {
        rewritePlayerMap(object.metadata, uri, resolved, observations, store.getPrevious(uri)?.title);
        if (mapGet(resolved.tracks, uri) && hasText(object.metadata.title)) titles.push(title => { object.metadata.title = title(uri, object.metadata.title); });
      }
      for (const [key, item] of Object.entries(object)) {
        if (key === 'creditsTrait' || (key === 'metadata' && mode === 'player') || (kind === 186 && key === 'contributors')) continue;
        // A nested album/artist carries its own identity; unrelated parents never inherit a track identity.
        const nextKind = /^\d+$/.test(key) ? Number(key) : kind;
        const inherit = ['extensionResult', 'value', 'extensions', 'extension', 'extensionData', 'entities', 'items', 'item', 'trackMetadata', 'artistMetadata', 'albumMetadata', 'metadata', 'data', 'trackUnion', 'track', 'tracks', 'state', 'playerState', 'response'].includes(key) || /^\d+$/.test(key) || entityURI(key);
        const adoptedParent = isEntity && uri?.startsWith('spotify:track:') && mapGet(resolved.tracks, uri) && ['album', 'albumOfTrack', 'contentHierarchyParent'].includes(key);
        visit(item, inherit ? uri : undefined, nextKind, key, !!adoptedParent);
      }
    };
    visit(output, suppliedURI, undefined);
    let finalOutput;
    await commit(resolved, observations, signal, async ({ getPrevious }) => {
      const title = presentation(getPrevious, resolved);
      for (const apply of titles) parseGuard(() => apply(title));
      for (const item of credits) {
        if (item.raw) {
          const raw = item.holder.value;
          const rewritten = parseGuard(() => creditsWire(raw, getPrevious(item.uri)), raw);
          item.holder.value = bytesEqual(raw, rewritten) ? raw : rewritten;
        }
        else addCredits(item.value, getPrevious(item.uri), item.graphQL);
      }
      finalOutput = candidate.finish();
      await options.validate?.(finalOutput);
    });
    return finalOutput;
  }
  return {
    rewriteJSON: (value, options) => rewriteStructured(value, options, 'json'),
    rewriteNative: (value, options) => rewriteStructured(value, options, 'native'),
    rewritePlayer: (value, options) => rewriteStructured(value, options, 'player'),
    rewriteMetadata,
  };
}
function rewritePlayerMap(metadata, uri, resolved, observations, previousTitle) {
  const preferred = mapGet(resolved.tracks, uri);
  if (!preferred) return;
  const before = {}, after = {};
  for (const key of ['title', 'album_title']) if (key in metadata) before[key === 'title' ? 'title' : 'album'] = metadata[key];
  const artistKeys = Object.keys(metadata).filter(key => /^artist_name(?::\d+)?$/.test(key)).sort((a, b) => Number(a.split(':')[1] || 0) - Number(b.split(':')[1] || 0));
  if (artistKeys.length) before.artists = artistKeys.every(key => hasText(metadata[key])) ? artistKeys.map(key => metadata[key]) : [];
  if (hasText(preferred.name) && 'title' in metadata) metadata.title = preferred.name;
  if (hasText(preferred.albumName) && 'album_title' in metadata) metadata.album_title = preferred.albumName;
  if (hasText(preferred.originalTitle) && 'original_title' in metadata) metadata.original_title = preferred.originalTitle;
  if (hasText(preferred.originalTitle) && 'version_title' in metadata) metadata.version_title = preferred.versionTitle || '';
  for (const key of artistKeys) {
    const suffix = key.slice('artist_name'.length);
    const artistURI = metadata[`artist_uri${suffix}`];
    const artist = preferred.artists?.find(item => item.uri === artistURI);
    const name = mapGet(resolved.artistNames, artistURI) || artist?.name;
    if (hasText(name)) metadata[key] = name;
  }
  for (const key of ['title', 'album_title']) if (key in metadata) after[key === 'title' ? 'title' : 'album'] = metadata[key];
  if (artistKeys.length) after.artists = artistKeys.every(key => hasText(metadata[key])) ? artistKeys.map(key => metadata[key]) : [];
  capture(observations, uri, before, after, 1, previousTitle);
}
