import test from 'node:test';
import assert from 'node:assert/strict';
import { installHooks } from '../src/hooks.mjs';
import { createTransformer } from '../src/transform.mjs';
import { Store } from '../src/storage.mjs';
import { concat, fields, ld, text, vi } from '../src/wire.mjs';

const uri = 'spotify:track:0000000000000000000001';
const field = (data, number) => fields(data).find(item => item.field === number);
const entry = value => concat(ld(1, 'title'), ld(2, value));

// The generated player codec normalizes protobuf map duplicates with last-key-wins.
const playerCodec = {
  decode(data) {
    const provided = field(data, 7).data;
    const context = field(provided, 1).data;
    const metadata = {};
    for (const item of fields(context).filter(item => item.field === 3)) metadata[text(field(item.data, 1)) ?? ''] = text(field(item.data, 2)) ?? '';
    return { track: { contextTrack: { uri: text(field(context, 1)), metadata } } };
  },
  encode(value) {
    const context = value.track.contextTrack;
    const metadata = Object.entries(context.metadata).map(([key, value]) => ld(3, concat(ld(1, key), ld(2, value))));
    return { finish: () => ld(7, ld(1, concat(ld(1, context.uri), ...metadata))) };
  },
};

async function fixture(raw, strict = false) {
  let writes = 0;
  const store = await new Store({ adapter: {
    async load() { return { artist_names: [], previous_fields: [] }; },
    async write() { writes++; },
  } }).open();
  const preferred = { uri, name: 'After', artists: [] };
  const resolver = { async resolve() {
    return { tracks: new Map([[uri, preferred]]), sourceTracks: new Map([[uri, { uri, name: 'Before', artists: [] }]]),
      albums: new Map(), artistNames: new Map(), failures: [] };
  } };
  const transformer = createTransformer({ resolver, store, isStrict: () => strict });
  const transport = { async callSingle() { return raw; } };
  class Client {
    static SERVICE_ID = 'spotify.player.esperanto.ContextPlayer';
    static METHODS = { getState: { responseType: playerCodec } };
    transport = transport;
  }
  const hooks = installHooks({ Spicetify: { Platform: { PlayerAPI: { _contextPlayer: new Client() } } }, transformer, isStrict: () => strict });
  const request = () => transport.callSingle({ service: Client.SERVICE_ID, method: 'GetState' });
  return { hooks, request, store, writes: () => writes };
}

test('ambiguous native map overlay fails open before writing any undelivered previous value', async () => {
  const context = concat(ld(1, uri), ld(3, entry('Earlier')), ld(3, concat(entry('Before'), vi(90, 77))));
  const raw = ld(7, ld(1, context));
  const f = await fixture(raw);
  try {
    assert.equal(await f.request(), raw);
    assert.equal(f.writes(), 0);
    assert.deepEqual(f.store.getPrevious(uri), {});
    assert.equal(f.hooks.status().counts.failures, 1);
  } finally { f.hooks.dispose(); }
});

test('strict ambiguous native map overlay rejects before storage commit', async () => {
  const context = concat(ld(1, uri), ld(3, entry('Earlier')), ld(3, entry('Before')));
  const f = await fixture(ld(7, ld(1, context)), true);
  try {
    await assert.rejects(f.request(), { code: 'JPT_PARSE_FAILED' });
    assert.equal(f.writes(), 0);
    assert.deepEqual(f.store.getPrevious(uri), {});
  } finally { f.hooks.dispose(); }
});

test('validated native delivery commits old values and retains unknown bytes at every changed boundary', async () => {
  const context = concat(ld(1, uri), ld(3, concat(entry('Before'), vi(90, 77))), vi(91, 78));
  const raw = concat(ld(7, concat(ld(1, context), vi(92, 79))), vi(93, 80));
  const f = await fixture(raw);
  try {
    const output = await f.request();
    assert.equal(playerCodec.decode(output).track.contextTrack.metadata.title, 'After');
    assert.equal(f.writes(), 1);
    assert.equal(f.store.getPrevious(uri).title, 'Before');
    const provided = field(output, 7).data;
    const deliveredContext = field(provided, 1).data;
    assert.equal(field(field(deliveredContext, 3).data, 90).value, 77);
    assert.equal(field(deliveredContext, 91).value, 78);
    assert.equal(field(provided, 92).value, 79);
    assert.equal(field(output, 93).value, 80);
  } finally { f.hooks.dispose(); }
});
