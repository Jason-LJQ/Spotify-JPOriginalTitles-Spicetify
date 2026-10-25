import { decodeMetadata } from './wire.mjs';

export const hasCJK = value => /[\u1100-\u11ff\u3040-\u30ff\u3130-\u318f\u31f0-\u31ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\uff66-\uff9f]/.test(value ?? '');
export const japaneseNameCandidate = value => /[\u3040-\u309f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(value ?? '');
const isTrack = uri => /^spotify:track:[0-9a-zA-Z]{22}$/.test(uri ?? '');
const isAlbum = uri => /^spotify:album:[0-9a-zA-Z]{22}$/.test(uri ?? '');
const isArtist = uri => /^spotify:artist:[0-9a-zA-Z]{22}$/.test(uri ?? '');
const chunks = (list, size) => Array.from({ length: Math.ceil(list.length / size) }, (_, i) => list.slice(i * size, (i + 1) * size));
const unique = values => [...new Set(values)].filter(Boolean).sort();
const pick = (own, original) => !hasCJK(own) && hasCJK(original) ? original : own;
const romanizedCanonical = (uri, own) => isTrack(own?.canonicalURI) && own.canonicalURI !== uri && !hasCJK(own.name) ? own.canonicalURI : undefined;
const allowsSibling = track => !track.performanceLanguages?.length || track.performanceLanguages.some(l => ['ja', 'und', 'zxx'].includes(l));
const namedArtists = (track, names, authorities, aliases, preserveCJK = false) => track && { ...track, artists: (track.artists ?? []).map(a => {
  const authority = authorities?.get(a.uri), alias = aliases?.get(a.uri)?.name;
  const name = authority && !authority.name ? a.name : hasCJK(authority?.name) ? authority.name : alias || (authority?.name && !(preserveCJK && hasCJK(a.name)) ? authority.name : pick(a.name, names.get(a.uri)));
  return { ...a, name };
}) };
const safeArtistPositions = (own, original) => (own.artists ?? []).length === (original.artists ?? []).length
  && !(own.artists ?? []).some((v, i) => (original.artists ?? []).some((w, j) => i !== j && v.uri === w.uri));
function merge(own, original) {
  if (!own) return original;
  if (!original || original === own) return own;
  const out = { ...own, albumURI: own.albumURI ?? original.albumURI };
  for (const key of ['name', 'originalTitle', 'versionTitle', 'albumName']) out[key] = pick(own[key], original[key]);
  out.artists = own.artists.map(a => ({ ...a, name: pick(a.name, original.artists.find(b => b.uri === a.uri)?.name) }));
  return out;
}
function adopt(own, original, authorities, aliases) {
  const a = own.artists ?? [], b = original.artists ?? [];
  if (!safeArtistPositions(own, original)) return { ...original, uri: own.uri };
  return { ...original, uri: own.uri, artists: b.map((v, i) => {
    const authority = authorities?.get(a[i].uri), alias = aliases?.get(a[i].uri)?.name;
    const name = authority && !authority.name ? a[i].name : hasCJK(authority?.name) ? authority.name : authority ? alias || authority.name : alias || v.name;
    return { ...v, uri: a[i].uri, name };
  }) };
}
function preferredAlbum(uri, all) {
  const own = all.get(uri);
  if (!own?.tracks) return undefined;
  const linked = all.get(own.originalURI ?? own.canonicalURI);
  return !hasCJK(own.name) && linked?.tracks ? linked : own;
}
function albumOriginal(own, all) {
  if (!own || hasCJK(own.name) || !own.isrc || !own.duration || !own.number || !own.disc) return undefined;
  const album = preferredAlbum(own.albumURI, all);
  if (!album || !album.tracks.length || album.tracks.some(uri => !all.has(uri))) return undefined;
  const matches = album.tracks.map(uri => all.get(uri)).filter(t => t.isrc === own.isrc);
  const match = matches.length === 1 ? matches[0] : undefined;
  return match && hasCJK(match.name) && match.duration === own.duration && match.number === own.number && match.disc === own.disc ? match : undefined;
}
function directCompatible(own, target) {
  // A changed ISRC alone can describe a legitimate reissue. Two independent
  // recording contradictions reject the link without guessing from titles.
  return !(own?.isrc && target?.isrc && own.isrc !== target.isrc
    && own.duration && target.duration && own.duration !== target.duration);
}
function canonicalUnresolved(uri, own, all) {
  if (!own.canonicalURI || own.canonicalURI === uri) return true;
  const target = all.get(own.canonicalURI);
  return !!target && (!hasCJK(target.name) || !directCompatible(own, target));
}
function indirectOriginal(uri, own, all, reverse) {
  if (!own || hasCJK(own.name) || !own.isrc || !own.duration || !own.number || !own.disc || !canonicalUnresolved(uri, own, all)) return undefined;
  const link = own.canonicalURI || uri, albums = new Set();
  for (const candidateURI of reverse.get(uri) ?? []) { const album = all.get(candidateURI)?.albumURI; if (album) albums.add(album); }
  const source = all.get(own.albumURI);
  if (source?.tracks && (!source.originalURI || source.originalURI === own.albumURI)) for (const siblingURI of source.tracks) {
    const sibling = all.get(siblingURI), linked = all.get(sibling?.canonicalURI);
    if (linked?.albumURI && linked.albumURI !== own.albumURI) albums.add(linked.albumURI);
  }
  let match;
  for (const albumURI of albums) {
    const album = all.get(albumURI);
    if (!album?.tracks?.length || album.complete === false || album.tracks.some(t => !all.has(t))) continue;
    const matches = album.tracks.map(t => all.get(t)).filter(t => t.isrc === own.isrc);
    const candidate = matches.length === 1 ? matches[0] : undefined;
    if (!candidate || !hasCJK(candidate.name) || candidate.duration !== own.duration || candidate.number !== own.number || candidate.disc !== own.disc || candidate.canonicalURI !== link) continue;
    if (match && match !== candidate) return undefined;
    match = candidate;
  }
  return match;
}
function selectedOriginal(uri, own, all, reverse) {
  if (!own?.name) return undefined;
  const direct = all.get(romanizedCanonical(uri, own));
  if (direct && hasCJK(direct.name) && directCompatible(own, direct)) return direct;
  return albumOriginal(own, all) ?? indirectOriginal(uri, own, all, reverse);
}
function failure(message, uris, cause) {
  const error = new Error(message, cause ? { cause } : undefined); error.uris = [...uris]; return error;
}
function abortError() { const error = new Error('Lookup cancelled'); error.name = 'AbortError'; return error; }

export class Resolver {
  constructor({ request, store, isStrict = () => false, log = () => {}, scope = 'US:premium' }) {
    this.request = request; this.store = store; this.isStrict = isStrict; this.log = log;
    this.scope = `lookup-v1:zh-Hans,ja:${scope}`;
    this.cache = new Map(); this.clients = new Map(); this.reverse = new Map(); this.names = new Map(); this.artistAuthorities = new Map(); this.verifiedAliases = new Map(); this.observedUris = new Set();
    this.active = 0; this.queue = []; this.requests = 0; this.maxActive = 0; this.generation = 0;
    this.inFlight = new Map();
    this.dirty = { entities: new Map(), authorities: new Map(), aliases: new Map() };
    this.restore();
  }
  restore() {
    const saved = this.store?.getLookup?.(this.scope);
    for (const [uri, value] of saved?.entities ?? []) this.cache.set(uri, value);
    for (const [uri, value] of saved?.authorities ?? []) this.artistAuthorities.set(uri, value);
    for (const [uri, value] of saved?.aliases ?? []) this.verifiedAliases.set(uri, value);
    this.index(this.cache);
  }
  clear() {
    this.generation++;
    for (const operation of new Set(this.inFlight.values())) operation.controller.abort();
    this.inFlight.clear();
    for (const map of Object.values(this.dirty)) map.clear();
    this.cache.clear(); this.clients.clear(); this.reverse.clear(); this.names.clear(); this.artistAuthorities.clear(); this.verifiedAliases.clear(); this.observedUris.clear();
  }
  lookupChanges() {
    return { scope: this.scope, generation: this.generation,
      ...Object.fromEntries(Object.entries(this.dirty).map(([key, map]) => [key, new Map(map)])) };
  }
  didPersist(lookup) {
    if (lookup?.generation !== this.generation) return;
    for (const [type, pending] of Object.entries(this.dirty)) for (const [uri, value] of lookup[type]) {
      if (pending.get(uri) === value) pending.delete(uri);
    }
  }
  assertCurrent(result) { if (result.generation !== undefined && result.generation !== this.generation) throw abortError(); }
  stats() { return { cachedEntities: this.cache.size, clientEntities: this.clients.size, viewedEntities: this.observedUris.size, artistNames: this.names.size, verifiedAliases: this.verifiedAliases.size, active: this.active, queued: this.queue.length, requests: this.requests, maxActive: this.maxActive }; }
  index(map) {
    for (const [uri, track] of map) {
      if (!isTrack(uri) || !hasCJK(track.name) || !isTrack(track.canonicalURI) || track.canonicalURI === uri) continue;
      if (!this.reverse.has(track.canonicalURI)) this.reverse.set(track.canonicalURI, new Set());
      this.reverse.get(track.canonicalURI).add(uri);
    }
  }
  ingest(decoded) {
    const tracks = new Map();
    for (const map of [decoded.tracks, decoded.albums]) for (const [uri, raw] of map ?? []) {
      const previous = isTrack(uri) ? this.store?.getPreviousRecord?.(uri, 'title') : undefined;
      // Strip only an exact presentation proven by our persisted raw/current pair.
      const value = previous?.now && previous.value && raw.name === `${previous.now} - ${previous.value}` ? { ...raw, name: previous.now } : raw;
      this.clients.set(uri, value);
      if (isTrack(uri)) tracks.set(uri, value);
    }
    this.index(tracks);
  }
  async slot(context, callback) {
    if (this.active >= 3) await new Promise(resolve => this.queue.push(resolve));
    else this.active++;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      if (context.signal?.aborted || context.generation !== this.generation) throw abortError();
      const unused = context.unused?.();
      if (unused) { this.record(context, unused, true); throw unused; }
      if (context.stopped) throw context.stopped;
      this.requests++; return await callback();
    } catch (error) {
      if ([401, 403, 429].includes(error.status ?? error.statusCode) || error.name === 'AbortError' || error.offline) context.onRejected?.(error);
      throw error;
    } finally { if (this.queue.length) this.queue.shift()(); else this.active--; }
  }
  record(context, error, terminal = false) {
    if (!error) return;
    if (!context.failures.includes(error)) context.failures.push(error);
    if (terminal || this.isStrict()) context.stopped = error;
    context.onFailure?.(error, !!context.stopped);
  }
  async attempt(uris, language, context, artist) {
    const values = new Map(), retry = new Set(); let error, whole = false, terminal = false;
    if (context.stopped || context.signal?.aborted) {
      error = context.stopped ?? abortError(); this.record(context, error, true);
      return { values, retry: new Set(uris), error, whole: false, terminal: true };
    }
    try {
      const data = await this.slot(context, () => this.request(uris.map(uri => ({ uri, kinds: [artist ? 8 : isAlbum(uri) ? 9 : 10] })), language, context.signal));
      const decoded = decodeMetadata(data), seen = new Set();
      for (const entry of decoded.entries) {
        if (![8, 9, 10].includes(entry.kind)) continue;
        if (!entry.uri) { whole = true; continue; }
        if (!uris.includes(entry.uri) || entry.kind !== (artist ? 8 : isAlbum(entry.uri) ? 9 : 10)) continue;
        if (seen.has(entry.uri)) { retry.add(entry.uri); values.delete(entry.uri); continue; }
        seen.add(entry.uri);
        if ([401, 403, 429].includes(entry.status)) { retry.add(entry.uri); terminal = true; continue; }
        if ([204, 404, 410].includes(entry.status)) continue;
        const value = (artist ? decoded.artists : isAlbum(entry.uri) ? decoded.albums : decoded.tracks).get(entry.uri);
        if (entry.status === 200 && !entry.parseError && value) values.set(entry.uri, artist ? value.name : value);
        else retry.add(entry.uri);
      }
      for (const uri of uris) if (!seen.has(uri)) retry.add(uri);
      if (whole || retry.size || terminal) error = failure(terminal ? 'Lookup rejected' : whole ? 'Malformed lookup response' : 'Missing, duplicate or failed metadata entries', retry.size ? retry : uris);
    } catch (cause) {
      const status = cause.status ?? cause.statusCode;
      if ([204, 404, 410].includes(status)) return { values, retry, error: undefined, whole: false, terminal: false };
      terminal = [401, 403, 429].includes(status) || cause.name === 'AbortError' || cause.offline === true || cause.code === -1009 || cause.code === -999 || context.signal?.aborted || !!context.stopped;
      whole = true; error = failure('Metadata request failed', uris, cause); error.status = status;
    }
    if (whole) for (const uri of uris) retry.add(uri);
    if (terminal) this.record(context, error, true);
    if (!artist && !context.signal?.aborted && context.generation === this.generation) {
      for (const [uri, value] of values) { this.cache.set(uri, value); this.dirty.entities.set(uri, value); }
      this.index(values);
    }
    return { values, retry, error, whole, terminal };
  }
  async resolveAttempt(uris, language, context, artist) {
    const first = await this.attempt(uris, language, context, artist);
    if (!first.error || first.whole || first.terminal) return first;
    const second = await this.attempt([...first.retry].sort(), language, context, artist);
    for (const [uri, value] of second.values) first.values.set(uri, value);
    if (second.error) this.record(context, second.error, second.terminal);
    return { ...second, values: first.values, whole: false };
  }
  async split(parents, size, language, context, artist) {
    const batches = parents.flatMap(parent => chunks([...parent].sort(), size));
    const results = await Promise.all(batches.map(async batch => {
      const result = await this.resolveAttempt(batch, language, context, artist);
      if (size === 16 && result.whole && result.error) this.record(context, result.error);
      return result;
    }));
    const values = new Map(); for (const result of results) for (const [uri, value] of result.values) values.set(uri, value);
    const failed = results.flatMap((r, i) => r.whole && r.error ? [batches[i]] : []);
    const succeeded = results.some(r => !r.whole);
    const entryError = results.find(r => r.error && !r.whole)?.error;
    if (!context.stopped && succeeded && failed.length && size > 16) {
      const later = await this.split(failed, 16, language, context, artist);
      for (const [uri, value] of later.values) values.set(uri, value);
      return { values, error: entryError ?? later.error };
    }
    return { values, error: context.stopped ?? results.find(r => r.error)?.error };
  }
  async batch(uris, language, context, artist) {
    const first = await this.resolveAttempt(uris, language, context, artist);
    if (first.error && first.whole && !context.stopped) {
      const later = await this.split([uris], 64, language, context, artist);
      for (const [uri, value] of later.values) first.values.set(uri, value);
      first.error = later.error;
    }
    if (first.error) this.record(context, first.error);
    return first.values;
  }
  async query(wanted, context, { language = 'zh-Hans', artist = false, parallel = true, cached = true } = {}) {
    const uris = unique(wanted).filter(uri => (isTrack(uri) || isAlbum(uri) || isArtist(uri)) && (!cached || artist || !this.cache.has(uri)));
    const out = new Map(), batches = chunks(uris, 256);
    const run = async batch => {
      if (context.stopped) return;
      if (context.signal?.aborted || context.generation !== this.generation) { this.record(context, abortError(), true); return; }
      const operations = new Set(), missing = [];
      const key = uri => `${context.generation}:${language}:${artist ? 8 : isAlbum(uri) ? 9 : 10}:${uri}`;
      for (const uri of batch) {
        if (cached && !artist && this.cache.has(uri)) continue;
        const operation = this.inFlight.get(key(uri));
        if (operation) operations.add(operation); else missing.push(uri);
      }
      if (missing.length) {
        const controller = new AbortController();
        const shared = { signal: controller.signal, failures: [], stopped: undefined, generation: context.generation };
        const operation = { controller, consumers: new Set(), keys: missing.map(key), context: shared };
        shared.onFailure = (error, terminal) => {
          for (const consumer of operation.consumers) this.record(consumer.context, error, terminal);
        };
        shared.onRejected = error => { for (const consumer of operation.consumers) consumer.context.stopped = error; };
        shared.unused = () => [...operation.consumers].every(consumer => consumer.context.stopped || consumer.context.signal?.aborted)
          ? [...operation.consumers][0]?.context.stopped || abortError() : undefined;
        for (const name of operation.keys) this.inFlight.set(name, operation);
        operation.promise = Promise.resolve().then(() => this.batch(missing, language, shared, artist)).finally(() => {
          for (const name of operation.keys) if (this.inFlight.get(name) === operation) this.inFlight.delete(name);
        });
        operations.add(operation);
      }
      await Promise.all([...operations].map(async operation => {
        const consumer = { context };
        operation.consumers.add(consumer);
        let onAbort;
        const cancelled = new Promise((_, reject) => {
          onAbort = () => reject(abortError());
          context.signal?.addEventListener('abort', onAbort, { once: true });
          if (context.signal?.aborted) onAbort();
        });
        try {
          const values = await Promise.race([operation.promise, cancelled]);
          for (const error of operation.context.failures) this.record(context, error, operation.context.stopped === error);
          for (const [uri, value] of values) if (batch.includes(uri)) out.set(uri, value);
        } catch (error) { this.record(context, error, true); }
        finally {
          context.signal?.removeEventListener('abort', onAbort);
          operation.consumers.delete(consumer);
          if (!operation.consumers.size) {
            operation.controller.abort();
            for (const name of operation.keys) if (this.inFlight.get(name) === operation) this.inFlight.delete(name);
          }
        }
      }));
    };
    if (parallel) await Promise.all(batches.map(run));
    else for (const batch of batches) { await run(batch); if (context.stopped) break; }
    return out;
  }
  async associated(uris, context) {
    const albums = new Set();
    for (const uri of uris) {
      const track = this.cache.get(uri), direct = this.cache.get(romanizedCanonical(uri, track));
      if (isAlbum(uri)) albums.add(uri);
      else if (track && !hasCJK(track.name) && track.isrc && track.albumURI && !(direct && hasCJK(direct.name) && directCompatible(track, direct))) albums.add(track.albumURI);
    }
    await this.query(albums, context);
    const linked = [...albums].flatMap(uri => { const a = this.cache.get(uri); return a && !hasCJK(a.name) && isAlbum(a.originalURI) && a.originalURI !== uri ? [a.originalURI] : []; });
    await this.query(linked, context);
    const tracks = [...albums].flatMap(uri => { const a = preferredAlbum(uri, this.cache); return a ? a.tracks : []; });
    await this.query(tracks, context);
  }
  async indirect(uris, context) {
    await this.associated(uris, context);
    const sourceAlbums = new Set(), needed = new Set();
    for (const uri of uris) {
      const own = this.cache.get(uri), album = this.cache.get(own?.albumURI);
      if (!own || hasCJK(own.name) || !own.isrc || albumOriginal(own, this.cache) || !canonicalUnresolved(uri, own, this.cache)) continue;
      for (const candidate of this.reverse.get(uri) ?? []) needed.add(candidate);
      if (allowsSibling(own) && album?.tracks && (!album.originalURI || album.originalURI === own.albumURI)) {
        sourceAlbums.add(own.albumURI); for (const sibling of album.tracks) needed.add(sibling);
      }
    }
    await this.query(needed, context);
    const links = new Set();
    for (const albumURI of sourceAlbums) for (const uri of this.cache.get(albumURI).tracks) { const link = romanizedCanonical(uri, this.cache.get(uri)); if (link) links.add(link); }
    await this.query(links, context);
    const albums = new Set();
    for (const uri of links) { const album = this.cache.get(uri)?.albumURI; if (album) albums.add(album); }
    for (const uri of uris) for (const candidate of this.reverse.get(uri) ?? []) { const album = this.cache.get(candidate)?.albumURI; if (album) albums.add(album); }
    await this.query(albums, context);
    await this.query([...albums].flatMap(uri => this.cache.get(uri)?.tracks ?? []), context);
  }
  applyArtistAuthorities(names, wanted = new Set([...this.verifiedAliases.keys(), ...this.artistAuthorities.keys()])) {
    for (const uri of wanted) {
      const alias = this.verifiedAliases.get(uri), authority = this.artistAuthorities.get(uri);
      if (alias?.name) names.set(uri, alias.name);
      if (!authority) continue;
      if (!authority.name) names.delete(uri);
      else names.set(uri, hasCJK(authority.name) ? authority.name : this.verifiedAliases.get(uri)?.name || authority.name);
    }
  }
  learnVerifiedAliases(own, original) {
    const changed = new Set();
    if (!own?.isrc || own.isrc !== original?.isrc || !own.duration || own.duration !== original.duration || !safeArtistPositions(own, original)) return changed;
    for (let i = 0; i < own.artists.length; i++) {
      const source = own.artists[i], candidate = original.artists[i], authority = this.artistAuthorities.get(source.uri);
      if (hasCJK(source.name) || !hasCJK(candidate.name) || authority && (!authority.name || hasCJK(authority.name))) continue;
      const prior = this.verifiedAliases.get(source.uri);
      if (prior?.conflict) continue;
      if (prior && prior.name !== candidate.name) this.verifiedAliases.set(source.uri, { conflict: true });
      else if (!prior) this.verifiedAliases.set(source.uri, { name: candidate.name, sourceTrackURI: own.uri, originalTrackURI: original.uri, isrc: own.isrc, duration: own.duration });
      if (this.verifiedAliases.get(source.uri) !== prior) {
        changed.add(source.uri); this.dirty.aliases.set(source.uri, this.verifiedAliases.get(source.uri));
      }
    }
    return changed;
  }
  async artistOriginals(wanted, names, context) {
    // Legacy name strings alone are not independent identity evidence.
    const missing = unique(wanted).filter(uri => !this.artistAuthorities.get(uri)?.complete);
    const zh = await this.query(missing, context, { artist: true, parallel: false });
    if (context.stopped || context.generation !== this.generation) return;
    const japanese = [];
    for (const uri of missing) {
      if (!zh.has(uri)) continue;
      const name = zh.get(uri);
      this.artistAuthorities.set(uri, { name, language: 'zh-Hans', complete: !name || hasCJK(name) });
      this.dirty.authorities.set(uri, this.artistAuthorities.get(uri));
      if (name?.length && !hasCJK(name)) japanese.push(uri);
    }
    const ja = await this.query(japanese, context, { artist: true, language: 'ja', parallel: false });
    if (context.generation !== this.generation) return;
    for (const uri of japanese) {
      if (!ja.has(uri)) continue;
      const name = ja.get(uri);
      const authority = this.artistAuthorities.get(uri);
      this.artistAuthorities.set(uri, japaneseNameCandidate(name)
        ? { name, language: 'ja', complete: true }
        : { ...authority, complete: true });
      this.dirty.authorities.set(uri, this.artistAuthorities.get(uri));
    }
    this.applyArtistAuthorities(names);
  }
  async resolve(requested, { signal } = {}) {
    const uris = unique(requested).filter(uri => isTrack(uri) || isAlbum(uri) || isArtist(uri));
    for (const uri of uris) this.observedUris.add(uri);
    const context = { signal, failures: [], stopped: undefined, generation: this.generation };
    const names = new Map([...this.names, ...(this.store?.getArtistNames?.() ?? [])]);
    await this.query(uris.filter(uri => !isArtist(uri)), context, { parallel: false });
    const canonical = uris.map(uri => romanizedCanonical(uri, merge(this.clients.get(uri), this.cache.get(uri)))).filter(Boolean);
    await this.query(canonical, context, { parallel: false });
    await this.indirect(uris, context);
    const artists = new Set(uris.filter(isArtist));
    for (const uri of uris) {
      const own = this.cache.get(uri), original = selectedOriginal(uri, own, this.cache, this.reverse);
      for (const a of [...(own?.artists ?? []), ...(original?.artists ?? [])]) if (!hasCJK(a.name)) artists.add(a.uri);
    }
    await this.artistOriginals(artists, names, context);
    const tracks = new Map(), sourceTracks = new Map(), albums = new Map();
    for (const uri of uris) {
      if (isAlbum(uri)) { const album = preferredAlbum(uri, this.cache); if (album) albums.set(uri, { ...album, uri }); continue; }
      const own = merge(this.clients.get(uri), this.cache.get(uri));
      if (isTrack(uri) && own) sourceTracks.set(uri, own);
      if (!own?.name) continue;
      const original = selectedOriginal(uri, own, this.cache, this.reverse);
      const namedOriginal = namedArtists(original, names, this.artistAuthorities, this.verifiedAliases, true);
      this.applyArtistAuthorities(names, this.learnVerifiedAliases(own, namedOriginal));
      const preferred = namedArtists(namedOriginal ? adopt(own, namedOriginal, this.artistAuthorities, this.verifiedAliases) : own, names, this.artistAuthorities, this.verifiedAliases);
      tracks.set(uri, preferred);
    }
    if (context.generation !== this.generation) throw abortError();
    this.applyArtistAuthorities(names);
    this.names = new Map(names);
    return { tracks, sourceTracks, albums, artistNames: names, failures: context.failures, complete: !context.failures.length,
      generation: this.generation, lookup: this.lookupChanges() };
  }
}

export const selection = { merge, adopt, preferredAlbum, albumOriginal, indirectOriginal, selectedOriginal, canonicalUnresolved, allowsSibling, romanizedCanonical, directCompatible, safeArtistPositions };
