import { concat, encodeRequest, ld } from './wire.mjs';

export const METADATA_ENDPOINT = 'https://spclient.wg.spotify.com/extended-metadata/v0/extended-metadata';

function aborted(signal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new DOMException('The request was aborted.', 'AbortError');
}

async function accessToken(platform) {
  const authorization = platform?.AuthorizationAPI;
  const provider = authorization?._tokenProvider;
  let result;
  if (typeof provider?.getToken === 'function') result = await provider.getToken();
  else if (typeof provider === 'function') result = await provider.call(authorization, { preferCached: true });
  else result = authorization?.getState?.()?.token;
  const token = typeof result === 'string' ? result : result?.accessToken;
  if (!token) {
    const error = new Error('Spotify authentication is unavailable.');
    error.status = error.statusCode = 401;
    throw error;
  }
  return token;
}

function waitFor(promise, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new DOMException('The request was aborted.', 'AbortError'));
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

export function createRequest({ Spicetify, fetch: originalFetch = globalThis.fetch, log = () => {}, timeoutMs = 20000 }) {
  if (typeof originalFetch !== 'function') throw new TypeError('A captured fetch implementation is required.');
  const send = originalFetch.bind(globalThis);
  const text = new TextEncoder();
  return async function request(entities, language = 'zh-Hans', signal) {
    aborted(signal);
    const platform = Spicetify?.Platform;
    const market = /^[A-Z]{2}$/.test(platform?.Session?.market ?? '') ? platform.Session.market : 'US';
    const product = platform?.initialProductState?.product === 'free' ? 'free' : 'premium';
    const header = concat(ld(1, text.encode(market)), ld(2, text.encode(product)));
    const body = encodeRequest(entities, { header });
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal.reason ?? new DOMException('The request was aborted.', 'AbortError'));
    signal?.addEventListener('abort', onAbort, { once: true });
    const timeout = Object.assign(new Error('Spotify metadata timed out.'), { name: 'TimeoutError', code: 'JPT_TIMEOUT', timeout: true });
    const timer = setTimeout(() => controller.abort(timeout), timeoutMs);
    try {
      const token = await waitFor(accessToken(platform), controller.signal);
      aborted(signal);
      const response = await waitFor(send(METADATA_ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/x-protobuf',
          Accept: 'application/x-protobuf',
          'Accept-Language': language,
        },
        body,
        signal: controller.signal,
      }), controller.signal);
      aborted(signal);
      if (!response.ok || response.status === 204) {
        const error = new Error(`Spotify metadata returned HTTP ${response.status}.`);
        error.status = error.statusCode = response.status;
        const retryAfter = response.headers?.get?.('retry-after');
        if (retryAfter !== null && retryAfter !== undefined) error.retryAfter = retryAfter;
        if (![204, 404, 410].includes(response.status)) log('lookup-http-error', { status: response.status });
        throw error;
      }
      const bytes = new Uint8Array(await waitFor(response.arrayBuffer(), controller.signal));
      aborted(signal);
      return bytes;
    } catch (cause) {
      if (controller.signal.reason === timeout) throw timeout;
      if (signal?.aborted || cause?.name === 'AbortError') throw cause;
      if (cause?.status) throw cause;
      const error = new Error('Spotify metadata could not be reached.');
      error.offline = globalThis.navigator?.onLine === false;
      error.cause = cause;
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  };
}
