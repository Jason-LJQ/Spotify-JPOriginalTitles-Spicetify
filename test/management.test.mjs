import test from 'node:test';
import assert from 'node:assert/strict';
import { applyResetActions, createSettings, observedURIs } from '../src/management.mjs';

test('combined reset expires an observed snapshot before clearing plugin state', async () => {
  const events=[];
  const resolver={observedUris:new Set(['spotify:track:a']),clients:new Map([['spotify:track:b',{}]]),
    clear(){events.push('clear');this.observedUris.clear();this.clients.clear();}};
  const store={async reset(){events.push('reset');}};
  await applyResetActions({plugin:true,metadata:true,store,resolver,
    async refreshMetadata(uris){events.push(uris);resolver.clear();}});
  assert.deepEqual(events,[['spotify:track:a','spotify:track:b'],'clear','reset','clear']);
});

test('plugin reset is independent and no selection performs no work', async () => {
  const events=[];
  const resolver={clear(){events.push('clear');}};
  const store={async reset(){events.push('reset');}};
  const refreshMetadata=async()=>events.push('metadata');
  assert.equal(await applyResetActions({plugin:false,metadata:false,store,resolver,refreshMetadata}),false);
  assert.deepEqual(events,[]);
  await applyResetActions({plugin:true,metadata:false,store,resolver,refreshMetadata});
  assert.deepEqual(events,['reset','clear']);
});

test('metadata-only reset preserves plugin data and propagates expiration errors', async () => {
  let cleared=false;
  const resolver={observedUris:new Set(['spotify:album:a'])};
  const store={async reset(){cleared=true;}};
  await assert.rejects(applyResetActions({plugin:false,metadata:true,store,resolver,
    async refreshMetadata(){throw new Error('expire failed');}}),/expire failed/);
  assert.equal(cleared,false);
});

test('settings survive cache actions and update only the namespaced entry', () => {
  const values=new Map([['other-extension','preserved']]);
  const storage={getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v)};
  const settings=createSettings(storage);
  settings.update({strict:true,installChoice:true});
  const reopened=createSettings(storage);
  assert.equal(reopened.strict,true);
  assert.equal(reopened.installChoice,true);
  assert.equal(values.get('other-extension'),'preserved');
  assert.deepEqual(observedURIs({observedUris:new Set(['a']),clients:new Map([['a',{}]])}),['a']);
});
