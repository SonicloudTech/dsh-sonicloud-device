import test from 'node:test';
import assert from 'node:assert/strict';
import { translateText, TRANSLATE_URL } from '../src/devices/translate.mjs';

function fixture() {
  let calls = 0, invalidations = [];
  const getToken = async signal => { signal.throwIfAborted(); calls++; return `t${invalidations.length}`; };
  getToken.invalidate = token => invalidations.push(token);
  return { input: { text: '你好', from: 'cn', to: 'en', userId: 'user', signal: new AbortController().signal, getToken },
    calls: () => calls, invalidations };
}
const response = (code = 0, resultText = 'Hello', ok = true) => ({ ok, json: async () => ({ code, data: { resultText } }) });

test('official translation sends JSON, maps languages and reads only resultText', async () => {
  const { input } = fixture();
  assert.equal(await translateText({ ...input, fetchImpl: async (url, options) => {
    assert.equal(url, TRANSLATE_URL); assert.equal(url, 'https://openapi.sinicloud.com/v1/translate/text');
    assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
    assert.deepEqual(options.headers, { 'Content-Type': 'application/json; charset=utf-8', 'X-SC-Authorization': 't0', 'X-SC-User-Id': 'user' });
    assert.deepEqual(JSON.parse(options.body), { text: '你好', from: 'zh', to: 'en' });
    return response();
  } }), 'Hello');
});

test('auth failure refreshes once and repeats exactly the same body; second error stops', async () => {
  for (const secondCode of [0, 1004, 1003]) {
    const f = fixture(), requests = [];
    const task = translateText({ ...f.input, fetchImpl: async (_, options) => {
      requests.push(options); return response(requests.length === 1 ? '1004' : secondCode);
    } });
    if (secondCode === 0) assert.equal(await task, 'Hello'); else await assert.rejects(task);
    assert.equal(requests.length, 2); assert.equal(requests[0].body, requests[1].body);
    assert.equal(requests[1].headers['X-SC-Authorization'], 't1');
    assert.deepEqual(f.invalidations, secondCode === 1004 ? ['t0', 't1'] : ['t0']);
  }
});

test('non-auth errors and invalid responses never refresh; invalid inputs send nothing', async () => {
  for (const value of [response(1001), response(1003), response(1005), response(3005), response(0, ''), response(0, 'Hello', false), { ok: true, json: async () => { throw new Error('bad JSON'); } }]) {
    const f = fixture(); let calls = 0;
    await assert.rejects(translateText({ ...f.input, fetchImpl: async () => { calls++; return value; } }));
    assert.equal(calls, 1); assert.deepEqual(f.invalidations, []);
  }
  for (const override of [{ text: '' }, { text: '字'.repeat(5001) }, { from: 'en', to: 'en' }, { from: 'unknown' }]) {
    const f = fixture();
    await assert.rejects(translateText({ ...f.input, ...override, fetchImpl: () => assert.fail('must not send') }));
    assert.equal(f.calls(), 0);
  }
});

test('refresh failure stops and cancellation discards late translations', async () => {
  const f = fixture(); let sent = 0;
  f.input.getToken = Object.assign(async () => { if (sent) throw new Error('Token 获取失败'); return 'old'; }, { invalidate() {} });
  await assert.rejects(translateText({ ...f.input, fetchImpl: async () => { sent++; return response(1004); } }), /Token/);
  assert.equal(sent, 1);
  const abort = new AbortController();
  await assert.rejects(translateText({ ...fixture().input, signal: abort.signal, fetchImpl: async () => { abort.abort(); return response(); } }), { name: 'AbortError' });
});
