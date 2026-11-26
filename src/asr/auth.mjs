import { message as msg } from '../shared/i18n.mjs';
import { BUILTIN_ASR } from './config.mjs';
import { isStableSn } from '../shared/devices.mjs';

export function createTokenRequest({ sn }) {
  if (!isStableSn(sn)) throw new Error(msg('error.device'));
  return { sn };
}

// 每个设备独立缓存；最后一个等待者取消时中止请求，迟到响应不能写回缓存。
export function createTokenProvider(config, fetchImpl = globalThis.fetch, lifetime) {
  const service = { ...BUILTIN_ASR, ...config };
  let cachedToken, expiresAt = 0, pending, generation = 0;
  const invalidate = expected => {
    if (expected !== undefined && cachedToken !== expected) return;
    generation++; cachedToken = undefined; expiresAt = 0;
    pending?.abort.abort(); pending = undefined;
  };
  async function requestToken(entry) {
    const signal = AbortSignal.any([entry.abort.signal, AbortSignal.timeout(10_000), ...(lifetime ? [lifetime] : [])]);
    signal.throwIfAborted();
    let response, payload;
    try {
      response = await fetchImpl(service.tokenUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(createTokenRequest(service)), signal, redirect: 'error',
      });
      payload = await response.json();
    } catch (error) {
      if (signal.aborted && !entry.abort.signal.aborted && !lifetime?.aborted) throw new Error(msg('error.timeout'));
      signal.throwIfAborted();
      if (!isStableSn(service.sn)) throw error;
      throw new Error(msg('error.auth'));
    }
    signal.throwIfAborted();
    if (!response.ok || payload?.code !== 0) {
      const messages = {
        4001: msg('error.device'), 1001: msg('error.auth'),
        1002: msg('error.auth'), 1008: msg('error.deviceLimit'),
      };
      throw new Error(messages[payload?.code] ?? msg('error.auth'));
    }
    const { token, expire_time: expiry } = payload.data ?? {};
    if (typeof token !== 'string' || !token.trim() || !Number.isSafeInteger(expiry) || expiry <= Date.now() / 1000) {
      throw new Error(msg('error.auth'));
    }
    if (entry.generation !== generation) throw new Error(msg('error.auth'));
    cachedToken = token; expiresAt = expiry * 1000;
    return token;
  }
  const getToken = async (signal) => {
    lifetime?.throwIfAborted(); signal?.throwIfAborted();
    createTokenRequest(service);
    if (cachedToken && Date.now() < expiresAt) return cachedToken;
    if (!pending) {
      const entry = { abort: new AbortController(), generation, users: 0 };
      pending = entry;
      entry.promise = requestToken(entry).finally(() => { if (pending === entry) pending = undefined; });
    }
    const entry = pending;
    entry.users++;
    return new Promise((resolve, reject) => {
      const combined = AbortSignal.any([entry.abort.signal, ...(signal ? [signal] : []), ...(lifetime ? [lifetime] : [])]);
      let settled = false;
      const finish = (handler, value) => {
        if (settled) return;
        settled = true; combined.removeEventListener('abort', abort);
        entry.users--;
        if (!entry.users && pending === entry) { pending = undefined; generation++; entry.abort.abort(); }
        handler(value);
      };
      const abort = () => finish(reject, combined.reason);
      combined.addEventListener('abort', abort, { once: true });
      entry.promise.then(value => finish(resolve, value), error => finish(reject, error));
      if (combined.aborted) abort();
    });
  };
  getToken.invalidate = invalidate;
  lifetime?.addEventListener('abort', () => invalidate(), { once: true });
  return getToken;
}
