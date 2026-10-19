import { Resolver } from './resolver.mjs';
import { Store } from './storage.mjs';
import { createTransformer } from './transform.mjs';
import { createRequest } from './network.mjs';
import { installHooks } from './hooks.mjs';
import { createSettings, installManagement } from './management.mjs';

const BUILD = typeof __JPT_BUILD__ === 'undefined' ? 'source-development' : __JPT_BUILD__;
const VERSION = typeof __JPT_VERSION__ === 'undefined' ? undefined : __JPT_VERSION__;
const CHANNEL = VERSION ? 'release' : 'local-development';
const NAME = 'JP Original Title (Spicetify)';
const STARTUP = Symbol.for('JPOriginalTitle.startup');
export async function start({ host = globalThis, components = {}, now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), schedule = setTimeout, cancelSchedule = clearTimeout } = {}) {
  host[STARTUP]?.dispose?.();
  host.JPOriginalTitle?.dispose?.();
  const cleanups = [];
  let disposed = false;
  let api;
  const lifecycle = { dispose() {
    if (disposed) return;
    disposed = true;
    for (const cleanup of cleanups.reverse()) {
      try { cleanup(); } catch { /* Every owned resource must get its cleanup attempt. */ }
    }
    if (host[STARTUP] === lifecycle) delete host[STARTUP];
  } };
  host[STARTUP] = lifecycle;
  try {
  const deadline = now() + 60000;
  while (!host.Spicetify?.Platform?.PlayerAPI || !host.Spicetify?.PopupModal ||
    !host.Spicetify?.Platform?.RequestBuilder || !host.Spicetify?.ReactJSX?.jsx ||
    !host.Spicetify?.React?.createElement || !host.Spicetify?.Menu?.Item) {
    if (disposed) return null;
    if (now() > deadline) throw new Error('Spicetify APIs did not become available');
    await sleep(100);
  }
  if (disposed) return null;
  const S = host.Spicetify;
  const settings = (components.createSettings ?? createSettings)();
  const events = [];
  const log = (event, details) => {
    if (!settings.logging) return;
    const safe = JSON.stringify(details, (key, value) => {
      if (/authorization|accesstoken|refreshtoken|cookie/i.test(key)) return '[redacted]';
      if (value instanceof Error) return { name: value.name, message: value.message, code: value.code };
      return typeof value === 'string' ? value.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]') : value;
    });
    events.push({ timestamp: new Date().toISOString(), event: String(event), details: safe });
    if (events.length > 1000) events.shift();
  };
  const diagnostics = clear => { const result = events.slice(); if (clear) events.length = 0; return result; };
  const store = new (components.Store ?? Store)();
  cleanups.push(() => store.close());
  await store.open();
  if (disposed) { store.close(); return null; }
  const originalFetch = host.fetch.bind(host);
  const request = (components.createRequest ?? createRequest)({ Spicetify: S, fetch: originalFetch, log });
  const market = /^[A-Z]{2}$/.test(S.Platform.Session?.market ?? '') ? S.Platform.Session.market : 'US';
  const product = S.Platform.initialProductState?.product === 'free' ? 'free' : 'premium';
  const resolver = new (components.Resolver ?? Resolver)({ request, store, scope: `${market}:${product}`, isStrict: () => settings.strict, log });
  cleanups.push(() => resolver.clear());
  const transformer = (components.createTransformer ?? createTransformer)({ resolver, store, isStrict: () => settings.strict, combineTitles: () => settings.combineTitles, log });
  const hooks = (components.installHooks ?? installHooks)({ Spicetify: S, transformer, isStrict: () => settings.strict, log });
  cleanups.push(() => hooks.dispose());
  const management = (components.installManagement ?? installManagement)({ Spicetify: S, store, resolver, hooks, settings, log, diagnostics, buildID: BUILD, version: VERSION, channel: CHANNEL });
  cleanups.push(() => management.dispose());
  api = host.JPOriginalTitle = {
    name: NAME, buildID: BUILD, version: VERSION, channel: CHANNEL,
    status: () => ({ name: NAME, buildID: BUILD, version: VERSION, channel: CHANNEL, disposed, hooks: hooks.status(), lookup: resolver.stats(), storage: store.stats(), settings: settings.snapshot() }),
    showSettings: management.show, resolver, transformer, store, hooks, settings,
    dispose: lifecycle.dispose,
  };
  await hooks.refresh?.();
  if (disposed) return null;
  if (!settings.installChoice) {
    const timer = schedule(() => {
      if (disposed) return;
      try { management.offerSetup(); } catch (error) { log('setup-prompt-failure', error); }
    }, 1200);
    cleanups.push(() => cancelSchedule(timer));
  }
  host.console?.info?.(`[${NAME}] ${VERSION ? `v${VERSION}` : 'Local development build'} ${BUILD} loaded.`);
  return api;
  } catch (error) {
    const superseded = disposed || host[STARTUP] !== lifecycle;
    lifecycle.dispose();
    if (host.JPOriginalTitle === api) delete host.JPOriginalTitle;
    if (superseded) return null;
    throw error;
  }
}
if (typeof document !== 'undefined') start().catch(error => {
  const message = String(error.message).replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]');
  console.error(`[${NAME}] ${message}`);
  globalThis.JPOriginalTitle = { name: NAME, buildID: BUILD, error: message, status: () => ({ error: message }) };
});
