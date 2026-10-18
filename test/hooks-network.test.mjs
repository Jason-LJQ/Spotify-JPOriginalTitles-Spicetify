import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequest, METADATA_ENDPOINT } from '../src/network.mjs';
import { fields, text } from '../src/wire.mjs';

const spicetify = () => ({ Platform: { Session: { market: 'US' }, AuthorizationAPI: { _tokenProvider: { async getToken() { return { accessToken: 'private-test-token' }; } } } } });

test('lookup uses captured fetch, protobuf body, language and in-process authentication', async () => {
  let captured;
  const logs = [];
  const request = createRequest({ Spicetify: spicetify(), fetch: async (url, init) => {
    captured = { url, init }; return new Response(new Uint8Array([8, 1]));
  }, log: (...args) => logs.push(args) });
  const result = await request([{ uri: 'spotify:track:ABC', kinds: [10, 178] }], 'ja');
  assert.equal(captured.url, METADATA_ENDPOINT);
  assert.equal(captured.init.headers.Authorization, 'Bearer private-test-token');
  assert.equal(captured.init.headers['Accept-Language'], 'ja');
  assert.equal(captured.init.headers['Content-Type'], 'application/x-protobuf');
  assert.ok(captured.init.body instanceof Uint8Array);
  const header = fields(fields(captured.init.body).find(f => f.field === 1).data);
  assert.equal(text(header[0]), 'US'); assert.equal(text(header[1]), 'premium');
  assert.deepEqual(result, new Uint8Array([8, 1]));
  assert.ok(!JSON.stringify(logs).includes('private-test-token'));
});

test('country header ignores from_token and preserves a concrete market', async () => {
  for (const [market, expected] of [['from_token', 'US'], ['JP', 'JP']]) {
    const S = spicetify(); S.Platform.Session.market = market;
    const request = createRequest({ Spicetify: S, fetch: async (_, init) => {
      const header = fields(fields(init.body).find(f => f.field === 1).data);
      assert.equal(text(header[0]), expected);
      return new Response(new Uint8Array());
    } });
    await request([]);
  }
});

test('HTTP errors expose status and Retry-After without response body or credentials', async () => {
  const logs = [];
  const request = createRequest({ Spicetify: spicetify(), fetch: async () => new Response('private server text', { status: 429, headers: { 'retry-after': '10' } }), log: (...args) => logs.push(args) });
  await assert.rejects(request([]), error => error.status === 429 && error.statusCode === 429 && error.retryAfter === '10' && !error.message.includes('private'));
  assert.ok(!JSON.stringify(logs).includes('private'));
});

test('missing authentication fails before issuing a request', async () => {
  let sent = false;
  const request = createRequest({ Spicetify: { Platform: {} }, fetch: async () => { sent = true; } });
  await assert.rejects(request([]), { status: 401 });
  assert.equal(sent, false);
});

test('already aborted lookups never obtain authentication or send a request', async () => {
  let tokenReads = 0;
  const S = spicetify(); S.Platform.AuthorizationAPI._tokenProvider.getToken = async () => { tokenReads++; };
  const request = createRequest({ Spicetify: S, fetch: async () => assert.fail('Unexpected request') });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(request([], 'zh-Hans', controller.signal), { name: 'AbortError' });
  assert.equal(tokenReads, 0);
});

test('the captured fetch remains in use after the global fetch is replaced', async () => {
  let calls = 0;
  const original = globalThis.fetch;
  const request = createRequest({ Spicetify: spicetify(), fetch: async () => { calls++; return new Response(new Uint8Array()); } });
  try {
    globalThis.fetch = async () => assert.fail('Recursive hook was called');
    await request([]); assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});

test('204, 404 and 410 expose completed-absence status to the resolver', async () => {
  for (const status of [204, 404, 410]) {
    const logs = [];
    const request = createRequest({ Spicetify: spicetify(), fetch: async () => new Response(null, { status }), log: (...args) => logs.push(args) });
    await assert.rejects(request([]), { status, statusCode: status });
    assert.deepEqual(logs, []);
  }
});

test('lookup timeout bounds a fetch that ignores cancellation and remains retryable', async () => {
  const request = createRequest({ Spicetify: spicetify(), fetch: () => new Promise(() => {}), timeoutMs: 5 });
  await assert.rejects(request([]), { name: 'TimeoutError', code: 'JPT_TIMEOUT', timeout: true });
});

test('cancellation interrupts an outstanding token provider without sending HTTP', async () => {
  const S = spicetify(); S.Platform.AuthorizationAPI._tokenProvider.getToken = () => new Promise(() => {});
  const request = createRequest({ Spicetify: S, fetch: async () => assert.fail('Unexpected request') });
  const controller = new AbortController();
  const promise = request([], 'zh-Hans', controller.signal);
  controller.abort();
  await assert.rejects(promise, { name: 'AbortError' });
});
