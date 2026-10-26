// JP Original Title (Spicetify) v1.1.4
(() => {
  // src/wire.mjs
  var encoder = new TextEncoder();
  var decoder = new TextDecoder("utf-8", { fatal: true });
  var bytes = (value) => value instanceof Uint8Array ? value : value instanceof ArrayBuffer ? new Uint8Array(value) : encoder.encode(String(value ?? ""));
  function concat(...parts) {
    if (parts.length === 1 && Array.isArray(parts[0])) parts = parts[0];
    parts = parts.filter(Boolean).map(bytes);
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }
  function varint(value) {
    let n = BigInt(value);
    if (n < 0n || n > 0xffffffffffffffffn) throw new RangeError("Invalid uint64");
    const out = [];
    do {
      const b = Number(n & 127n);
      n >>= 7n;
      out.push(b | (n ? 128 : 0));
    } while (n);
    return Uint8Array.from(out);
  }
  var vi = (field, value) => concat(varint(BigInt(field) << 3n), varint(value));
  var ld = (field, value) => {
    const data = bytes(value);
    return concat(varint(BigInt(field) << 3n | 2n), varint(data.length), data);
  };
  function fields(input) {
    const data = bytes(input), out = [];
    let offset = 0;
    const read = () => {
      let n = 0n;
      for (let shift = 0n; shift < 70n; shift += 7n) {
        if (offset >= data.length) throw new Error("Truncated protobuf varint");
        const b = data[offset++];
        if (shift === 63n && b > 1) throw new Error("Overflow protobuf varint");
        n |= BigInt(b & 127) << shift;
        if (!(b & 128)) return n;
      }
      throw new Error("Overflow protobuf varint");
    };
    while (offset < data.length) {
      const start2 = offset, tag = read(), field = Number(tag >> 3n), wire = Number(tag & 7n);
      if (!field || field > 536870911) throw new Error("Invalid protobuf field");
      const item = { field, wire };
      if (wire === 0) {
        const n = read();
        item.value = n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n;
        item.varint = item.value;
      } else if (wire === 2) {
        const length = read();
        if (length > BigInt(data.length - offset)) throw new Error("Truncated protobuf bytes");
        item.data = data.subarray(offset, offset + Number(length));
        offset += Number(length);
      } else if (wire === 1 || wire === 5) {
        const length = wire === 1 ? 8 : 4;
        if (offset + length > data.length) throw new Error("Truncated protobuf fixed field");
        item.data = data.subarray(offset, offset + length);
        offset += length;
      } else throw new Error("Unsupported protobuf wire type");
      item.raw = data.subarray(start2, offset);
      out.push(item);
    }
    return out;
  }
  function text(field) {
    if (field?.wire !== 2) return void 0;
    try {
      return decoder.decode(field.data);
    } catch {
      return void 0;
    }
  }
  function replaceString(input, number, value) {
    let written = false;
    const out = fields(input).map((f) => {
      if (!written && f.field === number && f.wire === 2) {
        written = true;
        return ld(number, value);
      }
      return f.raw;
    });
    if (!written) out.push(ld(number, value));
    return concat(out);
  }
  var alphabet = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  function gidToURI(gid, type) {
    if (gid?.length !== 16) return void 0;
    let n = 0n;
    for (const b of gid) n = n << 8n | BigInt(b);
    let id = "";
    for (let i = 0; i < 22; i++) {
      id = alphabet[Number(n % 62n)] + id;
      n /= 62n;
    }
    return `spotify:${type}:${id}`;
  }
  function parseEntity(input, type) {
    const info = { name: "", uri: void 0 };
    for (const f of fields(input)) {
      if (f.field === 1 && f.wire === 2 && f.data.length === 16) info.uri = gidToURI(f.data, type);
      else if (f.field === 2) info.name = text(f) ?? "";
    }
    return info;
  }
  function parseTrack(input, uri) {
    const info = {
      uri,
      name: "",
      originalTitle: "",
      versionTitle: "",
      albumName: "",
      albumURI: void 0,
      artists: [],
      canonicalURI: void 0,
      isrc: void 0,
      duration: 0,
      number: 0,
      disc: 0,
      performanceLanguages: []
    };
    for (const f of fields(input)) {
      if (f.wire === 0) {
        const key3 = { 5: "number", 6: "disc", 7: "duration" }[f.field];
        if (key3) info[key3] = f.value;
        continue;
      }
      if (f.wire !== 2) continue;
      const key2 = { 2: "name", 27: "originalTitle", 28: "versionTitle", 36: "canonicalURI" }[f.field];
      if (key2) info[key2] = text(f) ?? "";
      else if (f.field === 3 || f.field === 4) {
        try {
          const entity = parseEntity(f.data, f.field === 3 ? "album" : "artist");
          if (f.field === 3) {
            info.albumName = entity.name;
            info.albumURI = entity.uri;
          } else if (entity.uri && fields(f.data).some((x) => x.field === 2 && text(x) !== void 0)) info.artists.push(entity);
        } catch {
        }
      } else if (f.field === 22) {
        const lang = text(f);
        if (lang) info.performanceLanguages.push(lang);
      } else if (f.field === 10) {
        let type, value;
        for (const x of fields(f.data)) {
          if (x.field === 1) type = text(x);
          if (x.field === 2) value = text(x);
        }
        if (type === "isrc") info.isrc = value;
      }
    }
    return info;
  }
  function parseAlbum(input, uri) {
    const info = { uri, name: "", originalTitle: "", originalURI: void 0, canonicalURI: void 0, tracks: [], complete: true };
    const tracks = /* @__PURE__ */ new Set();
    for (const f of fields(input)) {
      if (f.field === 2) info.name = text(f) ?? "";
      else if (f.field === 18) info.originalTitle = text(f) ?? "";
      else if (f.field === 35) {
        const value = text(f);
        if (/^spotify:album:[0-9a-zA-Z]{22}$/.test(value ?? "")) info.originalURI = info.canonicalURI = value;
      } else if (f.field === 11 && f.wire === 2) for (const d of fields(f.data)) {
        if (d.field === 3 && d.wire === 2) {
          const track = parseEntity(d.data, "track");
          if (track.uri) tracks.add(track.uri);
        }
      }
    }
    info.tracks = [...tracks];
    return info;
  }
  function parseArtist(input, uri) {
    return { ...parseEntity(input, "artist"), uri };
  }
  function decodeMetadata(input) {
    const result = { entries: [], tracks: /* @__PURE__ */ new Map(), albums: /* @__PURE__ */ new Map(), artists: /* @__PURE__ */ new Map() };
    for (const array of fields(input)) {
      if (array.field !== 2 || array.wire !== 2) continue;
      const parts = fields(array.data), kind = parts.find((f) => f.field === 2 && f.wire === 0)?.value ?? 0;
      for (const part of parts) {
        if (part.field !== 3 || part.wire !== 2) continue;
        const entry = { uri: void 0, kind, status: 0, value: void 0, raw: part.raw };
        try {
          for (const f of fields(part.data)) {
            if (f.field === 1 && f.wire === 2) entry.status = fields(f.data).find((x) => x.field === 1 && x.wire === 0)?.value ?? 0;
            else if (f.field === 2) entry.uri = text(f);
            else if (f.field === 3 && f.wire === 2) entry.value = fields(f.data).find((x) => x.field === 2 && x.wire === 2)?.data;
          }
          if (entry.status === 200) {
            if (!entry.value) throw new Error("Missing metadata value");
            if (kind === 10) result.tracks.set(entry.uri, parseTrack(entry.value, entry.uri));
            else if (kind === 9) result.albums.set(entry.uri, parseAlbum(entry.value, entry.uri));
            else if (kind === 8) result.artists.set(entry.uri, parseArtist(entry.value, entry.uri));
          }
        } catch (error) {
          entry.parseError = error;
        }
        result.entries.push(entry);
      }
    }
    return result;
  }
  function encodeRequest(entities, context) {
    const header = context instanceof Uint8Array ? context : context?.header;
    return concat(header ? ld(1, header) : null, ...entities.map(({ uri, kinds = [uri.startsWith("spotify:album:") ? 9 : uri.startsWith("spotify:artist:") ? 8 : 10] }) => ld(2, concat(ld(1, uri), ...kinds.map((kind) => ld(2, vi(1, kind)))))));
  }

  // src/resolver.mjs
  var hasCJK = (value) => /[\u1100-\u11ff\u3040-\u30ff\u3130-\u318f\u31f0-\u31ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\uff66-\uff9f]/.test(value ?? "");
  var japaneseNameCandidate = (value) => /[\u3040-\u309f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(value ?? "");
  var isTrack = (uri) => /^spotify:track:[0-9a-zA-Z]{22}$/.test(uri ?? "");
  var isAlbum = (uri) => /^spotify:album:[0-9a-zA-Z]{22}$/.test(uri ?? "");
  var isArtist = (uri) => /^spotify:artist:[0-9a-zA-Z]{22}$/.test(uri ?? "");
  var chunks = (list2, size) => Array.from({ length: Math.ceil(list2.length / size) }, (_, i) => list2.slice(i * size, (i + 1) * size));
  var unique = (values) => [...new Set(values)].filter(Boolean).sort();
  var pick = (own, original) => !hasCJK(own) && hasCJK(original) ? original : own;
  var romanizedCanonical = (uri, own) => isTrack(own?.canonicalURI) && own.canonicalURI !== uri && !hasCJK(own.name) ? own.canonicalURI : void 0;
  var allowsSibling = (track) => !track.performanceLanguages?.length || track.performanceLanguages.some((l) => ["ja", "und", "zxx"].includes(l));
  var namedArtists = (track, names, authorities, aliases, preserveCJK = false) => track && { ...track, artists: (track.artists ?? []).map((a) => {
    const authority = authorities?.get(a.uri), alias = aliases?.get(a.uri)?.name;
    const name = authority && !authority.name ? a.name : hasCJK(authority?.name) ? authority.name : alias || (authority?.name && !(preserveCJK && hasCJK(a.name)) ? authority.name : pick(a.name, names.get(a.uri)));
    return { ...a, name };
  }) };
  var safeArtistPositions = (own, original) => (own.artists ?? []).length === (original.artists ?? []).length && !(own.artists ?? []).some((v, i) => (original.artists ?? []).some((w, j) => i !== j && v.uri === w.uri));
  function merge(own, original) {
    if (!own) return original;
    if (!original || original === own) return own;
    const out = { ...own, albumURI: own.albumURI ?? original.albumURI };
    for (const key2 of ["name", "originalTitle", "versionTitle", "albumName"]) out[key2] = pick(own[key2], original[key2]);
    out.artists = own.artists.map((a) => ({ ...a, name: pick(a.name, original.artists.find((b) => b.uri === a.uri)?.name) }));
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
    if (!own?.tracks) return void 0;
    const linked = all.get(own.originalURI ?? own.canonicalURI);
    return !hasCJK(own.name) && linked?.tracks ? linked : own;
  }
  function albumOriginal(own, all) {
    if (!own || hasCJK(own.name) || !own.isrc || !own.duration || !own.number || !own.disc) return void 0;
    const album = preferredAlbum(own.albumURI, all);
    if (!album || !album.tracks.length || album.tracks.some((uri) => !all.has(uri))) return void 0;
    const matches = album.tracks.map((uri) => all.get(uri)).filter((t) => t.isrc === own.isrc);
    const match = matches.length === 1 ? matches[0] : void 0;
    return match && hasCJK(match.name) && match.duration === own.duration && match.number === own.number && match.disc === own.disc ? match : void 0;
  }
  function directCompatible(own, target) {
    return !(own?.isrc && target?.isrc && own.isrc !== target.isrc && own.duration && target.duration && own.duration !== target.duration);
  }
  function canonicalUnresolved(uri, own, all) {
    if (!own.canonicalURI || own.canonicalURI === uri) return true;
    const target = all.get(own.canonicalURI);
    return !!target && (!hasCJK(target.name) || !directCompatible(own, target));
  }
  function indirectOriginal(uri, own, all, reverse) {
    if (!own || hasCJK(own.name) || !own.isrc || !own.duration || !own.number || !own.disc || !canonicalUnresolved(uri, own, all)) return void 0;
    const link = own.canonicalURI || uri, albums = /* @__PURE__ */ new Set();
    for (const candidateURI of reverse.get(uri) ?? []) {
      const album = all.get(candidateURI)?.albumURI;
      if (album) albums.add(album);
    }
    const source = all.get(own.albumURI);
    if (source?.tracks && (!source.originalURI || source.originalURI === own.albumURI)) for (const siblingURI of source.tracks) {
      const sibling = all.get(siblingURI), linked = all.get(sibling?.canonicalURI);
      if (linked?.albumURI && linked.albumURI !== own.albumURI) albums.add(linked.albumURI);
    }
    let match;
    for (const albumURI of albums) {
      const album = all.get(albumURI);
      if (!album?.tracks?.length || album.complete === false || album.tracks.some((t) => !all.has(t))) continue;
      const matches = album.tracks.map((t) => all.get(t)).filter((t) => t.isrc === own.isrc);
      const candidate = matches.length === 1 ? matches[0] : void 0;
      if (!candidate || !hasCJK(candidate.name) || candidate.duration !== own.duration || candidate.number !== own.number || candidate.disc !== own.disc || candidate.canonicalURI !== link) continue;
      if (match && match !== candidate) return void 0;
      match = candidate;
    }
    return match;
  }
  function selectedOriginal(uri, own, all, reverse) {
    if (!own?.name) return void 0;
    const direct = all.get(romanizedCanonical(uri, own));
    if (direct && hasCJK(direct.name) && directCompatible(own, direct)) return direct;
    return albumOriginal(own, all) ?? indirectOriginal(uri, own, all, reverse);
  }
  function failure(message, uris, cause) {
    const error = new Error(message, cause ? { cause } : void 0);
    error.uris = [...uris];
    return error;
  }
  function abortError() {
    const error = new Error("Lookup cancelled");
    error.name = "AbortError";
    return error;
  }
  var Resolver = class {
    constructor({ request, store, isStrict = () => false, log = () => {
    }, scope = "US:premium" }) {
      this.request = request;
      this.store = store;
      this.isStrict = isStrict;
      this.log = log;
      this.scope = `lookup-v1:zh-Hans,ja:${scope}`;
      this.cache = /* @__PURE__ */ new Map();
      this.clients = /* @__PURE__ */ new Map();
      this.reverse = /* @__PURE__ */ new Map();
      this.names = /* @__PURE__ */ new Map();
      this.artistAuthorities = /* @__PURE__ */ new Map();
      this.verifiedAliases = /* @__PURE__ */ new Map();
      this.observedUris = /* @__PURE__ */ new Set();
      this.active = 0;
      this.queue = [];
      this.requests = 0;
      this.maxActive = 0;
      this.generation = 0;
      this.inFlight = /* @__PURE__ */ new Map();
      this.dirty = { entities: /* @__PURE__ */ new Map(), authorities: /* @__PURE__ */ new Map(), aliases: /* @__PURE__ */ new Map() };
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
      this.cache.clear();
      this.clients.clear();
      this.reverse.clear();
      this.names.clear();
      this.artistAuthorities.clear();
      this.verifiedAliases.clear();
      this.observedUris.clear();
    }
    lookupChanges() {
      return {
        scope: this.scope,
        generation: this.generation,
        ...Object.fromEntries(Object.entries(this.dirty).map(([key2, map]) => [key2, new Map(map)]))
      };
    }
    didPersist(lookup) {
      if (lookup?.generation !== this.generation) return;
      for (const [type, pending] of Object.entries(this.dirty)) for (const [uri, value] of lookup[type]) {
        if (pending.get(uri) === value) pending.delete(uri);
      }
    }
    assertCurrent(result) {
      if (result.generation !== void 0 && result.generation !== this.generation) throw abortError();
    }
    stats() {
      return { cachedEntities: this.cache.size, clientEntities: this.clients.size, viewedEntities: this.observedUris.size, artistNames: this.names.size, verifiedAliases: this.verifiedAliases.size, active: this.active, queued: this.queue.length, requests: this.requests, maxActive: this.maxActive };
    }
    index(map) {
      for (const [uri, track] of map) {
        if (!isTrack(uri) || !hasCJK(track.name) || !isTrack(track.canonicalURI) || track.canonicalURI === uri) continue;
        if (!this.reverse.has(track.canonicalURI)) this.reverse.set(track.canonicalURI, /* @__PURE__ */ new Set());
        this.reverse.get(track.canonicalURI).add(uri);
      }
    }
    ingest(decoded) {
      const tracks = /* @__PURE__ */ new Map();
      for (const map of [decoded.tracks, decoded.albums]) for (const [uri, raw] of map ?? []) {
        const previous = isTrack(uri) ? this.store?.getPreviousRecord?.(uri, "title") : void 0;
        const combined = previous?.now && previous.value && [`${previous.now}\uFF5C${previous.value}`, `${previous.now} - ${previous.value}`].includes(raw.name);
        const value = combined ? { ...raw, name: previous.now } : raw;
        this.clients.set(uri, value);
        if (isTrack(uri)) tracks.set(uri, value);
      }
      this.index(tracks);
    }
    async slot(context, callback) {
      if (this.active >= 3) await new Promise((resolve) => this.queue.push(resolve));
      else this.active++;
      this.maxActive = Math.max(this.maxActive, this.active);
      try {
        if (context.signal?.aborted || context.generation !== this.generation) throw abortError();
        const unused = context.unused?.();
        if (unused) {
          this.record(context, unused, true);
          throw unused;
        }
        if (context.stopped) throw context.stopped;
        this.requests++;
        return await callback();
      } catch (error) {
        if ([401, 403, 429].includes(error.status ?? error.statusCode) || error.name === "AbortError" || error.offline) context.onRejected?.(error);
        throw error;
      } finally {
        if (this.queue.length) this.queue.shift()();
        else this.active--;
      }
    }
    record(context, error, terminal = false) {
      if (!error) return;
      if (!context.failures.includes(error)) context.failures.push(error);
      if (terminal || this.isStrict()) context.stopped = error;
      context.onFailure?.(error, !!context.stopped);
    }
    async attempt(uris, language, context, artist) {
      const values = /* @__PURE__ */ new Map(), retry = /* @__PURE__ */ new Set();
      let error, whole = false, terminal = false;
      if (context.stopped || context.signal?.aborted) {
        error = context.stopped ?? abortError();
        this.record(context, error, true);
        return { values, retry: new Set(uris), error, whole: false, terminal: true };
      }
      try {
        const data = await this.slot(context, () => this.request(uris.map((uri) => ({ uri, kinds: [artist ? 8 : isAlbum(uri) ? 9 : 10] })), language, context.signal));
        const decoded = decodeMetadata(data), seen = /* @__PURE__ */ new Set();
        for (const entry of decoded.entries) {
          if (![8, 9, 10].includes(entry.kind)) continue;
          if (!entry.uri) {
            whole = true;
            continue;
          }
          if (!uris.includes(entry.uri) || entry.kind !== (artist ? 8 : isAlbum(entry.uri) ? 9 : 10)) continue;
          if (seen.has(entry.uri)) {
            retry.add(entry.uri);
            values.delete(entry.uri);
            continue;
          }
          seen.add(entry.uri);
          if ([401, 403, 429].includes(entry.status)) {
            retry.add(entry.uri);
            terminal = true;
            continue;
          }
          if ([204, 404, 410].includes(entry.status)) continue;
          const value = (artist ? decoded.artists : isAlbum(entry.uri) ? decoded.albums : decoded.tracks).get(entry.uri);
          if (entry.status === 200 && !entry.parseError && value) values.set(entry.uri, artist ? value.name : value);
          else retry.add(entry.uri);
        }
        for (const uri of uris) if (!seen.has(uri)) retry.add(uri);
        if (whole || retry.size || terminal) error = failure(terminal ? "Lookup rejected" : whole ? "Malformed lookup response" : "Missing, duplicate or failed metadata entries", retry.size ? retry : uris);
      } catch (cause) {
        const status = cause.status ?? cause.statusCode;
        if ([204, 404, 410].includes(status)) return { values, retry, error: void 0, whole: false, terminal: false };
        terminal = [401, 403, 429].includes(status) || cause.name === "AbortError" || cause.offline === true || cause.code === -1009 || cause.code === -999 || context.signal?.aborted || !!context.stopped;
        whole = true;
        error = failure("Metadata request failed", uris, cause);
        error.status = status;
      }
      if (whole) for (const uri of uris) retry.add(uri);
      if (terminal) this.record(context, error, true);
      if (!artist && !context.signal?.aborted && context.generation === this.generation) {
        for (const [uri, value] of values) {
          this.cache.set(uri, value);
          this.dirty.entities.set(uri, value);
        }
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
      const batches = parents.flatMap((parent) => chunks([...parent].sort(), size));
      const results = await Promise.all(batches.map(async (batch) => {
        const result = await this.resolveAttempt(batch, language, context, artist);
        if (size === 16 && result.whole && result.error) this.record(context, result.error);
        return result;
      }));
      const values = /* @__PURE__ */ new Map();
      for (const result of results) for (const [uri, value] of result.values) values.set(uri, value);
      const failed = results.flatMap((r, i) => r.whole && r.error ? [batches[i]] : []);
      const succeeded = results.some((r) => !r.whole);
      const entryError = results.find((r) => r.error && !r.whole)?.error;
      if (!context.stopped && succeeded && failed.length && size > 16) {
        const later = await this.split(failed, 16, language, context, artist);
        for (const [uri, value] of later.values) values.set(uri, value);
        return { values, error: entryError ?? later.error };
      }
      return { values, error: context.stopped ?? results.find((r) => r.error)?.error };
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
    async query(wanted, context, { language = "zh-Hans", artist = false, parallel = true, cached = true } = {}) {
      const uris = unique(wanted).filter((uri) => (isTrack(uri) || isAlbum(uri) || isArtist(uri)) && (!cached || artist || !this.cache.has(uri)));
      const out = /* @__PURE__ */ new Map(), batches = chunks(uris, 256);
      const run = async (batch) => {
        if (context.stopped) return;
        if (context.signal?.aborted || context.generation !== this.generation) {
          this.record(context, abortError(), true);
          return;
        }
        const operations = /* @__PURE__ */ new Set(), missing = [];
        const key2 = (uri) => `${context.generation}:${language}:${artist ? 8 : isAlbum(uri) ? 9 : 10}:${uri}`;
        for (const uri of batch) {
          if (cached && !artist && this.cache.has(uri)) continue;
          const operation = this.inFlight.get(key2(uri));
          if (operation) operations.add(operation);
          else missing.push(uri);
        }
        if (missing.length) {
          const controller = new AbortController();
          const shared = { signal: controller.signal, failures: [], stopped: void 0, generation: context.generation };
          const operation = { controller, consumers: /* @__PURE__ */ new Set(), keys: missing.map(key2), context: shared };
          shared.onFailure = (error, terminal) => {
            for (const consumer of operation.consumers) this.record(consumer.context, error, terminal);
          };
          shared.onRejected = (error) => {
            for (const consumer of operation.consumers) consumer.context.stopped = error;
          };
          shared.unused = () => [...operation.consumers].every((consumer) => consumer.context.stopped || consumer.context.signal?.aborted) ? [...operation.consumers][0]?.context.stopped || abortError() : void 0;
          for (const name of operation.keys) this.inFlight.set(name, operation);
          operation.promise = Promise.resolve().then(() => this.batch(missing, language, shared, artist)).finally(() => {
            for (const name of operation.keys) if (this.inFlight.get(name) === operation) this.inFlight.delete(name);
          });
          operations.add(operation);
        }
        await Promise.all([...operations].map(async (operation) => {
          const consumer = { context };
          operation.consumers.add(consumer);
          let onAbort;
          const cancelled = new Promise((_, reject) => {
            onAbort = () => reject(abortError());
            context.signal?.addEventListener("abort", onAbort, { once: true });
            if (context.signal?.aborted) onAbort();
          });
          try {
            const values = await Promise.race([operation.promise, cancelled]);
            for (const error of operation.context.failures) this.record(context, error, operation.context.stopped === error);
            for (const [uri, value] of values) if (batch.includes(uri)) out.set(uri, value);
          } catch (error) {
            this.record(context, error, true);
          } finally {
            context.signal?.removeEventListener("abort", onAbort);
            operation.consumers.delete(consumer);
            if (!operation.consumers.size) {
              operation.controller.abort();
              for (const name of operation.keys) if (this.inFlight.get(name) === operation) this.inFlight.delete(name);
            }
          }
        }));
      };
      if (parallel) await Promise.all(batches.map(run));
      else for (const batch of batches) {
        await run(batch);
        if (context.stopped) break;
      }
      return out;
    }
    async associated(uris, context) {
      const albums = /* @__PURE__ */ new Set();
      for (const uri of uris) {
        const track = this.cache.get(uri), direct = this.cache.get(romanizedCanonical(uri, track));
        if (isAlbum(uri)) albums.add(uri);
        else if (track && !hasCJK(track.name) && track.isrc && track.albumURI && !(direct && hasCJK(direct.name) && directCompatible(track, direct))) albums.add(track.albumURI);
      }
      await this.query(albums, context);
      const linked = [...albums].flatMap((uri) => {
        const a = this.cache.get(uri);
        return a && !hasCJK(a.name) && isAlbum(a.originalURI) && a.originalURI !== uri ? [a.originalURI] : [];
      });
      await this.query(linked, context);
      const tracks = [...albums].flatMap((uri) => {
        const a = preferredAlbum(uri, this.cache);
        return a ? a.tracks : [];
      });
      await this.query(tracks, context);
    }
    async indirect(uris, context) {
      await this.associated(uris, context);
      const sourceAlbums = /* @__PURE__ */ new Set(), needed = /* @__PURE__ */ new Set();
      for (const uri of uris) {
        const own = this.cache.get(uri), album = this.cache.get(own?.albumURI);
        if (!own || hasCJK(own.name) || !own.isrc || albumOriginal(own, this.cache) || !canonicalUnresolved(uri, own, this.cache)) continue;
        for (const candidate of this.reverse.get(uri) ?? []) needed.add(candidate);
        if (allowsSibling(own) && album?.tracks && (!album.originalURI || album.originalURI === own.albumURI)) {
          sourceAlbums.add(own.albumURI);
          for (const sibling of album.tracks) needed.add(sibling);
        }
      }
      await this.query(needed, context);
      const links = /* @__PURE__ */ new Set();
      for (const albumURI of sourceAlbums) for (const uri of this.cache.get(albumURI).tracks) {
        const link = romanizedCanonical(uri, this.cache.get(uri));
        if (link) links.add(link);
      }
      await this.query(links, context);
      const albums = /* @__PURE__ */ new Set();
      for (const uri of links) {
        const album = this.cache.get(uri)?.albumURI;
        if (album) albums.add(album);
      }
      for (const uri of uris) for (const candidate of this.reverse.get(uri) ?? []) {
        const album = this.cache.get(candidate)?.albumURI;
        if (album) albums.add(album);
      }
      await this.query(albums, context);
      await this.query([...albums].flatMap((uri) => this.cache.get(uri)?.tracks ?? []), context);
    }
    applyArtistAuthorities(names, wanted = /* @__PURE__ */ new Set([...this.verifiedAliases.keys(), ...this.artistAuthorities.keys()])) {
      for (const uri of wanted) {
        const alias = this.verifiedAliases.get(uri), authority = this.artistAuthorities.get(uri);
        if (alias?.name) names.set(uri, alias.name);
        if (!authority) continue;
        if (!authority.name) names.delete(uri);
        else names.set(uri, hasCJK(authority.name) ? authority.name : this.verifiedAliases.get(uri)?.name || authority.name);
      }
    }
    learnVerifiedAliases(own, original) {
      const changed = /* @__PURE__ */ new Set();
      if (!own?.isrc || own.isrc !== original?.isrc || !own.duration || own.duration !== original.duration || !safeArtistPositions(own, original)) return changed;
      for (let i = 0; i < own.artists.length; i++) {
        const source = own.artists[i], candidate = original.artists[i], authority = this.artistAuthorities.get(source.uri);
        if (hasCJK(source.name) || !hasCJK(candidate.name) || authority && (!authority.name || hasCJK(authority.name))) continue;
        const prior = this.verifiedAliases.get(source.uri);
        if (prior?.conflict) continue;
        if (prior && prior.name !== candidate.name) this.verifiedAliases.set(source.uri, { conflict: true });
        else if (!prior) this.verifiedAliases.set(source.uri, { name: candidate.name, sourceTrackURI: own.uri, originalTrackURI: original.uri, isrc: own.isrc, duration: own.duration });
        if (this.verifiedAliases.get(source.uri) !== prior) {
          changed.add(source.uri);
          this.dirty.aliases.set(source.uri, this.verifiedAliases.get(source.uri));
        }
      }
      return changed;
    }
    async artistOriginals(wanted, names, context) {
      const missing = unique(wanted).filter((uri) => !this.artistAuthorities.get(uri)?.complete);
      const zh = await this.query(missing, context, { artist: true, parallel: false });
      if (context.stopped || context.generation !== this.generation) return;
      const japanese = [];
      for (const uri of missing) {
        if (!zh.has(uri)) continue;
        const name = zh.get(uri);
        this.artistAuthorities.set(uri, { name, language: "zh-Hans", complete: !name || hasCJK(name) });
        this.dirty.authorities.set(uri, this.artistAuthorities.get(uri));
        if (name?.length && !hasCJK(name)) japanese.push(uri);
      }
      const ja = await this.query(japanese, context, { artist: true, language: "ja", parallel: false });
      if (context.generation !== this.generation) return;
      for (const uri of japanese) {
        if (!ja.has(uri)) continue;
        const name = ja.get(uri);
        const authority = this.artistAuthorities.get(uri);
        this.artistAuthorities.set(uri, japaneseNameCandidate(name) ? { name, language: "ja", complete: true } : { ...authority, complete: true });
        this.dirty.authorities.set(uri, this.artistAuthorities.get(uri));
      }
      this.applyArtistAuthorities(names);
    }
    async resolve(requested, { signal } = {}) {
      const uris = unique(requested).filter((uri) => isTrack(uri) || isAlbum(uri) || isArtist(uri));
      for (const uri of uris) this.observedUris.add(uri);
      const context = { signal, failures: [], stopped: void 0, generation: this.generation };
      const names = new Map([...this.names, ...this.store?.getArtistNames?.() ?? []]);
      await this.query(uris.filter((uri) => !isArtist(uri)), context, { parallel: false });
      const canonical = uris.map((uri) => romanizedCanonical(uri, merge(this.clients.get(uri), this.cache.get(uri)))).filter(Boolean);
      await this.query(canonical, context, { parallel: false });
      await this.indirect(uris, context);
      const artists = new Set(uris.filter(isArtist));
      for (const uri of uris) {
        const own = this.cache.get(uri), original = selectedOriginal(uri, own, this.cache, this.reverse);
        for (const a of [...own?.artists ?? [], ...original?.artists ?? []]) if (!hasCJK(a.name)) artists.add(a.uri);
      }
      await this.artistOriginals(artists, names, context);
      const tracks = /* @__PURE__ */ new Map(), sourceTracks = /* @__PURE__ */ new Map(), albums = /* @__PURE__ */ new Map();
      for (const uri of uris) {
        if (isAlbum(uri)) {
          const album = preferredAlbum(uri, this.cache);
          if (album) albums.set(uri, { ...album, uri });
          continue;
        }
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
      return {
        tracks,
        sourceTracks,
        albums,
        artistNames: names,
        failures: context.failures,
        complete: !context.failures.length,
        generation: this.generation,
        lookup: this.lookupChanges()
      };
    }
  };

  // src/storage.mjs
  var DATABASE = "jp-original-title-spicetify";
  var TABLES = ["artist_names", "previous_fields", "lookup_cache"];
  var validText = (value) => typeof value === "string" && value.trim().length > 0 && value.length <= 4096;
  var normalize = (value) => Array.isArray(value) ? value.every(validText) ? value.join(", ") : "" : value;
  var equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  function mergePrevious(existing, observations) {
    const rank = Math.max(...observations.map((item) => Number(item.priority) || 1));
    if (existing && existing.priority > rank) return existing;
    const items = observations.filter((item) => (Number(item.priority) || 1) === rank);
    const finals = new Set(items.filter((item) => Object.hasOwn(item, "now")).map((item) => normalize(item.now)));
    const olds = new Set(items.map((item) => normalize(item.value)).filter(validText));
    const conflict = items.some((item) => item.conflict) || finals.size > 1 || olds.size > 1;
    const suppressed = () => ({ value: "", priority: rank, suppressed: true });
    if (conflict || items.some((item) => !validText(normalize(item.value)) && !Object.hasOwn(item, "now"))) return suppressed();
    const now = finals.size ? [...finals][0] : void 0;
    let old = [...olds][0];
    if (now !== void 0) {
      if (!validText(now)) return suppressed();
      if (old === now) old = void 0;
      if (!old) return existing?.now === now ? { ...existing, priority: rank } : null;
      if (old === existing?.now) old = existing.value;
      if (old === now) return null;
    }
    return validText(old) ? { value: old, ...now === void 0 ? {} : { now }, priority: rank } : null;
  }
  function indexedAdapter(indexedDB, name) {
    let database;
    const transaction = (mode, callback) => new Promise((resolve, reject) => {
      const tx = database.transaction(TABLES, mode);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error("Database transaction failed"));
      tx.onabort = () => reject(tx.error || new Error("Database transaction aborted"));
      try {
        callback(tx);
      } catch (error) {
        tx.abort();
        reject(error);
      }
    });
    return {
      async load() {
        database = await new Promise((resolve, reject) => {
          const req = indexedDB.open(name, 2);
          req.onupgradeneeded = () => {
            for (const table of TABLES) {
              if (!req.result.objectStoreNames.contains(table)) req.result.createObjectStore(table, { keyPath: "key" });
            }
          };
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
          req.onblocked = () => reject(new Error("Database upgrade blocked by another Spotify window"));
        });
        database.onversionchange = () => database.close();
        const data = {};
        await transaction("readonly", (tx) => {
          for (const table of TABLES) {
            const request = tx.objectStore(table).getAll();
            request.onsuccess = () => {
              data[table] = request.result;
            };
          }
        });
        return data;
      },
      async write(artists, previous, lookup = /* @__PURE__ */ new Map()) {
        await transaction("readwrite", (tx) => {
          for (const [key2, value] of artists) tx.objectStore("artist_names").put({ key: key2, value });
          for (const [key2, value] of previous) {
            if (value) tx.objectStore("previous_fields").put({ key: key2, ...value });
            else tx.objectStore("previous_fields").delete(key2);
          }
          for (const [key2, value] of lookup) tx.objectStore("lookup_cache").put({ key: key2, ...value });
        });
      },
      async clear() {
        await transaction("readwrite", (tx) => {
          for (const table of TABLES) tx.objectStore(table).clear();
        });
      },
      close() {
        database?.close();
      }
    };
  }
  var Store = class {
    constructor({ indexedDB = globalThis.indexedDB, name = DATABASE, adapter } = {}) {
      if (!adapter && !indexedDB) throw new Error("IndexedDB is required for durable plugin storage");
      this.adapter = adapter || indexedAdapter(indexedDB, name);
      this.artists = /* @__PURE__ */ new Map();
      this.previous = /* @__PURE__ */ new Map();
      this.lookup = /* @__PURE__ */ new Map();
      this.queue = Promise.resolve();
      this.ready = false;
    }
    async open() {
      const data = await this.adapter.load();
      this.artists = new Map((data.artist_names || []).map((row) => [row.key, row.value]));
      this.previous = new Map((data.previous_fields || []).map(({ key: key2, ...value }) => [key2, value]));
      this.lookup = new Map((data.lookup_cache || []).map(({ key: key2, ...value }) => [key2, value]));
      this.ready = true;
      return this;
    }
    getArtistNames() {
      return new Map(this.artists);
    }
    getLookup(scope) {
      const result = { entities: /* @__PURE__ */ new Map(), authorities: /* @__PURE__ */ new Map(), aliases: /* @__PURE__ */ new Map() };
      for (const row of this.lookup.values()) {
        if (row.scope === scope && Object.hasOwn(result, row.type)) result[row.type].set(row.uri, row.value);
      }
      return result;
    }
    getPrevious(uri) {
      const result = {};
      for (const field of ["title", "artists", "album"]) {
        const row = this.previous.get(`${uri}	${field}`);
        if (row && validText(row.value)) result[field] = row.value;
      }
      return result;
    }
    getPreviousRecord(uri, field) {
      return this.previous.get(`${uri}	${field}`);
    }
    enqueue(task) {
      const result = this.queue.then(task);
      this.queue = result.catch(() => {
      });
      return result;
    }
    commit({ artistNames = /* @__PURE__ */ new Map(), previous = [], lookup, prepare } = {}) {
      return this.enqueue(async () => {
        if (!this.ready) throw new Error("Plugin storage is not open");
        const artists = /* @__PURE__ */ new Map();
        const observations = /* @__PURE__ */ new Map();
        const source = artistNames instanceof Map ? artistNames : Object.entries(artistNames);
        for (const [uri, name] of source) {
          if (uri.startsWith("spotify:artist:") && validText(name) && this.artists.get(uri) !== name) artists.set(uri, name);
        }
        for (const item of previous) {
          if (!item.uri?.startsWith("spotify:track:") || item.uri.length > 128 || !["title", "artists", "album"].includes(item.field)) continue;
          const key2 = `${item.uri}	${item.field}`;
          if (!observations.has(key2)) observations.set(key2, []);
          observations.get(key2).push(item);
        }
        const changes = /* @__PURE__ */ new Map();
        for (const [key2, items] of observations) {
          const value = mergePrevious(this.previous.get(key2), items);
          if (!equal(value, this.previous.get(key2) || null)) changes.set(key2, value);
        }
        const cached = /* @__PURE__ */ new Map();
        if (lookup?.scope) for (const type of ["entities", "authorities", "aliases"]) {
          for (const [uri, value] of lookup[type] ?? []) {
            const key2 = JSON.stringify([lookup.scope, type, uri]);
            const row = { scope: lookup.scope, type, uri, value };
            if (!equal(row, this.lookup.get(key2))) cached.set(key2, row);
          }
        }
        await prepare?.({ getPrevious: (uri) => {
          const result = {};
          for (const field of ["title", "artists", "album"]) {
            const key2 = `${uri}	${field}`;
            const row = changes.has(key2) ? changes.get(key2) : this.previous.get(key2);
            if (row && validText(row.value)) result[field] = row.value;
          }
          return result;
        } });
        if (!artists.size && !changes.size && !cached.size) return;
        try {
          await this.adapter.write(artists, changes, cached);
        } catch (cause) {
          const error = new Error("Plugin storage commit failed; enhanced response withheld", { cause });
          error.code = "JPT_STORAGE";
          error.storageFailure = true;
          throw error;
        }
        for (const [uri, name] of artists) this.artists.set(uri, name);
        for (const [key2, value] of changes) value ? this.previous.set(key2, value) : this.previous.delete(key2);
        for (const [key2, value] of cached) this.lookup.set(key2, value);
      });
    }
    reset() {
      return this.enqueue(async () => {
        await this.adapter.clear();
        this.artists.clear();
        this.previous.clear();
        this.lookup.clear();
      });
    }
    stats() {
      const rows = [...this.previous];
      const visible = rows.filter(([, row]) => validText(row.value));
      return {
        artistNames: this.artists.size,
        previousFields: visible.length,
        suppressedFields: rows.length - visible.length,
        tracks: new Set(visible.map(([key2]) => key2.split("	")[0])).size,
        lookupEntities: [...this.lookup.values()].filter((row) => row.type === "entities").length,
        bytes: new TextEncoder().encode(JSON.stringify([[...this.artists], rows, [...this.lookup]])).length
      };
    }
    close() {
      this.adapter.close?.();
    }
  };

  // src/transform.mjs
  var textDecoder = new TextDecoder("utf-8", { fatal: true });
  var GROUP = "Original Metadata";
  var ROLES = { title: "Title", artists: "Artist", album: "Album" };
  var entityPattern = /^spotify:(track|album|artist):[A-Za-z0-9]+$/;
  var hasText = (value) => typeof value === "string" && value.length <= 4096 && value.trim().length > 0;
  var upgrades = (old, name) => hasText(name) && !hasCJK(old) && hasCJK(name);
  var presented = (old, name, previous) => hasText(previous) && [`${name}\uFF5C${previous}`, `${name} - ${previous}`].includes(old);
  var retitles = (old, name, previous) => upgrades(old, name) || hasText(name) && presented(old, name, previous);
  var structured = (original, version, preferred) => hasText(preferred.originalTitle) && upgrades(`${original ?? ""} ${version ?? ""}`, `${preferred.originalTitle} ${preferred.versionTitle || ""}`);
  var entityURI = (value) => typeof value === "string" && entityPattern.test(value) ? value : void 0;
  var directURI = (object) => entityURI(object?.uri) || entityURI(object?.entityUri) || entityURI(object?.entityURI) || entityURI(object?.trackUri);
  var contextualURI = (object, keyHint) => directURI(object) || (["trackMetadata", "albumMetadata", "artistMetadata", "album", "artist"].includes(keyHint) ? entityURI(object?.link) : void 0);
  var mapGet = (map, key2) => map instanceof Map ? map.get(key2) : map?.[key2];
  var scalar = (value) => typeof value === "object" && value !== null ? value.value : value;
  var decode = (field) => field?.wire === 2 ? textDecoder.decode(field.data) : void 0;
  var find = (bytes3, number) => fields(bytes3).find((field) => field.field === number);
  var stringAt = (bytes3, number) => decode(find(bytes3, number));
  var bytesEqual = (a, b) => a.length === b.length && a.every((value, i) => value === b[i]);
  function draft(value) {
    if (!value || typeof value !== "object" || ArrayBuffer.isView(value)) return { value, finish: () => value };
    let copy;
    const children = /* @__PURE__ */ new Map();
    const current = () => copy || value;
    const writable = () => copy || (copy = Array.isArray(value) ? value.slice() : { ...value });
    const proxy = new Proxy(Array.isArray(value) ? [] : {}, {
      get(_, key2) {
        const item = Reflect.get(current(), key2);
        if (!item || typeof item !== "object" || ArrayBuffer.isView(item)) return item;
        if (!children.has(key2)) children.set(key2, draft(item));
        return children.get(key2).value;
      },
      set(_, key2, item) {
        if (Reflect.get(current(), key2) !== item) {
          writable()[key2] = item;
          children.delete(key2);
        }
        return true;
      },
      deleteProperty(_, key2) {
        delete writable()[key2];
        children.delete(key2);
        return true;
      },
      has: (_, key2) => key2 in current(),
      ownKeys: () => Reflect.ownKeys(current()),
      getOwnPropertyDescriptor(_, key2) {
        const descriptor = Reflect.getOwnPropertyDescriptor(current(), key2);
        return descriptor && { ...descriptor, configurable: key2 !== "length" || !Array.isArray(value) };
      }
    });
    return { value: proxy, finish() {
      for (const [key2, child] of children) {
        const item = child.finish();
        if (item !== Reflect.get(current(), key2)) writable()[key2] = item;
      }
      return current();
    } };
  }
  function failure2(code, message, cause) {
    const error = new Error(message, cause ? { cause } : void 0);
    error.code = code;
    error.strict = code !== "JPT_STORAGE_FAILED";
    error.fatal = code === "JPT_STORAGE_FAILED";
    return error;
  }
  function checkAbort(signal) {
    if (signal?.aborted) throw signal.reason || new DOMException("Aborted", "AbortError");
  }
  function list(value) {
    if (Array.isArray(value)) return value;
    if (Array.isArray(value?.items)) return value.items;
    if (Array.isArray(value?.edges)) return value.edges.map((item) => item.node ?? item);
    return [];
  }
  function artistList(object) {
    const value = object.artists ?? object.contributors ?? object.artist;
    if (value) return list(value).map((item) => item.artist ?? item);
    return [...list(object.firstArtist), ...list(object.otherArtists)].map((item) => item.artist ?? item);
  }
  function displayName(object) {
    if (typeof object?.name === "string") return object.name;
    if (typeof object?.title === "string") return object.title;
    return object?.profile?.name;
  }
  function setName(object, name) {
    if (!hasText(name)) return;
    if (typeof object.name === "string") object.name = name;
    else if (typeof object.title === "string") object.title = name;
    else if (typeof object.profile?.name === "string") object.profile.name = name;
  }
  function rename(object, name) {
    if (upgrades(displayName(object), name)) setName(object, name);
  }
  function previousNames(object) {
    const result = {};
    const name = displayName(object);
    if (name !== void 0) result.title = name;
    const album = object.albumOfTrack ?? object.album ?? object.contentHierarchyParent;
    if (album && displayName(album) !== void 0) result.album = displayName(album);
    const artists = artistList(object);
    if (artists.length) result.artists = artists.every((item) => hasText(displayName(item))) ? artists.map(displayName) : [];
    return result;
  }
  function previousWire(bytes3, kind) {
    if (kind === 128) {
      const title = stringAt(bytes3, 1);
      return title === void 0 ? {} : { title };
    }
    if (kind === 97) {
      const result2 = {};
      const title = stringAt(bytes3, 2);
      if (title !== void 0) result2.title = title;
      const artists2 = fields(bytes3).filter((field) => field.field === 8 && field.wire === 2).map((field) => stringAt(field.data, 1));
      if (artists2.length) result2.artists = artists2.every(hasText) ? artists2 : [];
      return result2;
    }
    const identity = kind === 178;
    const result = {};
    for (const field of fields(bytes3)) {
      if (field.wire !== 2) continue;
      if (field.field === 2) result.title = decode(field);
      if (field.field === (identity ? 4 : 3)) result.album = stringAt(field.data, identity ? 1 : 2);
    }
    const artists = fields(bytes3).filter((field) => field.field === (identity ? 5 : 4) && field.wire === 2).map((field) => stringAt(field.data, identity ? 1 : 2));
    if (artists.length) result.artists = artists.every(hasText) ? artists : [];
    return result;
  }
  function observationDeltas(observations) {
    const groups = /* @__PURE__ */ new Map();
    const normalized = (value) => Array.isArray(value) ? value.every(hasText) ? value.join(", ") : "" : value;
    for (const item of observations) {
      const key2 = `${item.uri}|${item.field}`;
      if (!groups.has(key2)) groups.set(key2, []);
      groups.get(key2).push(item);
    }
    return [...groups.values()].map((items) => {
      const rank = Math.max(...items.map((item) => item.priority));
      const highest = items.filter((item) => item.priority === rank);
      const finals = new Set(highest.map((item) => normalized(item.now)));
      const changed = highest.filter((item) => hasText(normalized(item.value)) && hasText(normalized(item.now)) && normalized(item.value) !== normalized(item.now));
      const originals = new Set(changed.map((item) => normalized(item.value)));
      const chosen = changed[0] || highest[0];
      return { ...chosen, ...finals.size > 1 || originals.size > 1 || highest.some((item) => item.conflict) ? { conflict: true } : {} };
    });
  }
  function capture(observations, uri, before, after, priority, previousTitle) {
    if (!uri?.startsWith("spotify:track:")) return;
    if (hasText(previousTitle) && [`${after.title}\uFF5C${previousTitle}`, `${after.title} - ${previousTitle}`].includes(before.title)) before = { ...before, title: after.title };
    for (const field of ["title", "artists", "album"]) {
      if (!(field in before) && !(field in after)) continue;
      const old = before[field] ?? (field === "artists" ? [] : "");
      const now = after[field] ?? (field === "artists" ? [] : "");
      observations.push({ uri, field, value: old, now, priority });
    }
  }
  function presentWireTitle(bytes3, kind, uri, resolved, title) {
    if (!uri?.startsWith("spotify:track:") || !mapGet(resolved.tracks, uri) || ![10, 97, 128, 178].includes(kind)) return bytes3;
    const field = kind === 128 ? 1 : 2;
    const old = stringAt(bytes3, field);
    const name = title(uri, old);
    if (!hasText(old) || name === old) return bytes3;
    let output = replaceString(bytes3, field, name);
    if (kind === 97 && stringAt(bytes3, 6) === old) output = replaceString(output, 6, name);
    return output;
  }
  function previousEntries(previous) {
    const result = [];
    for (const field of ["title", "artists", "album"]) {
      let value = previous?.[field];
      if (Array.isArray(value)) value = value.every(hasText) ? value.join(", ") : "";
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
      if (container.some((item) => !item.uri && !item.url && !item.reference?.uri && item.name === entry.name && item.role === entry.role && item.roleGroup?.name === GROUP)) continue;
      container.push(graphQL ? { ...entry, uri: null, url: null } : entry);
    }
  }
  function singularFields(bytes3, numbers) {
    const items = fields(bytes3);
    for (const number of numbers) if (items.filter((item) => item.field === number).length > 1) throw new Error("Ambiguous singular protobuf field");
    return items;
  }
  function creditsWire(bytes3, previous) {
    const parts = fields(bytes3).map((field) => field.raw);
    const known = /* @__PURE__ */ new Set();
    for (const field of fields(bytes3)) {
      if (field.field !== 1) continue;
      if (field.wire !== 2) throw new Error("Invalid credits contributor");
      const contributor = singularFields(field.data, [1, 2, 6]);
      for (const item of contributor) if ([1, 2, 6].includes(item.field) && item.wire !== 2) throw new Error("Invalid credits contributor field");
      if (contributor.some((item) => item.field === 3 || item.field === 5)) continue;
      const group2 = find(field.data, 6);
      if (group2?.wire === 2) singularFields(group2.data, [1]);
      if (group2?.wire === 2 && stringAt(group2.data, 1) === GROUP) known.add(`${stringAt(field.data, 2)}|${stringAt(field.data, 1)}`);
    }
    for (const entry of previousEntries(previous)) {
      if (!known.has(`${entry.role}|${entry.name}`)) parts.push(ld(1, concat(ld(1, entry.name), ld(2, entry.role), ld(6, ld(1, GROUP)))));
    }
    return concat(parts);
  }
  function rewriteWireValue(bytes3, kind, uri, resolved, previousTitle) {
    const preferred = mapGet(resolved.tracks, uri);
    const name = mapGet(resolved.artistNames, uri);
    const album = mapGet(resolved.albums, uri);
    if (kind === 128) {
      const selectedName = uri.startsWith("spotify:track:") ? preferred?.name : uri.startsWith("spotify:album:") ? album?.name : name;
      const old = stringAt(bytes3, 1);
      const change = uri.startsWith("spotify:track:") ? retitles(old, selectedName, previousTitle) : upgrades(old, selectedName);
      return change ? replaceString(bytes3, 1, selectedName) : bytes3;
    }
    if (kind === 97 && uri.startsWith("spotify:track:") && preferred) {
      const originalName = stringAt(bytes3, 2);
      const source = mapGet(resolved.sourceTracks, uri);
      const children = fields(bytes3).filter((field) => field.field === 8 && field.wire === 2);
      const originalArtists = children.map((field) => stringAt(field.data, 1));
      const complete = source?.artists?.length > 0 && children.length === source.artists.length && originalArtists.every((old, index2) => hasText(old) && old === source.artists[index2].name);
      const replacements = complete ? source.artists.map((artist) => mapGet(resolved.artistNames, artist.uri) || preferred.artists?.find((item) => item.uri === artist.uri)?.name || artist.name) : [];
      const finals = replacements.map((name2, i) => upgrades(originalArtists[i], name2) ? name2 : originalArtists[i]);
      const title = retitles(originalName, preferred.name, previousTitle);
      let index = 0;
      return concat(fields(bytes3).map((field) => {
        if (field.wire !== 2) return field.raw;
        if (field.field === 2 && title) return ld(2, preferred.name);
        if (field.field === 6 && title && decode(field) === originalName) return ld(6, preferred.name);
        if (complete && field.field === 8) {
          const i = index++;
          return finals[i] === originalArtists[i] ? field.raw : ld(8, replaceString(field.data, 1, finals[i]));
        }
        if (complete && field.field === 3 && decode(field) === originalArtists.join(", ") && finals.join(", ") !== decode(field)) return ld(3, finals.join(", "));
        return field.raw;
      }));
    }
    if (uri.startsWith("spotify:artist:") && [8, 97, 178].includes(kind) && upgrades(stringAt(bytes3, 2), name)) {
      const old = stringAt(bytes3, 2);
      let output = replaceString(bytes3, 2, name);
      if (kind === 97 && stringAt(bytes3, 6) === old) output = replaceString(output, 6, name);
      return output;
    }
    if (uri.startsWith("spotify:album:") && [9, 178].includes(kind) && upgrades(stringAt(bytes3, 2), album?.name)) {
      let output = replaceString(bytes3, 2, album.name);
      if (kind === 9 && hasText(album.originalTitle)) output = replaceString(output, 18, album.originalTitle);
      return output;
    }
    if (!preferred || ![10, 178].includes(kind)) return bytes3;
    if (kind === 178) {
      const old = previousWire(bytes3, 178);
      const names = (preferred.artists ?? []).map((artist) => mapGet(resolved.artistNames, artist.uri) || artist.name);
      const title = retitles(old.title, preferred.name, previousTitle);
      const album2 = hasText(preferred.albumURI) && upgrades(old.album, preferred.albumName);
      const artists = names.length > 0 && upgrades((old.artists ?? []).join(", "), names.join(", "));
      const items = fields(bytes3);
      const renamed = artists ? void 0 : new Map(items.filter((field) => field.field === 5 && field.wire === 2).flatMap((field) => {
        const artistURI = stringAt(field.data, 2);
        const name2 = mapGet(resolved.artistNames, artistURI) || preferred.artists?.find((artist) => artist.uri === artistURI)?.name;
        return upgrades(stringAt(field.data, 1), name2) ? [[field, ld(5, replaceString(field.data, 1, name2))]] : [];
      }));
      if (!title && !album2 && !artists && !renamed.size) return bytes3;
      const parts = [];
      for (const field of items) {
        if (field.field === 2 && title) parts.push(ld(2, preferred.name));
        else if (field.field === 4 && album2) {
          parts.push(ld(4, replaceString(replaceString(field.data, 1, preferred.albumName), 2, preferred.albumURI)));
        } else if (field.field === 5 && artists) continue;
        else parts.push(renamed?.get(field) ?? field.raw);
      }
      if (title && old.title === void 0) parts.push(ld(2, preferred.name));
      if (artists) for (const artist of preferred.artists) {
        const own = fields(bytes3).find((field) => field.field === 5 && field.wire === 2 && stringAt(field.data, 2) === artist.uri);
        const name2 = mapGet(resolved.artistNames, artist.uri) || artist.name;
        const contributor = own ? replaceString(own.data, 1, name2) : concat(ld(1, name2), ld(2, artist.uri));
        parts.push(ld(5, contributor));
      }
      return concat(parts);
    }
    const pair = structured(stringAt(bytes3, 27), stringAt(bytes3, 28), preferred);
    return concat(fields(bytes3).map((field) => {
      if (field.wire !== 2) return field.raw;
      if (field.field === 2 && retitles(decode(field), preferred.name, previousTitle)) return ld(2, preferred.name);
      if ([27, 28].includes(field.field) && pair) return ld(field.field, field.field === 27 ? preferred.originalTitle : preferred.versionTitle || "");
      if (field.field === 3 && upgrades(stringAt(field.data, 2), preferred.albumName)) return ld(3, replaceString(field.data, 2, preferred.albumName));
      if ([4, 32].includes(field.field)) {
        const artistURI = gidToURI(find(field.data, 1)?.data, "artist");
        const selected = preferred.artists?.find((artist) => artist.uri === artistURI);
        const selectedName = mapGet(resolved.artistNames, artistURI) || selected?.name;
        if (upgrades(stringAt(field.data, 2), selectedName)) return ld(field.field, replaceString(field.data, 2, selectedName));
      }
      return field.raw;
    }));
  }
  function typedRewrite(object, uri, resolved, priority, observations, kind, previousTitle) {
    const before = previousNames(object);
    const preferred = mapGet(resolved.tracks, uri);
    if (uri.startsWith("spotify:track:") && preferred) {
      if (retitles(displayName(object), preferred.name, previousTitle)) setName(object, preferred.name);
      if (kind === 97 && retitles(before.title, preferred.name, previousTitle) && object.title === before.title) object.title = preferred.name;
      if (structured(object.originalTitle ?? object.original_title, object.versionTitle ?? object.version_title, preferred)) {
        for (const key2 of ["originalTitle", "original_title"]) if (key2 in object) object[key2] = preferred.originalTitle;
        for (const key2 of ["versionTitle", "version_title"]) if (key2 in object) object[key2] = preferred.versionTitle || "";
      }
      const album = object.albumOfTrack ?? object.album ?? object.contentHierarchyParent;
      if (album && upgrades(displayName(album), preferred.albumName)) {
        setName(album, preferred.albumName);
        if (priority !== 2 && hasText(preferred.albumURI) && "uri" in album) album.uri = preferred.albumURI;
      }
      const artists = artistList(object);
      for (const artist of artists) {
        const artistURI = contextualURI(artist, "artist");
        const preferredArtist = preferred.artists?.find((item) => item.uri === artistURI);
        rename(artist, mapGet(resolved.artistNames, artistURI) || preferredArtist?.name);
      }
    } else if (uri.startsWith("spotify:album:")) rename(object, mapGet(resolved.albums, uri)?.name);
    else if (uri.startsWith("spotify:artist:")) {
      const old = displayName(object);
      const name = mapGet(resolved.artistNames, uri);
      rename(object, name);
      if (kind === 97 && upgrades(old, name) && object.title === old) object.title = name;
    }
    capture(observations, uri, before, previousNames(object), priority, previousTitle);
  }
  function createTransformer({ resolver, store, isStrict = () => false, combineTitles = () => false, log = () => {
  } }) {
    const strict = () => typeof isStrict === "function" ? isStrict() : !!isStrict;
    function presentation(getPrevious, resolved) {
      const combine = typeof combineTitles === "function" ? combineTitles() : !!combineTitles;
      return (uri, name) => {
        const previous = getPrevious(uri)?.title;
        if (name !== mapGet(resolved.tracks, uri)?.name) return name;
        const joined = `${name}\uFF5C${previous}`;
        return combine && hasText(name) && hasText(previous) && name !== previous && hasText(joined) ? joined : name;
      };
    }
    async function resolve(uris, signal) {
      checkAbort(signal);
      try {
        const result = await resolver.resolve([...uris], { signal });
        checkAbort(signal);
        if (strict() && result.failures?.length) throw failure2("JPT_LOOKUP_FAILED", "Metadata lookup failed");
        return result;
      } catch (error) {
        if (error?.name === "AbortError" || signal?.aborted || strict()) throw error?.code ? error : failure2("JPT_LOOKUP_FAILED", "Metadata lookup failed", error);
        log("lookup-failed", { code: error?.code || "unknown" });
        return { tracks: /* @__PURE__ */ new Map(), albums: /* @__PURE__ */ new Map(), artistNames: /* @__PURE__ */ new Map(), failures: [error] };
      }
    }
    async function commit(resolved, observations, signal, prepare) {
      checkAbort(signal);
      let preparationFailed = false;
      try {
        await store.commit({ artistNames: resolved.artistNames || /* @__PURE__ */ new Map(), previous: observationDeltas(observations), lookup: resolved.lookup, prepare: async (projected) => {
          try {
            checkAbort(signal);
            resolver.assertCurrent?.(resolved);
            await prepare?.(projected);
            checkAbort(signal);
          } catch (error) {
            preparationFailed = true;
            throw error;
          }
        } });
        resolver.didPersist?.(resolved.lookup);
      } catch (error) {
        if (preparationFailed) throw error;
        throw failure2("JPT_STORAGE_FAILED", "Metadata storage transaction failed", error);
      }
      checkAbort(signal);
    }
    function parseGuard(operation, original) {
      try {
        return operation();
      } catch (error) {
        if (strict()) throw failure2("JPT_PARSE_FAILED", "Metadata structure is invalid", error);
        log("parse-failed", { code: "JPT_PARSE_FAILED" });
        return original;
      }
    }
    async function rewriteMetadata(bytes3, { signal, validate } = {}) {
      let decoded;
      try {
        decoded = decodeMetadata(bytes3);
      } catch (error) {
        if (strict()) throw failure2("JPT_PARSE_FAILED", "Metadata response is invalid", error);
        return bytes3;
      }
      if (strict() && decoded.entries.some((entry) => entry.parseError)) throw failure2("JPT_PARSE_FAILED", "Metadata entry is invalid");
      resolver.ingest?.(decoded);
      const uris = new Set(decoded.entries.filter((entry) => entityURI(entry.uri)).map((entry) => entry.uri));
      const resolved = await resolve(uris, signal);
      const observations = [];
      const output = parseGuard(() => concat(fields(bytes3).map((arrayField) => {
        if (arrayField.field !== 2 || arrayField.wire !== 2) return arrayField.raw;
        const kind = Number(find(arrayField.data, 2)?.value);
        return ld(2, concat(fields(arrayField.data).map((entryField) => {
          if (entryField.field !== 3 || entryField.wire !== 2) return entryField.raw;
          return parseGuard(() => {
            if (kind === 186) {
              singularFields(entryField.data, [1, 2, 3]);
              const wrapper = find(entryField.data, 3);
              if (wrapper?.wire !== 2) throw new Error("Missing credits Any");
              singularFields(wrapper.data, [2]);
            }
            const uri = stringAt(entryField.data, 2);
            const header = find(entryField.data, 1);
            const status = header?.wire === 2 ? Number(find(header.data, 1)?.value) : 0;
            if (status !== 200 || !entityURI(uri)) return entryField.raw;
            const any = find(entryField.data, 3);
            if (any?.wire !== 2) throw new Error("Missing Any wrapper");
            const value = find(any.data, 2);
            if (value?.wire !== 2) throw new Error("Missing Any value");
            if (kind === 186) creditsWire(value.data, {});
            const rewritten = kind === 186 ? value.data : rewriteWireValue(value.data, kind, uri, resolved, store.getPrevious(uri)?.title);
            if ([10, 97, 128, 178].includes(kind) && uri.startsWith("spotify:track:")) capture(observations, uri, previousWire(value.data, kind), previousWire(rewritten, kind), kind === 178 ? 3 : kind === 10 ? 2 : 1, store.getPrevious(uri)?.title);
            return ld(3, concat(fields(entryField.data).map((field) => field.field === 3 && field.wire === 2 ? ld(3, concat(fields(any.data).map((item) => item.field === 2 && item.wire === 2 ? ld(2, rewritten) : item.raw))) : field.raw)));
          }, entryField.raw);
        })));
      })), bytes3);
      let finalOutput;
      await commit(resolved, observations, signal, async ({ getPrevious }) => {
        const title = presentation(getPrevious, resolved);
        finalOutput = parseGuard(() => concat(fields(output).map((arrayField) => {
          if (arrayField.field !== 2 || arrayField.wire !== 2) return arrayField.raw;
          const kind = Number(find(arrayField.data, 2)?.value);
          if (![10, 97, 128, 178, 186].includes(kind)) return arrayField.raw;
          return ld(2, concat(fields(arrayField.data).map((entryField) => {
            if (entryField.field !== 3 || entryField.wire !== 2) return entryField.raw;
            return parseGuard(() => {
              if (kind === 186) singularFields(entryField.data, [1, 2, 3]);
              const wrapper = find(entryField.data, 3);
              if (wrapper?.wire !== 2) throw new Error("Missing credits Any");
              if (kind === 186) singularFields(wrapper.data, [2]);
              const uri = stringAt(entryField.data, 2);
              const header = find(entryField.data, 1);
              if (Number(find(header?.data || new Uint8Array(), 1)?.value) !== 200) return entryField.raw;
              const any = find(entryField.data, 3);
              const value = find(any.data, 2);
              const rewritten = kind === 186 ? creditsWire(value.data, getPrevious(uri)) : presentWireTitle(value.data, kind, uri, resolved, title);
              if (bytesEqual(rewritten, value.data)) return entryField.raw;
              return ld(3, concat(fields(entryField.data).map((field) => field.field === 3 && field.wire === 2 ? ld(3, concat(fields(any.data).map((item) => item.field === 2 && item.wire === 2 ? ld(2, rewritten) : item.raw))) : field.raw)));
            }, entryField.raw);
          })));
        })), output);
        await validate?.(finalOutput);
      });
      return bytesEqual(bytes3, finalOutput) ? bytes3 : finalOutput;
    }
    async function rewriteStructured(value, options = {}, mode = "json") {
      const { signal, priority = mode === "native" ? 3 : 1 } = options;
      const candidate = draft(value);
      const output = candidate.value;
      const uris = /* @__PURE__ */ new Set();
      const native = { tracks: /* @__PURE__ */ new Map(), albums: /* @__PURE__ */ new Map() };
      const collect = (object, inheritedURI, inheritedKind, keyHint) => {
        if (!object || typeof object !== "object" || object instanceof Uint8Array) return;
        if (Array.isArray(object)) {
          object.forEach((item) => collect(item, inheritedURI, inheritedKind, keyHint));
          return;
        }
        if (typeof object.uri === "string" && object.uri.startsWith("spotify:local:")) return;
        if (object.entityUri && object.extensionKind !== void 0 && typeof object.status === "number" && ![1, 200].includes(object.status)) return;
        const uri = contextualURI(object, keyHint) || entityURI(keyHint) || inheritedURI;
        const kind = Number(scalar(object.extensionKind ?? object.extension_kind ?? object.kind) ?? inheritedKind) || void 0;
        const raw = object.value instanceof Uint8Array && (object.typeUrl || object.type_url) ? object.value : void 0;
        const displayCarrier = displayName(object) !== void 0 || mode === "player" && object.metadata && ["title", "album_title", "artist_name"].some((key2) => key2 in object.metadata);
        if (uri && (displayCarrier || mode === "native" && (raw || object.extensionData || object.extensionResult))) uris.add(uri);
        if (mode === "native" && raw && uri && [9, 10].includes(kind)) parseGuard(() => {
          const info = kind === 10 ? parseTrack(raw, uri) : parseAlbum(raw, uri);
          (kind === 10 ? native.tracks : native.albums).set(uri, info);
        });
        for (const [key2, item] of Object.entries(object)) {
          const nextKind = /^\d+$/.test(key2) ? Number(key2) : kind;
          collect(item, uri, nextKind, key2);
        }
      };
      collect(value);
      if (mode === "native") resolver.ingest?.(native);
      const suppliedURI = entityURI(options.uri || options.trackURI || options.trackUri);
      if (suppliedURI) uris.add(suppliedURI);
      const resolved = await resolve(uris, signal);
      const observations = [];
      const credits = [];
      const titles = [];
      const visit = (object, inheritedURI, inheritedKind, keyHint, suppressEntity = false) => {
        if (!object || typeof object !== "object" || object instanceof Uint8Array) return;
        if (Array.isArray(object)) {
          object.forEach((item) => visit(item, inheritedURI, inheritedKind, keyHint, suppressEntity));
          return;
        }
        if (typeof object.uri === "string" && object.uri.startsWith("spotify:local:")) return;
        if (object.entityUri && object.extensionKind !== void 0 && typeof object.status === "number" && ![1, 200].includes(object.status)) return;
        const uri = contextualURI(object, keyHint) || entityURI(keyHint) || inheritedURI;
        const kind = Number(scalar(object.extensionKind ?? object.extension_kind ?? object.kind) ?? inheritedKind) || void 0;
        if (uri && kind === 186 && object.extensionResult?.value instanceof Uint8Array) credits.push({ holder: object.extensionResult, uri, raw: true });
        if (uri && object.extensionResult?.value instanceof Uint8Array) {
          const raw = object.extensionResult.value;
          const rewritten = parseGuard(() => rewriteWireValue(raw, kind, uri, resolved, store.getPrevious(uri)?.title), raw);
          if ([10, 97, 128, 178].includes(kind)) parseGuard(() => capture(observations, uri, previousWire(raw, kind), previousWire(rewritten, kind), kind === 178 ? 3 : kind === 10 ? 2 : 1, store.getPrevious(uri)?.title));
          object.extensionResult.value = bytesEqual(raw, rewritten) ? raw : rewritten;
          titles.push((title) => {
            object.extensionResult.value = presentWireTitle(object.extensionResult.value, kind, uri, resolved, title);
          });
        }
        if (uri && object.value instanceof Uint8Array && (object.typeUrl || object.type_url)) {
          const inferredKind = kind || (/\.Track$/.test(object.typeUrl || object.type_url) ? 10 : void 0);
          const raw = object.value;
          const rewritten = parseGuard(() => rewriteWireValue(raw, inferredKind, uri, resolved, store.getPrevious(uri)?.title), raw);
          if ([10, 97, 128, 178].includes(inferredKind)) parseGuard(() => capture(observations, uri, previousWire(raw, inferredKind), previousWire(rewritten, inferredKind), inferredKind === 178 ? 3 : inferredKind === 10 ? 2 : 1, store.getPrevious(uri)?.title));
          object.value = bytesEqual(raw, rewritten) ? raw : rewritten;
          titles.push((title) => {
            object.value = presentWireTitle(object.value, inferredKind, uri, resolved, title);
          });
          if (inferredKind === 186) credits.push({ holder: object, uri, raw: true });
        }
        const suppliedTrackCarrier = suppliedURI?.startsWith("spotify:track:") && uri === suppliedURI && keyHint === "trackUnion" && typeof displayName(object) === "string";
        const isEntity = !!contextualURI(object, keyHint) || !!entityURI(keyHint) || suppliedTrackCarrier || uri && (keyHint === "extensionResult" || kind && (object.name !== void 0 || object.contributors));
        if (isEntity && !suppressEntity && uri && kind !== 186) {
          typedRewrite(object, uri, resolved, kind === 178 ? 3 : kind === 10 || keyHint === "trackMetadata" ? 2 : [97, 128].includes(kind) ? 1 : priority, observations, kind, store.getPrevious(uri)?.title);
          if (uri.startsWith("spotify:track:") && mapGet(resolved.tracks, uri)) titles.push((title) => {
            const old = displayName(object);
            if (!hasText(old)) return;
            const name = title(uri, old);
            setName(object, name);
            if (kind === 97 && object.title === old) object.title = name;
          });
        }
        if (uri && object.creditsTrait) credits.push({ value: object.creditsTrait, uri, graphQL: true });
        if (uri && kind === 186 && Array.isArray(object.contributors)) credits.push({ value: object, uri });
        if (uri && mode === "player" && object.metadata && typeof object.metadata === "object") {
          rewritePlayerMap(object.metadata, uri, resolved, observations, store.getPrevious(uri)?.title);
          if (mapGet(resolved.tracks, uri) && hasText(object.metadata.title)) titles.push((title) => {
            object.metadata.title = title(uri, object.metadata.title);
          });
        }
        for (const [key2, item] of Object.entries(object)) {
          if (key2 === "creditsTrait" || key2 === "metadata" && mode === "player" || kind === 186 && key2 === "contributors") continue;
          const nextKind = /^\d+$/.test(key2) ? Number(key2) : kind;
          const inherit = ["extensionResult", "value", "extensions", "extension", "extensionData", "entities", "items", "item", "trackMetadata", "artistMetadata", "albumMetadata", "metadata", "data", "trackUnion", "track", "tracks", "state", "playerState", "response"].includes(key2) || /^\d+$/.test(key2) || entityURI(key2);
          const adoptedParent = isEntity && uri?.startsWith("spotify:track:") && mapGet(resolved.tracks, uri) && ["album", "albumOfTrack", "contentHierarchyParent"].includes(key2);
          visit(item, inherit ? uri : void 0, nextKind, key2, !!adoptedParent);
        }
      };
      visit(output, suppliedURI, void 0);
      let finalOutput;
      await commit(resolved, observations, signal, async ({ getPrevious }) => {
        const title = presentation(getPrevious, resolved);
        for (const apply of titles) parseGuard(() => apply(title));
        for (const item of credits) {
          if (item.raw) {
            const raw = item.holder.value;
            const rewritten = parseGuard(() => creditsWire(raw, getPrevious(item.uri)), raw);
            item.holder.value = bytesEqual(raw, rewritten) ? raw : rewritten;
          } else addCredits(item.value, getPrevious(item.uri), item.graphQL);
        }
        finalOutput = candidate.finish();
        await options.validate?.(finalOutput);
      });
      return finalOutput;
    }
    return {
      rewriteJSON: (value, options) => rewriteStructured(value, options, "json"),
      rewriteNative: (value, options) => rewriteStructured(value, options, "native"),
      rewritePlayer: (value, options) => rewriteStructured(value, options, "player"),
      rewriteMetadata
    };
  }
  function rewritePlayerMap(metadata, uri, resolved, observations, previousTitle) {
    const preferred = mapGet(resolved.tracks, uri);
    if (!preferred) return;
    const before = {}, after = {};
    for (const key2 of ["title", "album_title"]) if (key2 in metadata) before[key2 === "title" ? "title" : "album"] = metadata[key2];
    const artistKeys = Object.keys(metadata).filter((key2) => /^artist_name(?::\d+)?$/.test(key2)).sort((a, b) => Number(a.split(":")[1] || 0) - Number(b.split(":")[1] || 0));
    if (artistKeys.length) before.artists = artistKeys.every((key2) => hasText(metadata[key2])) ? artistKeys.map((key2) => metadata[key2]) : [];
    if ("title" in metadata && retitles(metadata.title, preferred.name, previousTitle)) metadata.title = preferred.name;
    if ("album_title" in metadata && upgrades(metadata.album_title, preferred.albumName)) metadata.album_title = preferred.albumName;
    if (structured(metadata.original_title, metadata.version_title, preferred)) {
      if ("original_title" in metadata) metadata.original_title = preferred.originalTitle;
      if ("version_title" in metadata) metadata.version_title = preferred.versionTitle || "";
    }
    for (const key2 of artistKeys) {
      const suffix = key2.slice("artist_name".length);
      const artistURI = metadata[`artist_uri${suffix}`];
      const artist = preferred.artists?.find((item) => item.uri === artistURI);
      const name = mapGet(resolved.artistNames, artistURI) || artist?.name;
      if (upgrades(metadata[key2], name)) metadata[key2] = name;
    }
    for (const key2 of ["title", "album_title"]) if (key2 in metadata) after[key2 === "title" ? "title" : "album"] = metadata[key2];
    if (artistKeys.length) after.artists = artistKeys.every((key2) => hasText(metadata[key2])) ? artistKeys.map((key2) => metadata[key2]) : [];
    capture(observations, uri, before, after, 1, previousTitle);
  }

  // src/network.mjs
  var METADATA_ENDPOINT = "https://spclient.wg.spotify.com/extended-metadata/v0/extended-metadata";
  function aborted(signal) {
    if (!signal?.aborted) return;
    throw signal.reason instanceof Error ? signal.reason : new DOMException("The request was aborted.", "AbortError");
  }
  async function accessToken(platform) {
    const authorization = platform?.AuthorizationAPI;
    const provider = authorization?._tokenProvider;
    let result;
    if (typeof provider?.getToken === "function") result = await provider.getToken();
    else if (typeof provider === "function") result = await provider.call(authorization, { preferCached: true });
    else result = authorization?.getState?.()?.token;
    const token = typeof result === "string" ? result : result?.accessToken;
    if (!token) {
      const error = new Error("Spotify authentication is unavailable.");
      error.status = error.statusCode = 401;
      throw error;
    }
    return token;
  }
  function waitFor(promise, signal) {
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(signal.reason ?? new DOMException("The request was aborted.", "AbortError"));
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
      Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
    });
  }
  function createRequest({ Spicetify, fetch: originalFetch = globalThis.fetch, log = () => {
  }, timeoutMs = 2e4 }) {
    if (typeof originalFetch !== "function") throw new TypeError("A captured fetch implementation is required.");
    const send = originalFetch.bind(globalThis);
    const text2 = new TextEncoder();
    return async function request(entities, language = "zh-Hans", signal) {
      aborted(signal);
      const platform = Spicetify?.Platform;
      const market = /^[A-Z]{2}$/.test(platform?.Session?.market ?? "") ? platform.Session.market : "US";
      const product = platform?.initialProductState?.product === "free" ? "free" : "premium";
      const header = concat(ld(1, text2.encode(market)), ld(2, text2.encode(product)));
      const body = encodeRequest(entities, { header });
      const controller = new AbortController();
      const onAbort = () => controller.abort(signal.reason ?? new DOMException("The request was aborted.", "AbortError"));
      signal?.addEventListener("abort", onAbort, { once: true });
      const timeout = Object.assign(new Error("Spotify metadata timed out."), { name: "TimeoutError", code: "JPT_TIMEOUT", timeout: true });
      const timer = setTimeout(() => controller.abort(timeout), timeoutMs);
      try {
        const token = await waitFor(accessToken(platform), controller.signal);
        aborted(signal);
        const response = await waitFor(send(METADATA_ENDPOINT, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/x-protobuf",
            Accept: "application/x-protobuf",
            "Accept-Language": language
          },
          body,
          signal: controller.signal
        }), controller.signal);
        aborted(signal);
        if (!response.ok || response.status === 204) {
          const error = new Error(`Spotify metadata returned HTTP ${response.status}.`);
          error.status = error.statusCode = response.status;
          const retryAfter = response.headers?.get?.("retry-after");
          if (retryAfter !== null && retryAfter !== void 0) error.retryAfter = retryAfter;
          if (![204, 404, 410].includes(response.status)) log("lookup-http-error", { status: response.status });
          throw error;
        }
        const bytes3 = new Uint8Array(await waitFor(response.arrayBuffer(), controller.signal));
        aborted(signal);
        return bytes3;
      } catch (cause) {
        if (controller.signal.reason === timeout) throw timeout;
        if (signal?.aborted || cause?.name === "AbortError") throw cause;
        if (cause?.status) throw cause;
        const error = new Error("Spotify metadata could not be reached.");
        error.offline = globalThis.navigator?.onLine === false;
        error.cause = cause;
        throw error;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    };
  }

  // src/wire-overlay.mjs
  var equal2 = (left, right) => left.length === right.length && left.every((value, index) => value === right[index]);
  var key = (field) => `${field.field}:${field.wire}`;
  var group = (parsed) => {
    const result = /* @__PURE__ */ new Map();
    for (const field of parsed) {
      const name = key(field);
      if (!result.has(name)) result.set(name, []);
      result.get(name).push(field);
    }
    return result;
  };
  var encoded = (values) => concat((values ?? []).map((field) => field.raw));
  function keyed(values, number) {
    const result = /* @__PURE__ */ new Map();
    for (const value of values) {
      const identifier = fields(value.data).find((field) => field.field === number && field.wire === 2);
      const identity = identifier ? Array.from(identifier.data).join(",") : "";
      if (result.has(identity)) throw Object.assign(new Error("Duplicate bridge map keys cannot be aligned losslessly."), { code: "JPT_PARSE_FAILED" });
      result.set(identity, value);
    }
    return result;
  }
  function overlayKnownWire(original, canonicalBefore, canonicalAfter, children = {}) {
    if (equal2(canonicalBefore, canonicalAfter)) return original;
    const source = fields(original);
    const old = group(fields(canonicalBefore));
    const next = group(fields(canonicalAfter));
    const originals = group(source);
    const replacements = /* @__PURE__ */ new Map();
    for (const name of /* @__PURE__ */ new Set([...old.keys(), ...next.keys()])) {
      const before = old.get(name) ?? [];
      const after = next.get(name) ?? [];
      if (equal2(encoded(before), encoded(after))) continue;
      const existing = originals.get(name) ?? [];
      const [number, wire] = name.split(":").map(Number);
      if (wire === 2 && Object.hasOwn(children, number) && before.length && after.length) {
        if (children[number].$key) {
          const oldKeys = keyed(before, children[number].$key);
          const rawKeys = keyed(existing, children[number].$key);
          const nextKeys = keyed(after, children[number].$key);
          const output2 = [];
          for (const [identity, value] of nextKeys) {
            const prior = oldKeys.get(identity);
            const raw = rawKeys.get(identity);
            if (prior && !raw) throw Object.assign(new Error("A bridge map entry is missing its original bytes."), { code: "JPT_PARSE_FAILED" });
            if (prior) output2.push(ld(number, overlayKnownWire(raw.data, prior.data, value.data, children[number])));
            else if (!raw) output2.push(value.raw);
            else throw Object.assign(new Error("A bridge map entry has an ambiguous original value."), { code: "JPT_PARSE_FAILED" });
          }
          for (const [identity, raw] of rawKeys) if (!oldKeys.has(identity)) {
            if (nextKeys.has(identity)) throw Object.assign(new Error("A bridge map key collides with unmodeled original data."), { code: "JPT_PARSE_FAILED" });
            output2.push(raw.raw);
          }
          replacements.set(name, output2);
          continue;
        }
        if (before.length !== after.length || existing.length !== before.length) {
          throw Object.assign(new Error("A changed bridge message cannot be aligned losslessly."), { code: "JPT_PARSE_FAILED" });
        }
        replacements.set(name, after.map((field, index) => ld(
          number,
          overlayKnownWire(existing[index].data, before[index].data, field.data, children[number])
        )));
      } else replacements.set(name, after.map((field) => field.raw));
    }
    const output = [];
    const positions = /* @__PURE__ */ new Map();
    for (const field of source) {
      const name = key(field);
      if (!replacements.has(name)) {
        output.push(field.raw);
        continue;
      }
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
  var contextTrack = { 3: { $key: 1 } };
  var providedTrack = { 1: contextTrack };
  var trackMetadata = { 1: { 1: {} }, 2: {}, 20: {} };
  var listItem = { 4: trackMetadata, 17: {}, 21: {} };
  var listData = { 1: listItem, 10: { 1: trackMetadata } };
  var NATIVE_WIRE_SCHEMAS = {
    metadata: { observe: { 1: { 3: {} } }, fetch: { 1: {} } },
    player: {
      getstate: { 7: providedTrack, 20: providedTrack, 21: providedTrack },
      getqueue: { 2: providedTrack, 3: providedTrack, 4: providedTrack },
      getplayhistory: { 1: contextTrack }
    },
    list: { get: { 2: listData }, subscribe: { 2: listData } }
  };

  // src/hooks.mjs
  var OWN_REQUEST = /* @__PURE__ */ Symbol.for("JPOriginalTitles.ownRequest");
  function abortError2() {
    return new DOMException("The enhancement was cancelled.", "AbortError");
  }
  function classifyURL(value) {
    try {
      const url = new URL(typeof value === "string" ? value : value?.url, "https://xpui.app.spotify.com");
      if (!/(^|\.)spotify\.com$/.test(url.hostname)) return null;
      if (/\/extended-metadata\/v0\/extended-metadata\/?$/.test(url.pathname)) return { type: "metadata", url };
      if (url.hostname === "api-partner.spotify.com" && /^\/pathfinder\/v[12]\/query\/?$/.test(url.pathname) || /\/metadata\/4\/(track|album|artist)\//.test(url.pathname) || url.hostname === "api.spotify.com" && /^\/v1\/(tracks|albums|artists)(\/|$)/.test(url.pathname)) {
        let variables;
        try {
          variables = JSON.parse(url.searchParams.get("variables") ?? "{}");
        } catch {
        }
        return { type: "json", url, uri: variables?.trackUri ?? variables?.uri };
      }
    } catch {
    }
    return null;
  }
  function requestURI(target, args) {
    let uri = classifyURL(args[0]);
    if (!uri && target) {
      const path = target.url ?? `${target.host ?? ""}${target.path ?? ""}`;
      uri = classifyURL(path);
    }
    if (uri && !uri.uri) {
      const body = args[1]?.payload ?? args[1]?.body ?? target?.postData;
      try {
        const parsed = typeof body === "string" ? JSON.parse(body) : body;
        const variables = parsed?.variables;
        uri.uri = variables?.trackUri ?? variables?.uri;
      } catch {
      }
    }
    return uri;
  }
  function bytes2(value) {
    if (value instanceof Uint8Array) return value;
    if (value instanceof ArrayBuffer) return new Uint8Array(value);
    if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return null;
  }
  function installHooks({ Spicetify, transformer, log = () => {
  }, isStrict = () => false }) {
    const restores = [];
    const installed = /* @__PURE__ */ new WeakMap();
    const controllers = /* @__PURE__ */ new Set();
    const streamCancellations = /* @__PURE__ */ new Set();
    const streamDetachments = /* @__PURE__ */ new Set();
    const activeFacades = /* @__PURE__ */ new Set();
    const codecServices = /* @__PURE__ */ new Map();
    const inFlight = /* @__PURE__ */ new WeakMap();
    const enhanced = /* @__PURE__ */ new WeakSet();
    const counts = { http: 0, native: 0, player: 0, failures: 0 };
    const layers = /* @__PURE__ */ new Set();
    let disposed = false;
    let facadeScope = null;
    function patch(object, name, make, label) {
      if (!object || typeof object[name] !== "function") return false;
      let names = installed.get(object);
      if (names?.has(name)) return true;
      const descriptor = Object.getOwnPropertyDescriptor(object, name);
      const original = object[name];
      const wrapper = make(original);
      try {
        Object.defineProperty(object, name, { configurable: true, writable: true, value: wrapper });
      } catch {
        return false;
      }
      if (!names) installed.set(object, names = /* @__PURE__ */ new Set());
      names.add(name);
      layers.add(label);
      restores.push(() => {
        if (object[name] !== wrapper) return;
        if (descriptor) Object.defineProperty(object, name, descriptor);
        else delete object[name];
      });
      return true;
    }
    async function rewrite(value, method, signal, options = {}) {
      if (disposed || !transformer?.[method]) return value;
      if (signal?.aborted) throw abortError2();
      if (value && typeof value === "object" && enhanced.has(value)) return value;
      const controller = new AbortController();
      const onAbort = () => controller.abort(signal.reason);
      signal?.addEventListener?.("abort", onAbort, { once: true });
      controllers.add(controller);
      try {
        const result = await transformer[method](value, { ...options, signal: controller.signal });
        if (signal?.aborted) throw abortError2();
        if (disposed) return value;
        if (result !== value && result && typeof result === "object") enhanced.add(result);
        return result;
      } catch (error) {
        if (signal?.aborted) throw abortError2();
        if (disposed) return value;
        counts.failures++;
        log("rewrite-failure", { method, code: error?.code ?? "JPT_REWRITE_FAILED" });
        if (error?.fatal || error?.strict || error?.storageFailure || ["JPT_STORAGE_FAILED", "JPT_STORAGE"].includes(error?.code) || isStrict()) throw error;
        return value;
      } finally {
        controllers.delete(controller);
        signal?.removeEventListener?.("abort", onAbort);
      }
    }
    async function rewriteHTTP(response, target, args) {
      const info = requestURI(target, args);
      if (!info || args[1]?.[OWN_REQUEST] || target?.[OWN_REQUEST] || !response) return response;
      const signal = args[1]?.signal ?? target?._abortSignal;
      const status2 = response.status ?? response.statusCode ?? 200;
      if (status2 < 200 || status2 >= 300) return response;
      if (typeof response === "object" && inFlight.has(response)) return inFlight.get(response);
      const operation = (async () => {
        const hasBody = typeof response === "object" && Object.hasOwn(response, "body");
        const body = hasBody ? response.body : response;
        const raw = bytes2(body);
        const method = info.type === "metadata" ? "rewriteMetadata" : "rewriteJSON";
        if (info.type === "metadata" && !raw) return response;
        const output = await rewrite(raw ?? body, method, signal, { uri: info.uri, trackURI: info.uri, priority: 1 });
        if (output === (raw ?? body)) return response;
        counts.http++;
        if (!hasBody) return output;
        const result = Object.assign(Object.create(Object.getPrototypeOf(response)), response, { body: output });
        enhanced.add(result);
        return result;
      })();
      if (typeof response === "object") inFlight.set(response, operation);
      try {
        return await operation;
      } finally {
        if (typeof response === "object") inFlight.delete(response);
      }
    }
    function methodCodec(request) {
      const record = codecServices.get(request?.service);
      if (!record) return null;
      const method = Object.entries(record.methods).find(([key2, value]) => key2.toLowerCase() === String(request.method).toLowerCase() || value.name === request.method || value.method === request.method)?.[1];
      if (!method?.responseType?.decode || !method.responseType.encode) return null;
      const name = String(request.method).toLowerCase();
      if (record.kind === "metadata" && !["observe", "fetch"].includes(name)) return null;
      if (record.kind === "player" && !["getstate", "getqueue", "getplayhistory"].includes(name)) return null;
      if (record.kind === "list" && !["get", "subscribe"].includes(name)) return null;
      return {
        codec: method.responseType,
        requestCodec: method.requestType,
        kind: record.kind,
        wireSchema: NATIVE_WIRE_SCHEMAS[record.kind]?.[name] ?? {}
      };
    }
    async function rewriteWire(payload, record, signal) {
      if (disposed) return payload;
      const raw = bytes2(payload);
      if (!raw) return payload;
      let decoded, canonicalBefore;
      try {
        decoded = record.codec.decode(raw);
        canonicalBefore = record.codec.encode(decoded).finish();
      } catch (cause) {
        const error = new Error("A Spotify bridge response could not be decoded.");
        error.code = "JPT_PARSE_FAILED";
        if (isStrict()) throw error;
        counts.failures++;
        log("bridge-decode-failure", { kind: record.kind });
        return payload;
      }
      const method = record.kind === "player" ? "rewritePlayer" : "rewriteNative";
      let prepared, preparedFor;
      const prepare = (candidate) => {
        try {
          return overlayKnownWire(raw, canonicalBefore, record.codec.encode(candidate).finish(), record.wireSchema);
        } catch (cause) {
          throw Object.assign(new Error("A Spotify bridge response could not be encoded losslessly."), { code: "JPT_PARSE_FAILED" });
        }
      };
      const result = await rewrite(decoded, method, signal, { priority: 3, validate(candidate) {
        prepared = prepare(candidate);
        preparedFor = candidate;
      } });
      if (result === decoded) return payload;
      try {
        const encoded2 = preparedFor === result ? prepared : prepare(result);
        if (encoded2 === raw) return payload;
        counts[record.kind === "player" ? "player" : "native"]++;
        return encoded2;
      } catch {
        const error = new Error("A Spotify bridge response could not be encoded.");
        error.code = "JPT_PARSE_FAILED";
        if (isStrict()) throw error;
        counts.failures++;
        return payload;
      }
    }
    function serialCallback(callback, transform, originalCancel, onError, dropOnDispose = false, latestOnly = false) {
      let chain = Promise.resolve();
      let cancelled = false;
      let latestSequence = 0;
      const controller = new AbortController();
      const cancel = () => {
        if (cancelled) return;
        cancelled = true;
        controller.abort();
        streamCancellations.delete(cancel);
        streamDetachments.delete(detach);
        originalCancel?.();
      };
      const detach = () => {
        controller.abort();
        streamCancellations.delete(cancel);
        streamDetachments.delete(detach);
      };
      streamCancellations.add(cancel);
      streamDetachments.add(detach);
      return {
        callback(...args) {
          if (cancelled || disposed && dropOnDispose) return;
          const receiver = this;
          const sequence = ++latestSequence;
          chain = chain.then(async () => {
            if (cancelled || disposed && dropOnDispose) return;
            if (latestOnly && sequence !== latestSequence) return;
            let value = args[0];
            try {
              if (!disposed) value = await transform(args[0], controller.signal);
            } catch (error) {
              if (cancelled || disposed && dropOnDispose) return;
              if (!disposed) {
                log("stream-stopped", { code: error?.code ?? "JPT_DELIVERY_FAILED" });
                onError?.(error);
                cancel();
                return;
              }
            }
            if (!cancelled && !(disposed && dropOnDispose)) Reflect.apply(callback, receiver, [value, ...args.slice(1)]);
          }).catch((error) => {
            if (cancelled || disposed) return;
            log("stream-stopped", { code: error?.code ?? "JPT_DELIVERY_FAILED" });
            onError?.(error);
            cancel();
          });
        },
        cancel,
        setCancel(fn) {
          originalCancel = fn;
          if (cancelled) originalCancel?.();
        }
      };
    }
    function installNative(client, kind) {
      if (!client) return false;
      const service = client.constructor?.SERVICE_ID;
      const methods = client.constructor?.METHODS;
      if (!service || !methods) return false;
      codecServices.set(service, { methods, kind });
      const transport = client.transport;
      patch(transport, "callSingle", (original) => function(request, options) {
        const record = methodCodec(request);
        const result = Reflect.apply(original, this, arguments);
        return !record || request?.[OWN_REQUEST] ? result : Promise.resolve(result).then((value) => rewriteWire(value, record, options?.signal));
      }, "native-single");
      patch(transport, "callStream", (original) => function(request, callback) {
        const record = methodCodec(request);
        if (!record || request?.[OWN_REQUEST] || typeof callback !== "function") return Reflect.apply(original, this, arguments);
        const scope = facadeScope;
        const requestURIs = /* @__PURE__ */ new Set();
        try {
          collectURIs(record.requestCodec?.decode?.(request.payload), requestURIs);
        } catch {
        }
        const delivery = serialCallback(
          callback,
          (value, signal) => rewriteWire(value, record, signal),
          void 0,
          (error) => {
            scope?.reject(error);
            for (const pending of activeFacades) {
              if ([...requestURIs].some((uri) => pending.uris.has(uri))) pending.reject(error);
            }
          }
        );
        let subscription;
        try {
          subscription = Reflect.apply(original, this, [request, delivery.callback]);
        } catch (error) {
          delivery.cancel();
          throw error;
        }
        delivery.setCancel(() => subscription?.cancel?.());
        return { ...subscription, cancel: delivery.cancel };
      }, "native-stream");
      return true;
    }
    function installMetadataFacade(metadata) {
      if (!metadata) return;
      const native = installNative(metadata._metadataServiceClient, "metadata");
      for (const name of ["fetch", "fetchBatched"]) {
        patch(metadata, name, (original) => function(...args) {
          if (!native) return Promise.resolve(Reflect.apply(original, this, args)).then((value) => rewrite(value, "rewriteNative"));
          let reject;
          const failed = new Promise((_, fail) => {
            reject = fail;
          });
          const pending = { reject, uris: /* @__PURE__ */ new Set() };
          collectURIs(args, pending.uris);
          activeFacades.add(pending);
          const prior = facadeScope;
          facadeScope = pending;
          let output;
          try {
            output = Reflect.apply(original, this, args);
          } catch (error) {
            activeFacades.delete(pending);
            throw error;
          } finally {
            facadeScope = prior;
          }
          return Promise.race([output, failed]).finally(() => activeFacades.delete(pending));
        }, `metadata-${name}`);
      }
      if (native) return;
      patch(metadata, "subscribe", (original) => function(callback, ...args) {
        if (typeof callback !== "function") return Reflect.apply(original, this, arguments);
        const delivery = serialCallback(callback, (value, signal) => rewrite(value, "rewriteNative", signal));
        const subscription = Reflect.apply(original, this, [delivery.callback, ...args]);
        delivery.setCancel(() => subscription?.cancel?.());
        return { ...subscription, cancel: delivery.cancel };
      }, "metadata-subscribe");
    }
    function refresh() {
      if (disposed) return;
      const platform = Spicetify?.Platform;
      if (!platform) return;
      const transport = platform.Transport ?? platform.RequestBuilder?.transport ?? platform.RequestBuilder?._transport;
      const hasTransport = patch(transport, "request", (original) => function(...args) {
        const output = Reflect.apply(original, this, args);
        return classifyURL(args[0]) ? Promise.resolve(output).then((value) => rewriteHTTP(value, null, args)) : output;
      }, "http-transport");
      if (!hasTransport) {
        const implementation = platform.RequestBuilder?._RequestImplementation?.prototype;
        const hasImplementation = patch(implementation, "send", (original) => function(...args) {
          return Promise.resolve(Reflect.apply(original, this, args)).then((value) => rewriteHTTP(value, this, args));
        }, "http-request-implementation");
        if (!hasImplementation) patch(platform.RequestBuilder, "build", (original) => function(...args) {
          const request = Reflect.apply(original, this, args);
          patch(request, "send", (send) => function(...sendArgs) {
            return Promise.resolve(Reflect.apply(send, this, sendArgs)).then((value) => rewriteHTTP(value, this, sendArgs));
          }, "http-request-builder");
          return request;
        }, "http-request-builder-factory");
      }
      installMetadataFacade(platform.PlaylistAPI?._metadataExtensionsAPI);
      installMetadataFacade(platform.LibraryAPI?._metadataExtensionsAPI);
      installNative(platform.PlayerAPI?._contextPlayer, "player");
      installNative(platform.PlaylistAPI?._playlistDataClient, "list");
      installNative(platform.ListPlatformAPI?._playlistDataClient, "list");
      const events = platform.PlayerAPI?._events;
      const eventMethod = typeof events?.emit === "function" ? "emit" : "emitSync";
      patch(events, eventMethod, (original) => {
        const delivery = serialCallback(function(args) {
          return Reflect.apply(original, events, args);
        }, async (args, signal) => {
          const event = args[1];
          const wrapped = event && Object.hasOwn(event, "data");
          const data = wrapped ? event.data : event;
          if (!data || typeof data !== "object") return args;
          const result = await rewrite(data, "rewritePlayer", signal, { priority: 3 });
          if (result !== data) counts.player++;
          return result === data ? args : [args[0], wrapped ? { ...event, data: result } : result, ...args.slice(2)];
        }, void 0, void 0, true, true);
        return function(...args) {
          if (args[0] !== "update" || !args[1] || typeof args[1] !== "object") return Reflect.apply(original, this, args);
          delivery.callback(args);
        };
      }, `player-events-${eventMethod}`);
      const currentState = platform.PlayerAPI?.getState?.() ?? platform.PlayerAPI?._state;
      if (currentState && typeof events?.[eventMethod] === "function") events[eventMethod]("update", currentState);
      return status();
    }
    function status() {
      return { disposed, layers: [...layers], counts: { ...counts }, streams: streamCancellations.size };
    }
    function dispose() {
      if (disposed) return;
      disposed = true;
      for (const controller of controllers) controller.abort();
      for (const detach of [...streamDetachments]) detach();
      for (const pending of activeFacades) pending.reject(abortError2());
      for (const restore of restores.reverse()) {
        try {
          restore();
        } catch {
          log("hook-restore-failure", { code: "JPT_RESTORE_FAILED" });
        }
      }
      restores.length = 0;
    }
    try {
      refresh();
    } catch (error) {
      dispose();
      throw error;
    }
    return { dispose, status, refresh };
  }
  function collectURIs(value, output, depth = 0, seen = /* @__PURE__ */ new Set()) {
    if (typeof value === "string") {
      if (/^spotify:(track|album|artist):[A-Za-z0-9]+$/.test(value)) output.add(value);
      return;
    }
    if (!value || typeof value !== "object" || depth > 8 || seen.has(value) || ArrayBuffer.isView(value)) return;
    seen.add(value);
    for (const item of Object.values(value)) collectURIs(item, output, depth + 1, seen);
  }

  // src/management.mjs
  var SETTINGS_KEY = "jp-original-title-spicetify.settings";
  var observedURIs = (resolver) => [.../* @__PURE__ */ new Set([
    ...resolver.observedUris || [],
    ...resolver.clients?.keys?.() || []
  ])];
  async function applyResetActions({ plugin, metadata, store, resolver, refreshMetadata }) {
    if (!plugin && !metadata) return false;
    const uris = observedURIs(resolver);
    if (metadata) await refreshMetadata(uris);
    if (plugin) {
      await store.reset();
      resolver.clear();
    }
    return true;
  }
  function createSettings(storage = globalThis.localStorage) {
    let value = { strict: false, logging: false, installChoice: false, combineTitles: true };
    try {
      value = { ...value, ...JSON.parse(storage.getItem(SETTINGS_KEY) || "{}") };
    } catch {
    }
    return {
      get strict() {
        return value.strict === true;
      },
      get logging() {
        return value.logging === true;
      },
      get installChoice() {
        return value.installChoice === true;
      },
      get combineTitles() {
        return value.combineTitles !== false;
      },
      snapshot() {
        return { ...value };
      },
      update(patch) {
        const next = { ...value, ...patch };
        storage.setItem(SETTINGS_KEY, JSON.stringify(next));
        value = next;
      }
    };
  }
  function installManagement({ Spicetify: S, store, resolver, hooks, settings, log, diagnostics, buildID, version, channel = "local-development" }) {
    const disposables = [];
    const element = (tag, content, parent) => {
      const node = document.createElement(tag);
      if (content !== void 0) node.textContent = content;
      parent?.append(node);
      return node;
    };
    const notify = (message) => S.showNotification?.(message);
    async function refreshMetadata(uris = observedURIs(resolver)) {
      const api = S.Platform.PlaylistAPI?._metadataExtensionsAPI;
      if (!api?.expire) throw new Error("Metadata refresh is unavailable in this Spotify client");
      await api.expire(...uris.map((uri) => [uri, 178, ...uri.startsWith("spotify:track:") ? [10, 186] : uri.startsWith("spotify:album:") ? [9] : [8]]));
      resolver.clear();
      resolver.restore?.();
      await hooks.refresh?.();
      return uris.length;
    }
    const saveFile = () => {
      const report = {
        name: "JP Original Title (Spicetify)",
        channel,
        version,
        buildID,
        settings: settings.snapshot(),
        hooks: hooks.status(),
        lookup: resolver.stats(),
        storage: store.stats(),
        diagnostics: diagnostics()
      };
      const url = URL.createObjectURL(new Blob([JSON.stringify(report, null, 2)], { type: "application/json" }));
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "jp-original-title-diagnostics.json";
      anchor.click();
      setTimeout(() => URL.revokeObjectURL(url), 1e3);
    };
    function button(parent, label, action) {
      const node = element("button", label, parent);
      node.type = "button";
      node.style.cssText = "padding:8px 14px;margin:6px 8px 6px 0;border:1px solid #777;border-radius:18px;background:transparent;color:inherit;cursor:pointer";
      node.addEventListener("click", async () => {
        node.disabled = true;
        try {
          await action();
        } catch (error) {
          log("management-error", error.message);
          notify(error.message);
        } finally {
          node.disabled = false;
        }
      });
      return node;
    }
    function checkbox(parent, label, checked, change) {
      const row = element("label", void 0, parent);
      row.style.cssText = "display:flex;gap:10px;align-items:center;margin:12px 0";
      const input = element("input", void 0, row);
      input.type = "checkbox";
      input.checked = checked;
      element("span", label, row);
      input.addEventListener("change", () => change?.(input.checked));
      return input;
    }
    function show() {
      const body = element("div");
      body.style.cssText = "max-width:640px;line-height:1.6;padding-bottom:12px";
      element("p", `${version ? `v${version}` : "Local development build"} \xB7 ${buildID}`, body);
      const summary = element("p", void 0, body);
      const update = () => {
        const s = store.stats();
        summary.textContent = `${s.lookupEntities ?? 0} cached tracks/albums \xB7 ${s.artistNames} artist names \xB7 ${s.previousFields} previous fields \xB7 ${(s.bytes / 1024).toFixed(1)} KB stored data (estimate)`;
      };
      update();
      const combined = checkbox(body, "Show original and previous song titles", settings.combineTitles, async (value) => {
        combined.disabled = true;
        try {
          settings.update({ combineTitles: value });
          await refreshMetadata();
          notify("Title display saved. Reopen the page to update existing titles.");
        } catch (error) {
          combined.checked = settings.combineTitles;
          log("title-display-refresh-error", error.message);
          notify("Reopen pages or restart Spotify to apply the saved title display setting.");
        } finally {
          combined.disabled = false;
        }
      });
      element("p", "Show changed songs as Original title\uFF5CPrevious title. Turn off to show only the original title.", body);
      checkbox(body, "Strict Mode", settings.strict, (value) => settings.update({ strict: value }));
      element("p", "Strict Mode blocks enhanced responses when a lookup or parsing fails. It can prevent pages from loading.", body);
      checkbox(body, "Diagnostic logging", settings.logging, (value) => settings.update({ logging: value }));
      const actions = element("div", void 0, body);
      button(actions, "Export Diagnostics", saveFile);
      button(actions, "Clear Diagnostics", () => {
        diagnostics(true);
        notify("Diagnostics cleared.");
      });
      element("hr", void 0, body);
      const plugin = checkbox(body, "Reset Plugin Cache", false);
      const metadata = checkbox(body, "Refresh Viewed Spotify Metadata", false);
      element("p", "Metadata refresh covers entities observed by this extension. Playback resume, login, audio downloads and other extensions are retained.", body);
      element("p", "Playback resume reset is unavailable in a desktop extension.", body);
      button(body, "Apply", async () => {
        const applied = await applyResetActions({
          plugin: plugin.checked,
          metadata: metadata.checked,
          store,
          resolver,
          refreshMetadata
        });
        if (!applied) {
          notify("Select an action first.");
          return;
        }
        plugin.checked = false;
        metadata.checked = false;
        settings.update({ lastReset: (/* @__PURE__ */ new Date()).toISOString() });
        update();
        notify("Selected actions completed.");
      });
      if (settings.snapshot().lastReset) element("p", `Last reset: ${new Date(settings.snapshot().lastReset).toLocaleString()}`, body);
      const detail = element("details", void 0, body);
      element("summary", "Connection Status", detail);
      element("pre", JSON.stringify(hooks.status(), null, 2), detail).style.cssText = "white-space:pre-wrap;font-size:12px";
      S.PopupModal.display({ title: "JP Original Title (Spicetify)", content: body, isLarge: true });
    }
    if (S.Menu?.Item) {
      const item = new S.Menu.Item("JP Original Title (Spicetify)", false, show);
      item.register();
      disposables.push(() => item.deregister());
    }
    if (S.Topbar?.Button) {
      try {
        const item = new S.Topbar.Button("JP Original Title", "edit", show);
        disposables.push(() => item.element?.remove());
      } catch {
      }
    }
    function offerSetup() {
      if (settings.installChoice) return;
      const body = element("div");
      element("p", "Clear plugin data and refresh metadata already viewed in this session?", body);
      element("p", "Playback resume and audio downloads are retained.", body);
      button(body, "Cancel", () => {
        settings.update({ installChoice: true });
        S.PopupModal.hide();
      });
      button(body, "Confirm", async () => {
        await applyResetActions({ plugin: true, metadata: true, store, resolver, refreshMetadata });
        settings.update({ installChoice: true });
        S.PopupModal.hide();
      });
      S.PopupModal.display({ title: "JP Original Title (Spicetify)", content: body });
    }
    return { show, offerSetup, refreshMetadata, dispose() {
      for (const dispose of disposables.reverse()) dispose();
    } };
  }

  // src/index.mjs
  var BUILD = false ? "source-development" : "5acefc37dc69";
  var VERSION = false ? void 0 : "1.1.4";
  var CHANNEL = VERSION ? "release" : "local-development";
  var NAME = "JP Original Title (Spicetify)";
  var STARTUP = /* @__PURE__ */ Symbol.for("JPOriginalTitle.startup");
  async function start({
    host = globalThis,
    components = {},
    now = Date.now,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    schedule = setTimeout,
    cancelSchedule = clearTimeout
  } = {}) {
    host[STARTUP]?.dispose?.();
    host.JPOriginalTitle?.dispose?.();
    const cleanups = [];
    let disposed = false;
    let api;
    const lifecycle = { dispose() {
      if (disposed) return;
      disposed = true;
      for (const cleanup of cleanups.reverse()) {
        try {
          cleanup();
        } catch {
        }
      }
      if (host[STARTUP] === lifecycle) delete host[STARTUP];
    } };
    host[STARTUP] = lifecycle;
    try {
      const deadline = now() + 6e4;
      while (!host.Spicetify?.Platform?.PlayerAPI || !host.Spicetify?.PopupModal || !host.Spicetify?.Platform?.RequestBuilder || !host.Spicetify?.ReactJSX?.jsx || !host.Spicetify?.React?.createElement || !host.Spicetify?.Menu?.Item) {
        if (disposed) return null;
        if (now() > deadline) throw new Error("Spicetify APIs did not become available");
        await sleep(100);
      }
      if (disposed) return null;
      const S = host.Spicetify;
      const settings = (components.createSettings ?? createSettings)();
      const events = [];
      const log = (event, details) => {
        if (!settings.logging) return;
        const safe = JSON.stringify(details, (key2, value) => {
          if (/authorization|accesstoken|refreshtoken|cookie/i.test(key2)) return "[redacted]";
          if (value instanceof Error) return { name: value.name, message: value.message, code: value.code };
          return typeof value === "string" ? value.replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]") : value;
        });
        events.push({ timestamp: (/* @__PURE__ */ new Date()).toISOString(), event: String(event), details: safe });
        if (events.length > 1e3) events.shift();
      };
      const diagnostics = (clear) => {
        const result = events.slice();
        if (clear) events.length = 0;
        return result;
      };
      const store = new (components.Store ?? Store)();
      cleanups.push(() => store.close());
      await store.open();
      if (disposed) {
        store.close();
        return null;
      }
      const originalFetch = host.fetch.bind(host);
      const request = (components.createRequest ?? createRequest)({ Spicetify: S, fetch: originalFetch, log });
      const market = /^[A-Z]{2}$/.test(S.Platform.Session?.market ?? "") ? S.Platform.Session.market : "US";
      const product = S.Platform.initialProductState?.product === "free" ? "free" : "premium";
      const resolver = new (components.Resolver ?? Resolver)({ request, store, scope: `${market}:${product}`, isStrict: () => settings.strict, log });
      cleanups.push(() => resolver.clear());
      const transformer = (components.createTransformer ?? createTransformer)({ resolver, store, isStrict: () => settings.strict, combineTitles: () => settings.combineTitles, log });
      const hooks = (components.installHooks ?? installHooks)({ Spicetify: S, transformer, isStrict: () => settings.strict, log });
      cleanups.push(() => hooks.dispose());
      const management = (components.installManagement ?? installManagement)({ Spicetify: S, store, resolver, hooks, settings, log, diagnostics, buildID: BUILD, version: VERSION, channel: CHANNEL });
      cleanups.push(() => management.dispose());
      api = host.JPOriginalTitle = {
        name: NAME,
        buildID: BUILD,
        version: VERSION,
        channel: CHANNEL,
        status: () => ({ name: NAME, buildID: BUILD, version: VERSION, channel: CHANNEL, disposed, hooks: hooks.status(), lookup: resolver.stats(), storage: store.stats(), settings: settings.snapshot() }),
        showSettings: management.show,
        resolver,
        transformer,
        store,
        hooks,
        settings,
        dispose: lifecycle.dispose
      };
      await hooks.refresh?.();
      if (disposed) return null;
      if (!settings.installChoice) {
        const timer = schedule(() => {
          if (disposed) return;
          try {
            management.offerSetup();
          } catch (error) {
            log("setup-prompt-failure", error);
          }
        }, 1200);
        cleanups.push(() => cancelSchedule(timer));
      }
      host.console?.info?.(`[${NAME}] ${VERSION ? `v${VERSION}` : "Local development build"} ${BUILD} loaded.`);
      return api;
    } catch (error) {
      const superseded = disposed || host[STARTUP] !== lifecycle;
      lifecycle.dispose();
      if (host.JPOriginalTitle === api) delete host.JPOriginalTitle;
      if (superseded) return null;
      throw error;
    }
  }
  if (typeof document !== "undefined") start().catch((error) => {
    const message = String(error.message).replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]");
    console.error(`[${NAME}] ${message}`);
    globalThis.JPOriginalTitle = { name: NAME, buildID: BUILD, error: message, status: () => ({ error: message }) };
  });
})();
