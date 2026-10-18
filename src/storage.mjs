const DATABASE = 'jp-original-title-spicetify';
const validText = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 4096;
const normalize = value => Array.isArray(value) ? value.every(validText) ? value.join(', ') : '' : value;
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function mergePrevious(existing, observations) {
  const rank = Math.max(...observations.map(item => Number(item.priority) || 1));
  if (existing && existing.priority > rank) return existing;
  const items = observations.filter(item => (Number(item.priority) || 1) === rank);
  const finals = new Set(items.filter(item => Object.hasOwn(item, 'now')).map(item => normalize(item.now)));
  const olds = new Set(items.map(item => normalize(item.value)).filter(validText));
  const conflict = items.some(item => item.conflict) || finals.size > 1 || olds.size > 1;
  const suppressed = () => ({ value: '', priority: rank, suppressed: true });
  if (conflict || items.some(item => !validText(normalize(item.value)) && !Object.hasOwn(item, 'now'))) return suppressed();
  const now = finals.size ? [...finals][0] : undefined;
  let old = [...olds][0];
  if (now !== undefined) {
    if (!validText(now)) return suppressed();
    if (old === now) old = undefined;
    if (!old) return existing?.now === now ? { ...existing, priority: rank } : null;
    if (old === existing?.now) old = existing.value;
    if (old === now) return null;
  }
  return validText(old) ? { value: old, ...(now === undefined ? {} : { now }), priority: rank } : null;
}

function indexedAdapter(indexedDB, name) {
  let database;
  const transaction = (mode, callback) => new Promise((resolve, reject) => {
    const tx = database.transaction(['artist_names', 'previous_fields'], mode);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error || new Error('Database transaction failed'));
    tx.onabort = () => reject(tx.error || new Error('Database transaction aborted'));
    try { callback(tx); } catch (error) { tx.abort(); reject(error); }
  });
  return {
    async load() {
      database = await new Promise((resolve, reject) => {
        const req = indexedDB.open(name, 1);
        req.onupgradeneeded = () => {
          for (const table of ['artist_names', 'previous_fields']) {
            if (!req.result.objectStoreNames.contains(table)) req.result.createObjectStore(table, { keyPath: 'key' });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        req.onblocked = () => reject(new Error('Database upgrade blocked by another Spotify window'));
      });
      database.onversionchange = () => database.close();
      const data = {};
      await transaction('readonly', tx => {
        for (const table of ['artist_names', 'previous_fields']) {
          const request = tx.objectStore(table).getAll();
          request.onsuccess = () => { data[table] = request.result; };
        }
      });
      return data;
    },
    async write(artists, previous) {
      await transaction('readwrite', tx => {
        for (const [key, value] of artists) tx.objectStore('artist_names').put({ key, value });
        for (const [key, value] of previous) {
          if (value) tx.objectStore('previous_fields').put({ key, ...value });
          else tx.objectStore('previous_fields').delete(key);
        }
      });
    },
    async clear() {
      await transaction('readwrite', tx => {
        tx.objectStore('artist_names').clear();
        tx.objectStore('previous_fields').clear();
      });
    },
    close() { database?.close(); }
  };
}

export class Store {
  constructor({ indexedDB = globalThis.indexedDB, name = DATABASE, adapter } = {}) {
    if (!adapter && !indexedDB) throw new Error('IndexedDB is required for durable plugin storage');
    this.adapter = adapter || indexedAdapter(indexedDB, name);
    this.artists = new Map();
    this.previous = new Map();
    this.queue = Promise.resolve();
    this.ready = false;
  }
  async open() {
    const data = await this.adapter.load();
    this.artists = new Map((data.artist_names || []).map(row => [row.key, row.value]));
    this.previous = new Map((data.previous_fields || []).map(({ key, ...value }) => [key, value]));
    this.ready = true;
    return this;
  }
  getArtistNames() { return new Map(this.artists); }
  getPrevious(uri) {
    const result = {};
    for (const field of ['title', 'artists', 'album']) {
      const row = this.previous.get(`${uri}\t${field}`);
      if (row && validText(row.value)) result[field] = row.value;
    }
    return result;
  }
  getPreviousRecord(uri, field) { return this.previous.get(`${uri}\t${field}`); }
  enqueue(task) {
    const result = this.queue.then(task);
    this.queue = result.catch(() => {});
    return result;
  }
  commit({ artistNames = new Map(), previous = [], prepare } = {}) {
    return this.enqueue(async () => {
      if (!this.ready) throw new Error('Plugin storage is not open');
      const artists = new Map();
      const observations = new Map();
      const source = artistNames instanceof Map ? artistNames : Object.entries(artistNames);
      for (const [uri, name] of source) {
        if (uri.startsWith('spotify:artist:') && validText(name) && this.artists.get(uri) !== name) artists.set(uri, name);
      }
      for (const item of previous) {
        if (!item.uri?.startsWith('spotify:track:') || item.uri.length > 128 || !['title', 'artists', 'album'].includes(item.field)) continue;
        const key = `${item.uri}\t${item.field}`;
        if (!observations.has(key)) observations.set(key, []);
        observations.get(key).push(item);
      }
      const changes = new Map();
      for (const [key, items] of observations) {
        const value = mergePrevious(this.previous.get(key), items);
        if (!equal(value, this.previous.get(key) || null)) changes.set(key, value);
      }
      // Validate the final delivery against this transaction's projected values.
      await prepare?.({ getPrevious: uri => {
        const result = {};
        for (const field of ['title', 'artists', 'album']) {
          const key = `${uri}\t${field}`;
          const row = changes.has(key) ? changes.get(key) : this.previous.get(key);
          if (row && validText(row.value)) result[field] = row.value;
        }
        return result;
      } });
      if (!artists.size && !changes.size) return;
      try { await this.adapter.write(artists, changes); }
      catch (cause) {
        const error = new Error('Plugin storage commit failed; enhanced response withheld', { cause });
        error.code = 'JPT_STORAGE';
        error.storageFailure = true;
        throw error;
      }
      for (const [uri, name] of artists) this.artists.set(uri, name);
      for (const [key, value] of changes) value ? this.previous.set(key, value) : this.previous.delete(key);
    });
  }
  reset() {
    return this.enqueue(async () => {
      await this.adapter.clear();
      this.artists.clear();
      this.previous.clear();
    });
  }
  stats() {
    const rows = [...this.previous];
    const visible = rows.filter(([, row]) => validText(row.value));
    return { artistNames: this.artists.size, previousFields: visible.length, suppressedFields: rows.length - visible.length,
      tracks: new Set(visible.map(([key]) => key.split('\t')[0])).size,
      bytes: new TextEncoder().encode(JSON.stringify([[...this.artists], rows])).length };
  }
  close() { this.adapter.close?.(); }
}
