import { BUILTIN_ASR } from './config.mjs';
import { isStableSn } from '../shared/devices.mjs';

export function createTokenRequest({ sn }) {
  if (!isStableSn(sn)) throw new Error('设备身份未确认，请重新连接鼠标');
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
      if (signal.aborted && !entry.abort.signal.aborted && !lifetime?.aborted) throw new Error('Token 获取超时，请稍后重试');
      signal.throwIfAborted();
      if (!isStableSn(service.sn)) throw error;
      throw new Error('Token 获取失败，请检查网络后重试');
    }
    signal.throwIfAborted();
    if (!response.ok || payload?.code !== 0) {
      const messages = {
        4001: '设备身份无效，请重新连接鼠标', 1001: '设备鉴权参数错误，请联系服务方',
        1002: '设备鉴权失败，请联系服务方', 1008: 'License 设备数量已达上限',
      };
      throw new Error(messages[payload?.code] ?? 'Token 获取失败，请稍后重试');
    }
    const { token, expire_time: expiry } = payload.data ?? {};
    if (typeof token !== 'string' || !token.trim() || !Number.isSafeInteger(expiry) || expiry <= Date.now() / 1000) {
      throw new Error('Token 响应无效或已过期，请稍后重试');
    }
    if (entry.generation !== generation) throw new Error('Token 请求已失效');
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
