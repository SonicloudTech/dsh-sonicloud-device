import test from 'node:test';
import assert from 'node:assert/strict';
import { createTokenProvider, createTokenRequest } from '../src/asr/auth.mjs';
import { until } from './helpers.mjs';

const success = (token = 'token', expiry = Math.floor(Date.now() / 1000) + 7200) => ({ ok: true, json: async () => ({ code: 0, data: { token, expire_time: expiry } }) });
const config = { sn: 'FF14A6252500008B' };

test('SN-only POST, concurrent cache sharing, invalidation and per-device isolation', async () => {
  assert.deepEqual(createTokenRequest({ ...config, ignored: 'unused' }), config);
  for (const sn of ['', 'usb-temp', '__proto__', undefined]) assert.throws(() => createTokenRequest({ sn }), /身份/);
  let calls = 0;
  const fetchImpl = async (url, options) => {
    calls++; assert.equal(url, 'https://dsh_device.sonicrhino.cc/api/open.sign/generate');
    assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
    assert.deepEqual(JSON.parse(options.body), config);
    return success(`token-${calls}`);
  };
  const get = createTokenProvider(config, fetchImpl);
  assert.deepEqual(await Promise.all([get(), get(), get()]), ['token-1', 'token-1', 'token-1']);
  get.invalidate('unrelated'); assert.equal(await get(), 'token-1');
  get.invalidate('token-1'); assert.equal(await get(), 'token-2');
  get.invalidate('token-1'); assert.equal(await get(), 'token-2');
  assert.equal(calls, 2);
  const second = createTokenProvider({ sn: 'F114A6252500008B' }, async (_, options) => {
    assert.equal(JSON.parse(options.body).sn, 'F114A6252500008B'); return success('other-device');
  });
  assert.equal(await second(), 'other-device'); assert.equal(await get(), 'token-2');
});

test('expiry uses server seconds and failures are never cached', async () => {
  const now = Date.now; let time = now(), calls = 0;
  Date.now = () => time;
  try {
    const get = createTokenProvider(config, async () => { calls++; return success(`t${calls}`, Math.floor(time / 1000) + 1); });
    assert.equal(await get(), 't1'); time += 2000; assert.equal(await get(), 't2');
  } finally { Date.now = now; }
  for (const data of [undefined, {}, { token: '' }, { token: 'x' }, { token: 'x', expire_time: '9999999999' }, { token: 'x', expire_time: 0 }]) {
    let count = 0;
    const get = createTokenProvider(config, async () => { count++; return { ok: true, json: async () => ({ code: 0, data }) }; });
    await assert.rejects(get(), /无效|过期/); await assert.rejects(get()); assert.equal(count, 2);
  }
  for (const [code, ok] of [[4001, false], [1001, true], [1002, true], [1008, true]]) {
    const get = createTokenProvider(config, async () => ({ ok, json: async () => ({ code }) }));
    await assert.rejects(get(), /身份|参数|鉴权|License/);
  }
});

test('cancel one waiter preserves others; cancel last aborts fetch and discards late responses', async () => {
  const requests = [];
  const get = createTokenProvider(config, (url, options) => new Promise(resolve => requests.push({ options, resolve })));
  const a = new AbortController(), b = new AbortController();
  const first = get(a.signal), second = get(b.signal);
  a.abort(); await assert.rejects(first, { name: 'AbortError' });
  assert.equal(requests[0].options.signal.aborted, false);
  requests[0].resolve(success('shared')); assert.equal(await second, 'shared');
  get.invalidate();
  const c = new AbortController(); const third = get(c.signal);
  c.abort(); await assert.rejects(third, { name: 'AbortError' });
  assert.equal(requests[1].options.signal.aborted, true);
  const fourth = get(); requests[2].resolve(success('fresh')); assert.equal(await fourth, 'fresh');
  requests[1].resolve(success('late')); await new Promise(resolve => setImmediate(resolve));
  assert.equal(await get(), 'fresh');
});

test('invalidation and plugin shutdown cancel pending refresh and prevent cache repopulation', async () => {
  const life = new AbortController(); let finish, requestSignal;
  const get = createTokenProvider(config, (_, options) => { requestSignal = options.signal; return new Promise(resolve => { finish = resolve; }); }, life.signal);
  const pending = get(); get.invalidate(); await assert.rejects(pending);
  assert.equal(requestSignal.aborted, true); finish(success('stale'));
  const next = get(); await until(() => !requestSignal.aborted);
  life.abort(); await assert.rejects(next); finish(success('after-shutdown'));
  await assert.rejects(get(), { name: 'AbortError' });
});
