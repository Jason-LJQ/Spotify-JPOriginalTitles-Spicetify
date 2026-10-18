import { NATIVE_WIRE_SCHEMAS, overlayKnownWire } from './wire-overlay.mjs';

const OWN_REQUEST = Symbol.for('JPOriginalTitles.ownRequest');

function abortError() {
  return new DOMException('The enhancement was cancelled.', 'AbortError');
}

function classifyURL(value) {
  try {
    const url = new URL(typeof value === 'string' ? value : value?.url, 'https://xpui.app.spotify.com');
    if (!/(^|\.)spotify\.com$/.test(url.hostname)) return null;
    if (/\/extended-metadata\/v0\/extended-metadata\/?$/.test(url.pathname)) return { type: 'metadata', url };
    if ((url.hostname === 'api-partner.spotify.com' && /^\/pathfinder\/v[12]\/query\/?$/.test(url.pathname)) ||
        /\/metadata\/4\/(track|album|artist)\//.test(url.pathname) ||
        (url.hostname === 'api.spotify.com' && /^\/v1\/(tracks|albums|artists)(\/|$)/.test(url.pathname))) {
      let variables;
      try { variables = JSON.parse(url.searchParams.get('variables') ?? '{}'); } catch { /* The response remains authoritative. */ }
      return { type: 'json', url, uri: variables?.trackUri ?? variables?.uri };
    }
  } catch { /* Non-HTTP transports are handled separately. */ }
  return null;
}

function requestURI(target, args) {
  let uri = classifyURL(args[0]);
  if (!uri && target) {
    const path = target.url ?? `${target.host ?? ''}${target.path ?? ''}`;
    uri = classifyURL(path);
  }
  if (uri && !uri.uri) {
    const body = args[1]?.payload ?? args[1]?.body ?? target?.postData;
    try {
      const parsed = typeof body === 'string' ? JSON.parse(body) : body;
      const variables = parsed?.variables;
      uri.uri = variables?.trackUri ?? variables?.uri;
    } catch { /* A non-JSON request body has no GraphQL variables. */ }
  }
  return uri;
}

function bytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

export function installHooks({ Spicetify, transformer, log = () => {}, isStrict = () => false }) {
  const restores = [];
  const installed = new WeakMap();
  const controllers = new Set();
  const streamCancellations = new Set();
  const streamDetachments = new Set();
  const activeFacades = new Set();
  const codecServices = new Map();
  const inFlight = new WeakMap();
  const enhanced = new WeakSet();
  const counts = { http: 0, native: 0, player: 0, failures: 0 };
  const layers = new Set();
  let disposed = false;
  let facadeScope = null;

  function patch(object, name, make, label) {
    if (!object || typeof object[name] !== 'function') return false;
    let names = installed.get(object);
    if (names?.has(name)) return true;
    const descriptor = Object.getOwnPropertyDescriptor(object, name);
    const original = object[name];
    const wrapper = make(original);
    try { Object.defineProperty(object, name, { configurable: true, writable: true, value: wrapper }); }
    catch { return false; }
    if (!names) installed.set(object, names = new Set());
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
    if (signal?.aborted) throw abortError();
    if (value && typeof value === 'object' && enhanced.has(value)) return value;
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal.reason);
    signal?.addEventListener?.('abort', onAbort, { once: true });
    controllers.add(controller);
    try {
      const result = await transformer[method](value, { ...options, signal: controller.signal });
      if (signal?.aborted) throw abortError();
      if (disposed) return value;
      if (result !== value && result && typeof result === 'object') enhanced.add(result);
      return result;
    } catch (error) {
      if (signal?.aborted) throw abortError();
      if (disposed) return value;
      counts.failures++;
      log('rewrite-failure', { method, code: error?.code ?? 'JPT_REWRITE_FAILED' });
      if (error?.fatal || error?.strict || error?.storageFailure ||
          ['JPT_STORAGE_FAILED', 'JPT_STORAGE'].includes(error?.code) || isStrict()) throw error;
      return value;
    } finally {
      controllers.delete(controller);
      signal?.removeEventListener?.('abort', onAbort);
    }
  }

  async function rewriteHTTP(response, target, args) {
    const info = requestURI(target, args);
    if (!info || args[1]?.[OWN_REQUEST] || target?.[OWN_REQUEST] || !response) return response;
    const signal = args[1]?.signal ?? target?._abortSignal;
    const status = response.status ?? response.statusCode ?? 200;
    if (status < 200 || status >= 300) return response;
    if (typeof response === 'object' && inFlight.has(response)) return inFlight.get(response);
    const operation = (async () => {
      const hasBody = typeof response === 'object' && Object.hasOwn(response, 'body');
      const body = hasBody ? response.body : response;
      const raw = bytes(body);
      const method = info.type === 'metadata' ? 'rewriteMetadata' : 'rewriteJSON';
      if (info.type === 'metadata' && !raw) return response;
      const output = await rewrite(raw ?? body, method, signal, { uri: info.uri, trackURI: info.uri, priority: 1 });
      if (output === (raw ?? body)) return response;
      counts.http++;
      if (!hasBody) return output;
      const result = Object.assign(Object.create(Object.getPrototypeOf(response)), response, { body: output });
      enhanced.add(result);
      return result;
    })();
    if (typeof response === 'object') inFlight.set(response, operation);
    try { return await operation; }
    finally { if (typeof response === 'object') inFlight.delete(response); }
  }

  function methodCodec(request) {
    const record = codecServices.get(request?.service);
    if (!record) return null;
    const method = Object.entries(record.methods).find(([key, value]) =>
      key.toLowerCase() === String(request.method).toLowerCase() ||
      value.name === request.method || value.method === request.method)?.[1];
    if (!method?.responseType?.decode || !method.responseType.encode) return null;
    const name = String(request.method).toLowerCase();
    if (record.kind === 'metadata' && !['observe', 'fetch'].includes(name)) return null;
    if (record.kind === 'player' && !['getstate', 'getqueue', 'getplayhistory'].includes(name)) return null;
    if (record.kind === 'list' && !['get', 'subscribe'].includes(name)) return null;
    return { codec: method.responseType, requestCodec: method.requestType, kind: record.kind,
      wireSchema: NATIVE_WIRE_SCHEMAS[record.kind]?.[name] ?? {} };
  }

  async function rewriteWire(payload, record, signal) {
    if (disposed) return payload;
    const raw = bytes(payload);
    if (!raw) return payload;
    let decoded, canonicalBefore;
    try {
      decoded = record.codec.decode(raw);
      canonicalBefore = record.codec.encode(decoded).finish();
    }
    catch (cause) {
      const error = new Error('A Spotify bridge response could not be decoded.');
      error.code = 'JPT_PARSE_FAILED';
      if (isStrict()) throw error;
      counts.failures++;
      log('bridge-decode-failure', { kind: record.kind });
      return payload;
    }
    const method = record.kind === 'player' ? 'rewritePlayer' : 'rewriteNative';
    let prepared, preparedFor;
    const prepare = candidate => {
      try {
        return overlayKnownWire(raw, canonicalBefore, record.codec.encode(candidate).finish(), record.wireSchema);
      } catch (cause) {
        throw Object.assign(new Error('A Spotify bridge response could not be encoded losslessly.'), { code: 'JPT_PARSE_FAILED' });
      }
    };
    const result = await rewrite(decoded, method, signal, { priority: 3, validate(candidate) {
      prepared = prepare(candidate);
      preparedFor = candidate;
    } });
    if (result === decoded) return payload;
    try {
      const encoded = preparedFor === result ? prepared : prepare(result);
      if (encoded === raw) return payload;
      counts[record.kind === 'player' ? 'player' : 'native']++;
      return encoded;
    } catch {
      const error = new Error('A Spotify bridge response could not be encoded.');
      error.code = 'JPT_PARSE_FAILED';
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
        if (cancelled || (disposed && dropOnDispose)) return;
        const receiver = this;
        const sequence = ++latestSequence;
        chain = chain.then(async () => {
          if (cancelled || (disposed && dropOnDispose)) return;
          if (latestOnly && sequence !== latestSequence) return;
          let value = args[0];
          try { if (!disposed) value = await transform(args[0], controller.signal); }
          catch (error) {
            if (cancelled || (disposed && dropOnDispose)) return;
            if (!disposed) {
              log('stream-stopped', { code: error?.code ?? 'JPT_DELIVERY_FAILED' });
              onError?.(error);
              cancel();
              return;
            }
          }
          if (!cancelled && !(disposed && dropOnDispose)) Reflect.apply(callback, receiver, [value, ...args.slice(1)]);
        }).catch(error => {
          if (cancelled || disposed) return;
          log('stream-stopped', { code: error?.code ?? 'JPT_DELIVERY_FAILED' });
          onError?.(error);
          cancel();
        });
      },
      cancel,
      setCancel(fn) { originalCancel = fn; if (cancelled) originalCancel?.(); },
    };
  }

  function installNative(client, kind) {
    if (!client) return false;
    const service = client.constructor?.SERVICE_ID;
    const methods = client.constructor?.METHODS;
    if (!service || !methods) return false;
    codecServices.set(service, { methods, kind });
    const transport = client.transport;
    patch(transport, 'callSingle', original => function(request, options) {
      const record = methodCodec(request);
      const result = Reflect.apply(original, this, arguments);
      return !record || request?.[OWN_REQUEST] ? result : Promise.resolve(result).then(value => rewriteWire(value, record, options?.signal));
    }, 'native-single');
    patch(transport, 'callStream', original => function(request, callback) {
      const record = methodCodec(request);
      if (!record || request?.[OWN_REQUEST] || typeof callback !== 'function') return Reflect.apply(original, this, arguments);
      const scope = facadeScope;
      const requestURIs = new Set();
      try {
        collectURIs(record.requestCodec?.decode?.(request.payload), requestURIs);
      } catch { /* Some client builds expose only the response codec. */ }
      const delivery = serialCallback(callback, (value, signal) => rewriteWire(value, record, signal), undefined,
        error => {
          scope?.reject(error);
          for (const pending of activeFacades) {
            if ([...requestURIs].some(uri => pending.uris.has(uri))) pending.reject(error);
          }
        });
      let subscription;
      try { subscription = Reflect.apply(original, this, [request, delivery.callback]); }
      catch (error) { delivery.cancel(); throw error; }
      delivery.setCancel(() => subscription?.cancel?.());
      return { ...subscription, cancel: delivery.cancel };
    }, 'native-stream');
    return true;
  }

  function installMetadataFacade(metadata) {
    if (!metadata) return;
    const native = installNative(metadata._metadataServiceClient, 'metadata');
    for (const name of ['fetch', 'fetchBatched']) {
      patch(metadata, name, original => function(...args) {
        if (!native) return Promise.resolve(Reflect.apply(original, this, args)).then(value => rewrite(value, 'rewriteNative'));
        let reject;
        const failed = new Promise((_, fail) => { reject = fail; });
        const pending = { reject, uris: new Set() };
        collectURIs(args, pending.uris);
        activeFacades.add(pending);
        const prior = facadeScope;
        facadeScope = pending;
        let output;
        try { output = Reflect.apply(original, this, args); }
        catch (error) { activeFacades.delete(pending); throw error; }
        finally { facadeScope = prior; }
        return Promise.race([output, failed]).finally(() => activeFacades.delete(pending));
      }, `metadata-${name}`);
    }
    if (native) return;
    patch(metadata, 'subscribe', original => function(callback, ...args) {
      if (typeof callback !== 'function') return Reflect.apply(original, this, arguments);
      const delivery = serialCallback(callback, (value, signal) => rewrite(value, 'rewriteNative', signal));
      const subscription = Reflect.apply(original, this, [delivery.callback, ...args]);
      delivery.setCancel(() => subscription?.cancel?.());
      return { ...subscription, cancel: delivery.cancel };
    }, 'metadata-subscribe');
  }

  function refresh() {
    if (disposed) return;
    const platform = Spicetify?.Platform;
    if (!platform) return;
    const transport = platform.Transport ?? platform.RequestBuilder?.transport ?? platform.RequestBuilder?._transport;
    const hasTransport = patch(transport, 'request', original => function(...args) {
      const output = Reflect.apply(original, this, args);
      return classifyURL(args[0]) ? Promise.resolve(output).then(value => rewriteHTTP(value, null, args)) : output;
    }, 'http-transport');
    if (!hasTransport) {
      const implementation = platform.RequestBuilder?._RequestImplementation?.prototype;
      const hasImplementation = patch(implementation, 'send', original => function(...args) {
        return Promise.resolve(Reflect.apply(original, this, args)).then(value => rewriteHTTP(value, this, args));
      }, 'http-request-implementation');
      if (!hasImplementation) patch(platform.RequestBuilder, 'build', original => function(...args) {
        const request = Reflect.apply(original, this, args);
        patch(request, 'send', send => function(...sendArgs) {
          return Promise.resolve(Reflect.apply(send, this, sendArgs)).then(value => rewriteHTTP(value, this, sendArgs));
        }, 'http-request-builder');
        return request;
      }, 'http-request-builder-factory');
    }
    installMetadataFacade(platform.PlaylistAPI?._metadataExtensionsAPI);
    installMetadataFacade(platform.LibraryAPI?._metadataExtensionsAPI);
    installNative(platform.PlayerAPI?._contextPlayer, 'player');
    installNative(platform.PlaylistAPI?._playlistDataClient, 'list');
    installNative(platform.ListPlatformAPI?._playlistDataClient, 'list');
    const events = platform.PlayerAPI?._events;
    const eventMethod = typeof events?.emit === 'function' ? 'emit' : 'emitSync';
    patch(events, eventMethod, original => {
      const delivery = serialCallback(function(args) { return Reflect.apply(original, events, args); }, async (args, signal) => {
        const event = args[1];
        const wrapped = event && Object.hasOwn(event, 'data');
        const data = wrapped ? event.data : event;
        if (!data || typeof data !== 'object') return args;
        const result = await rewrite(data, 'rewritePlayer', signal, { priority: 3 });
        if (result !== data) counts.player++;
        return result === data ? args : [args[0], wrapped ? { ...event, data: result } : result, ...args.slice(2)];
      }, undefined, undefined, true, true);
      return function(...args) {
        if (args[0] !== 'update' || !args[1] || typeof args[1] !== 'object') return Reflect.apply(original, this, args);
        delivery.callback(args);
      };
    }, `player-events-${eventMethod}`);
    const currentState = platform.PlayerAPI?.getState?.() ?? platform.PlayerAPI?._state;
    if (currentState && typeof events?.[eventMethod] === 'function') events[eventMethod]('update', currentState);
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
    for (const pending of activeFacades) pending.reject(abortError());
    for (const restore of restores.reverse()) {
      try { restore(); } catch { log('hook-restore-failure', { code: 'JPT_RESTORE_FAILED' }); }
    }
    restores.length = 0;
  }

  try { refresh(); }
  catch (error) { dispose(); throw error; }
  return { dispose, status, refresh };
}

function collectURIs(value, output, depth = 0, seen = new Set()) {
  if (typeof value === 'string') {
    if (/^spotify:(track|album|artist):[A-Za-z0-9]+$/.test(value)) output.add(value);
    return;
  }
  if (!value || typeof value !== 'object' || depth > 8 || seen.has(value) || ArrayBuffer.isView(value)) return;
  seen.add(value);
  for (const item of Object.values(value)) collectURIs(item, output, depth + 1, seen);
}
