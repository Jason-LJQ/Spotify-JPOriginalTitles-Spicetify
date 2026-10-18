import test from 'node:test';
import assert from 'node:assert/strict';
import { installHooks } from '../src/hooks.mjs';
import { concat, fields, ld, vi } from '../src/wire.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const identity = () => ({ rewriteJSON: async x => x, rewriteNative: async x => x, rewriteMetadata: async x => x, rewritePlayer: async x => x });
const graphql = 'https://api-partner.spotify.com/pathfinder/v2/query';
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const codec = { decode: data => JSON.parse(decoder.decode(fields(data).find(field => field.field === 100).data)),
  encode: data => ({ finish: () => ld(100, encoder.encode(JSON.stringify(data))) }) };
const encode = data => codec.encode(data).finish();

function nativeFixture() {
  const streams = [];
  let cancelled = 0;
  const transport = {
    callStream(request, callback) { streams.push({ request, callback }); return { cancel() { cancelled++; } }; },
    async callSingle() { return encode({ extensionResult: [], pendingResponse: false }); },
  };
  class MetadataClient {
    static SERVICE_ID = 'spotify.mdata_esperanto.proto.MetadataService';
    static METHODS = { observe: { responseType: codec, requestType: codec }, fetch: { responseType: codec, requestType: codec } };
    transport = transport;
    observe(request, callback) { return this.transport.callStream({ service: MetadataClient.SERVICE_ID, method: 'Observe', payload: encode(request) }, bytes => callback(codec.decode(bytes))); }
  }
  const client = new MetadataClient();
  const metadata = {
    _metadataServiceClient: client,
    fetch(...args) {
      return new Promise(resolve => {
        let subscription;
        subscription = client.observe({ extensionQuery: args }, value => {
          if (!value.pendingResponse) { subscription.cancel(); resolve(value); }
        });
      });
    },
  };
  const Spicetify = { Platform: { PlaylistAPI: { _metadataExtensionsAPI: metadata } } };
  return { Spicetify, transport, streams, client, metadata, cancellations: () => cancelled };
}

test('HTTP response rewriting preserves envelope and forwards GraphQL track context', async () => {
  const original = { status: 200, headers: { custom: 'same' }, body: { name: 'before' }, extra: 42 };
  let options;
  const transport = { async request() { return original; } };
  const originalMethod = transport.request;
  const transformer = identity();
  transformer.rewriteJSON = async (value, opts) => { options = opts; return { ...value, name: 'after' }; };
  const hooks = installHooks({ Spicetify: { Platform: { Transport: transport } }, transformer });
  const response = await transport.request(`${graphql}?variables=${encodeURIComponent(JSON.stringify({ trackUri: 'spotify:track:ABC' }))}`);
  assert.equal(response.body.name, 'after');
  assert.equal(original.body.name, 'before');
  assert.equal(response.extra, 42);
  assert.equal(response.headers, original.headers);
  assert.equal(options.uri, 'spotify:track:ABC');
  assert.equal(options.trackURI, 'spotify:track:ABC');
  hooks.dispose();
  assert.equal(transport.request, originalMethod);
});

test('HTTP POST variables reach Credits transformer', async () => {
  let context;
  const transformer = identity();
  transformer.rewriteJSON = async (value, options) => { context = options; return value; };
  const transport = { async request() { return { status: 200, body: {} }; } };
  const hooks = installHooks({ Spicetify: { Platform: { Transport: transport } }, transformer });
  await transport.request(graphql, { payload: JSON.stringify({ variables: { trackUri: 'spotify:track:DEF' } }) });
  assert.equal(context.uri, 'spotify:track:DEF');
  hooks.dispose();
});

test('HTTP hooks ignore non-target domains, user playlists, failures, and own requests', async () => {
  let rewrites = 0;
  const transformer = identity();
  transformer.rewriteJSON = async value => { rewrites++; return value; };
  const transport = { request(url) { return Promise.resolve({ status: url.includes('failure') ? 500 : 200, body: {} }); } };
  const hooks = installHooks({ Spicetify: { Platform: { Transport: transport } }, transformer });
  await transport.request('https://example.com/pathfinder/v2/query');
  await transport.request('https://api.spotify.com/v1/playlists/id');
  await transport.request(`${graphql}?failure`);
  await transport.request(graphql, { [Symbol.for('JPOriginalTitles.ownRequest')]: true });
  assert.equal(rewrites, 0);
  hooks.dispose();
});

test('HTTP enhancement errors fail open by default and fail closed in strict mode', async () => {
  const original = { status: 200, body: {} };
  const transport = { async request() { return original; } };
  const transformer = identity();
  transformer.rewriteJSON = async () => { throw Object.assign(new Error('lookup'), { code: 'JPT_LOOKUP_FAILED' }); };
  let strict = false;
  const hooks = installHooks({ Spicetify: { Platform: { Transport: transport } }, transformer, isStrict: () => strict });
  assert.equal(await transport.request(graphql), original);
  strict = true;
  await assert.rejects(transport.request(graphql), { code: 'JPT_LOOKUP_FAILED' });
  hooks.dispose();
});

test('HTTP persistence failures reject even outside strict mode', async () => {
  const transformer = identity();
  transformer.rewriteJSON = async () => { throw Object.assign(new Error('storage'), { code: 'JPT_STORAGE', storageFailure: true }); };
  const transport = { async request() { return { status: 200, body: {} }; } };
  const hooks = installHooks({ Spicetify: { Platform: { Transport: transport } }, transformer });
  await assert.rejects(transport.request(graphql), { code: 'JPT_STORAGE' });
  hooks.dispose();
});

test('HTTP cancellation suppresses an asynchronous rewritten response', async () => {
  const gate = deferred();
  const transformer = identity();
  transformer.rewriteJSON = async () => gate.promise;
  const transport = { async request() { return { status: 200, body: {} }; } };
  const hooks = installHooks({ Spicetify: { Platform: { Transport: transport } }, transformer });
  const controller = new AbortController();
  const promise = transport.request(graphql, { signal: controller.signal });
  await tick();
  controller.abort();
  gate.resolve({ changed: true });
  await assert.rejects(promise, { name: 'AbortError' });
  hooks.dispose();
});

test('dispose restores methods and releases an in-flight HTTP response unchanged', async () => {
  const gate = deferred();
  const original = { status: 200, body: {} };
  const transformer = identity();
  transformer.rewriteJSON = async () => gate.promise;
  const transport = { async request() { return original; } };
  const originalMethod = transport.request;
  const hooks = installHooks({ Spicetify: { Platform: { Transport: transport } }, transformer });
  const promise = transport.request(graphql);
  await tick();
  hooks.dispose(); hooks.dispose();
  gate.resolve({ changed: true });
  assert.equal(await promise, original);
  assert.equal(transport.request, originalMethod);
});

test('RequestImplementation fallback enhances existing request instances', async () => {
  class Request { constructor() { this.url = graphql; } async send() { return { body: { name: 'before' } }; } }
  const instance = new Request();
  const originalMethod = Request.prototype.send;
  const transformer = identity();
  transformer.rewriteJSON = async value => ({ ...value, name: 'after' });
  const hooks = installHooks({ Spicetify: { Platform: { RequestBuilder: { _RequestImplementation: Request } } }, transformer });
  assert.equal((await instance.send()).body.name, 'after');
  hooks.dispose();
  assert.equal(Request.prototype.send, originalMethod);
});

test('RequestBuilder fallback wraps generated request and restores its send', async () => {
  const request = { host: 'https://api-partner.spotify.com', path: '/pathfinder/v2/query', async send() { return { body: {} }; } };
  const builder = { build() { return request; } };
  const originalSend = request.send;
  const transformer = identity(); transformer.rewriteJSON = async value => ({ ...value, changed: true });
  const hooks = installHooks({ Spicetify: { Platform: { RequestBuilder: builder } }, transformer });
  assert.equal((await builder.build().send()).body.changed, true);
  hooks.dispose();
  assert.equal(request.send, originalSend);
});

test('native codecs rewrite before generated client callback receives a response', async () => {
  const f = nativeFixture();
  const transformer = identity(); transformer.rewriteNative = async value => ({ ...value, changed: true });
  const hooks = installHooks({ Spicetify: f.Spicetify, transformer });
  const received = [];
  const sub = f.client.observe({}, value => received.push(value));
  f.streams[0].callback(encode({ pendingResponse: false }));
  await tick();
  assert.equal(received[0].changed, true);
  assert.equal(hooks.status().counts.native, 1);
  sub.cancel(); hooks.dispose();
});

test('native streams preserve callback order when first lookup is slower', async () => {
  const f = nativeFixture(); const gate = deferred();
  const transformer = identity();
  transformer.rewriteNative = async value => { if (value.sequence === 1) await gate.promise; return { ...value, changed: true }; };
  const hooks = installHooks({ Spicetify: f.Spicetify, transformer });
  const received = [];
  f.client.observe({}, value => received.push(value.sequence));
  f.streams[0].callback(encode({ sequence: 1 }));
  f.streams[0].callback(encode({ sequence: 2 }));
  await tick(); assert.deepEqual(received, []);
  gate.resolve(); await tick();
  assert.deepEqual(received, [1, 2]);
  hooks.dispose();
});

test('native cancellation cancels original once and prevents queued delivery', async () => {
  const f = nativeFixture(); const gate = deferred();
  const transformer = identity(); transformer.rewriteNative = async value => { await gate.promise; return { ...value, changed: true }; };
  const hooks = installHooks({ Spicetify: f.Spicetify, transformer });
  const received = [];
  const sub = f.client.observe({}, value => received.push(value));
  f.streams[0].callback(encode({})); await tick();
  sub.cancel(); sub.cancel(); gate.resolve(); await tick();
  assert.equal(f.cancellations(), 1); assert.deepEqual(received, []);
  hooks.dispose();
});

test('dispose keeps Spotify-owned native subscriptions alive in original pass-through mode', async () => {
  const f = nativeFixture(); const gate = deferred();
  const transformer = identity(); transformer.rewriteNative = async value => { await gate.promise; return { ...value, changed: true }; };
  const originalMethod = f.transport.callStream;
  const hooks = installHooks({ Spicetify: f.Spicetify, transformer });
  const received = [];
  const sub = f.client.observe({}, value => received.push(value));
  f.streams[0].callback(encode({ sequence: 1 })); await tick();
  hooks.dispose(); gate.resolve(); await tick();
  f.streams[0].callback(encode({ sequence: 2 })); await tick();
  assert.deepEqual(received, [{ sequence: 1 }, { sequence: 2 }]);
  assert.equal(f.transport.callStream, originalMethod);
  assert.equal(f.cancellations(), 0);
  sub.cancel(); assert.equal(f.cancellations(), 1);
});

test('unrelated native services are byte-for-byte untouched', async () => {
  const f = nativeFixture(); let rewrites = 0;
  const transformer = identity(); transformer.rewriteNative = async value => { rewrites++; return value; };
  const hooks = installHooks({ Spicetify: f.Spicetify, transformer });
  const received = []; const payload = new Uint8Array([255]);
  f.transport.callStream({ service: 'spotify.audio.Service', method: 'Observe' }, value => received.push(value));
  f.streams[0].callback(payload);
  assert.equal(received[0], payload); assert.equal(rewrites, 0);
  hooks.dispose();
});

test('strict native failure rejects facade fetch instead of leaving it pending', async () => {
  const f = nativeFixture(); const transformer = identity();
  transformer.rewriteNative = async () => { throw Object.assign(new Error('lookup'), { code: 'JPT_LOOKUP_FAILED', strict: true }); };
  const hooks = installHooks({ Spicetify: f.Spicetify, transformer });
  const promise = f.metadata.fetch(['spotify:track:ABC', 178]);
  f.streams[0].callback(encode({ extensionResult: [], pendingResponse: false }));
  await assert.rejects(promise, { code: 'JPT_LOOKUP_FAILED' });
  assert.equal(f.cancellations(), 1);
  hooks.dispose();
});

test('native decode failure preserves original bytes by default', async () => {
  const f = nativeFixture(); const hooks = installHooks({ Spicetify: f.Spicetify, transformer: identity() });
  const payload = new Uint8Array([255]); const received = [];
  f.transport.callStream({ service: f.client.constructor.SERVICE_ID, method: 'Observe' }, value => received.push(value));
  f.streams[0].callback(payload); await tick();
  assert.equal(received[0], payload);
  hooks.dispose();
});

test('native single responses propagate strict parser failures', async () => {
  const f = nativeFixture(); f.transport.callSingle = async () => new Uint8Array([255]);
  const hooks = installHooks({ Spicetify: f.Spicetify, transformer: identity(), isStrict: () => true });
  await assert.rejects(f.transport.callSingle({ service: f.client.constructor.SERVICE_ID, method: 'Fetch' }), { code: 'JPT_PARSE_FAILED' });
  hooks.dispose();
});

test('existing player event subscriptions receive transformed state before all listeners', async () => {
  const sent = [];
  const initial = { item: { uri: 'spotify:track:ABC', name: 'before' } };
  const events = { emit(type, state) { sent.push({ type, state }); } };
  const originalEmit = events.emit;
  const player = { _events: events, _state: initial, getState() { return this._state; } };
  const transformer = identity();
  transformer.rewritePlayer = async value => ({ ...value, item: { ...value.item, name: 'after' } });
  const hooks = installHooks({ Spicetify: { Platform: { PlayerAPI: player } }, transformer });
  await tick();
  assert.equal(sent[0].type, 'update'); assert.equal(sent[0].state.item.name, 'after');
  events.emit('other', initial);
  assert.equal(sent.at(-1).state, initial);
  hooks.dispose(); assert.equal(events.emit, originalEmit);
});

test('refresh is idempotent and dispose preserves a later third-party wrapper', () => {
  const transport = { async request() { return {}; } };
  const hooks = installHooks({ Spicetify: { Platform: { Transport: transport } }, transformer: identity() });
  const wrapped = transport.request;
  hooks.refresh(); assert.equal(transport.request, wrapped);
  const external = () => Promise.resolve('third-party'); transport.request = external;
  hooks.dispose(); assert.equal(transport.request, external);
});

test('native hook keeps unknown outer bytes when a generated codec drops them', async () => {
  const f = nativeFixture(); const transformer = identity();
  transformer.rewriteNative = async value => ({ ...value, changed: true });
  const hooks = installHooks({ Spicetify: f.Spicetify, transformer });
  const received = [];
  f.transport.callStream({ service: f.client.constructor.SERVICE_ID, method: 'Observe' }, value => received.push(value));
  const unknown = vi(299, 23);
  f.streams[0].callback(concat(encode({ pendingResponse: false }), unknown));
  await tick();
  assert.equal(codec.decode(received[0]).changed, true);
  assert.deepEqual(fields(received[0]).find(field => field.field === 299).raw, unknown);
  hooks.dispose();
});

test('partial hook installation is restored when the initial player state read throws', () => {
  const transport = { async request() { return {}; } };
  const original = transport.request;
  assert.throws(() => installHooks({ Spicetify: { Platform: { Transport: transport, PlayerAPI: {
    getState() { throw new Error('initial state failed'); }
  } } }, transformer: identity() }), /initial state failed/);
  assert.equal(transport.request, original);
});

test('player snapshot delivery skips superseded pending states without parallel rewrites', async () => {
  const gate = deferred(), sent = [], rewritten = [];
  const events = { emit(type, value) { sent.push(value.sequence); } };
  const transformer = identity();
  transformer.rewritePlayer = async value => {
    rewritten.push(value.sequence);
    if (value.sequence === 1) await gate.promise;
    return { ...value, changed: true };
  };
  const hooks = installHooks({ Spicetify: { Platform: { PlayerAPI: { _events: events } } }, transformer });
  try {
    events.emit('update', { sequence: 1 }); await tick();
    events.emit('update', { sequence: 2 });
    events.emit('update', { sequence: 3 });
    events.emit('update', { sequence: 4 });
    gate.resolve(); await tick(); await tick();
    assert.deepEqual(rewritten, [1, 4]);
    assert.deepEqual(sent, [1, 4]);
  } finally { hooks.dispose(); }
});
