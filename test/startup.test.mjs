import test from 'node:test';
import assert from 'node:assert/strict';
import { start } from '../src/index.mjs';

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
  const events = [];
  const settings = { installChoice: false, strict: false, logging: false, snapshot: () => ({}) };
  const host = { Spicetify: { Platform: { PlayerAPI: {}, RequestBuilder: {} }, PopupModal: {},
    ReactJSX: { jsx() {} }, React: { createElement() {} }, Menu: { Item() {} } }, fetch() {}, console: { info() {} } };
  class Store {
    async open() { events.push('open'); return this; }
    close() { events.push('close'); }
    stats() { return {}; }
  }
  class Resolver {
    constructor() { events.push('resolver'); }
    clear() { events.push('clear'); }
    stats() { return {}; }
  }
  const hooks = { dispose() { events.push('hooks-dispose'); }, refresh() { events.push('refresh'); }, status() { return {}; } };
  const management = { dispose() { events.push('management-dispose'); }, show() {}, offerSetup() { events.push('offer'); } };
  const components = { Store, Resolver, createSettings: () => settings, createRequest: () => {}, createTransformer: () => ({}),
    installHooks: () => hooks, installManagement: () => management };
  let scheduled;
  const options = { host, components, schedule: callback => { scheduled = callback; events.push('schedule'); return 17; },
    cancelSchedule: id => { assert.equal(id, 17); events.push('cancel-timer'); } };
  return { host, events, components, options, hooks, management, settings, offer: () => scheduled?.() };
}

test('successful startup returns API and disposal cleans every resource once', async () => {
  const f = fixture();
  const api = await start(f.options);
  assert.equal(f.host.JPOriginalTitle, api); assert.equal(api.status().disposed, false);
  api.dispose(); api.dispose(); f.offer();
  assert.deepEqual(f.events, ['open', 'resolver', 'refresh', 'schedule', 'cancel-timer', 'management-dispose', 'hooks-dispose', 'clear', 'close']);
  assert.equal(api.status().disposed, true);
});

test('database open failure closes the partially opened store', async () => {
  const f = fixture();
  f.components.Store = class { async open() { throw new Error('open failed'); } close() { f.events.push('close-partial'); } };
  await assert.rejects(start(f.options), /open failed/);
  assert.deepEqual(f.events, ['close-partial']); assert.equal(f.host.JPOriginalTitle, undefined);
});

test('management installation failure restores hooks and closes database', async () => {
  const f = fixture(); f.components.installManagement = () => { throw new Error('management failed'); };
  await assert.rejects(start(f.options), /management failed/);
  assert.deepEqual(f.events, ['open', 'resolver', 'hooks-dispose', 'clear', 'close']);
  assert.equal(f.host.JPOriginalTitle, undefined);
});

test('initial refresh failure removes published API and all owned resources', async () => {
  const f = fixture(); f.hooks.refresh = async () => { throw new Error('refresh failed'); };
  await assert.rejects(start(f.options), /refresh failed/);
  assert.deepEqual(f.events, ['open', 'resolver', 'management-dispose', 'hooks-dispose', 'clear', 'close']);
  assert.equal(f.host.JPOriginalTitle, undefined);
});

test('a failing cleanup cannot prevent restoring hooks or closing storage', async () => {
  const f = fixture(); f.management.dispose = () => { throw new Error('cleanup failed'); };
  const api = await start(f.options); api.dispose();
  assert.ok(f.events.includes('hooks-dispose')); assert.equal(f.events.at(-1), 'close');
});

test('API wait retains the 60-second deadline and has no resource leak', async () => {
  const f = fixture(); f.host.Spicetify = {};
  let clock = 0;
  await assert.rejects(start({ ...f.options, now: () => clock, sleep: async () => { clock += 10000; } }), /APIs did not become available/);
  assert.deepEqual(f.events, []); assert.equal(f.host.JPOriginalTitle, undefined);
});

test('superseded startup cannot publish a second instance after delayed database opening', async () => {
  const f = fixture(); const opened = deferred();
  let instances = 0;
  f.components.Store = class {
    constructor() { this.id = ++instances; }
    async open() { if (this.id === 1) await opened.promise; return this; }
    close() { f.events.push(`close-${this.id}`); }
    stats() { return {}; }
  };
  const first = start(f.options); await tick();
  const second = await start(f.options);
  opened.resolve();
  assert.equal(await first, null);
  assert.equal(f.host.JPOriginalTitle, second);
  assert.ok(f.events.filter(event => event === 'close-1').length >= 1);
  assert.equal(f.events.filter(event => event === 'resolver').length, 1);
  second.dispose();
});

test('a replaced instance cancels the previous setup prompt', async () => {
  const f = fixture(); const first = await start(f.options);
  const second = await start(f.options);
  assert.equal(first.status().disposed, true);
  assert.equal(f.events.filter(event => event === 'cancel-timer').length, 1);
  second.dispose();
});
