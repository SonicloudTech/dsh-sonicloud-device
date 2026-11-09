import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Context } from '@deepseek-ai/cordis';
import TypertRegistry from '@deepseek-ai/dsh-typert-registry';
import { MouseController } from '../src/host/index.mjs';
import { MemoryCredentials, AsyncItems, until } from './helpers.mjs';

const tokenResponse = token => ({ ok: true, json: async () => ({ code: 0, data: { token, expire_time: Math.floor(Date.now() / 1000) + 7200 } }) });
async function setup(t, overrides = {}) {
  const ctx = new Context(), requests = [], sockets = [], uploads = [];
  ctx.provide('credentials', new MemoryCredentials());
  await ctx.plugin(TypertRegistry);
  const sdk = new EventEmitter(); sdk.close = async () => {};
  class Socket extends EventEmitter {
    bufferedAmount = 0;
    constructor(url, options) {
      super(); this.options = options; sockets.push(this);
      queueMicrotask(() => this.message({ errCode: sockets.length === 1 ? '4010' : '1000' }));
    }
    message(value) { this.emit('message', Buffer.from(JSON.stringify(value))); }
    send(value) {
      uploads.push(value);
      if (value === 'end') this.message({ errCode: '10', Begin: 0, End: 100, result: '最后一句。' });
    }
    terminate() { this.terminated = true; this.emit('close'); }
  }
  const controller = new MouseController(ctx, {}, { sdk, WebSocketImpl: Socket,
    fetchImpl: async (url, options) => { requests.push([url, options]); return tokenResponse(`token-${requests.length}`); }, ...overrides });
  t.after(() => ctx.fiber.dispose()); await controller.initialized;
  const uplink = new AsyncItems(); uplink.push(Buffer.alloc(3200, 7).toString('base64')); uplink.end();
  const events = [], abort = new AbortController();
  const recognize = async (sn = 'mouse-a') => {
    for await (const event of controller.recognize({ sn, query: { lanid: '4', lid: '0', role: '0' }, uplink, signal: abort.signal })) events.push(event);
  };
  return { ctx, controller, requests, sockets, uploads, events, abort, recognize, Socket };
}

test('ASR auth retry preserves buffered PCM and released key, with one successful output and shared translation token', async t => {
  const f = await setup(t);
  await f.recognize();
  assert.equal(f.requests.length, 2); assert.equal(f.sockets.length, 2);
  assert.deepEqual(f.events.map(e => e.type), ['ready', 'finishing', 'transcript', 'complete']);
  assert.deepEqual(f.uploads, [Buffer.alloc(3200, 7), 'end']);
  assert.ok(f.sockets[0].terminated);
  assert.deepEqual(f.requests.map(([, options]) => JSON.parse(options.body)), [{ sn: 'mouse-a' }, { sn: 'mouse-a' }]);
  assert.equal(f.sockets[1].options.headers['X-SC-Authorization'], 'token-2');
  let translations = 0;
  f.controller.dependencies.fetchImpl = async (url, options) => {
    translations++;
    assert.equal(options.headers['X-SC-Authorization'], 'token-2');
    assert.deepEqual(JSON.parse(options.body), { text: '最后一句。', from: 'zh', to: 'en' });
    return { ok: true, json: async () => ({ code: 0, data: { resultText: 'Last sentence.' } }) };
  };
  assert.equal(await f.controller.translate({ sn: 'mouse-a', text: '最后一句。', from: 'cn', to: 'en', signal: f.abort.signal }), 'Last sentence.');
  assert.equal(translations, 1); assert.equal(f.requests.length, 2);
  const a = f.controller.provider('mouse-a', await f.controller.service());
  const b = f.controller.provider('mouse-b', await f.controller.service());
  assert.notEqual(a, b);
});

test('ASR retries only once, invalidates the rejected replacement and leaves non-auth errors alone', async t => {
  for (const code of ['4010', '4011', '4013', '4015']) {
    const f = await setup(t);
    f.Socket.prototype.message = function(value) { this.emit('message', Buffer.from(JSON.stringify({ errCode: code }))); };
    await f.recognize();
    assert.equal(f.sockets.length, code === '4010' ? 2 : 1);
    assert.equal(f.requests.length, code === '4010' ? 2 : 1);
    assert.equal(f.events.length, 1); assert.equal(f.events[0].type, 'error');
    assert.equal(f.uploads.length, 0);
    if (code === '4010') {
      const get = f.controller.provider('mouse-a', await f.controller.service());
      assert.equal(await get(), 'token-3');
    }
  }
});

test('refresh failure, cancellation and shared connection deadline stop ASR without consuming audio', async t => {
  for (const mode of ['refresh-error', 'cancel', 'timeout']) {
    let count = 0, refreshSignal;
    const f = await setup(t, { connectTimeout: 50, fetchImpl: async (_, options) => {
      if (++count === 1) return tokenResponse('expired');
      refreshSignal = options.signal;
      if (mode === 'refresh-error') return { ok: true, json: async () => ({ code: 1008 }) };
      return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
    } });
    const task = f.recognize();
    if (mode === 'cancel') { await until(() => refreshSignal); f.abort.abort(); }
    await task;
    assert.equal(count, 2); assert.equal(f.sockets.length, 1); assert.equal(f.uploads.length, 0);
    if (mode === 'cancel') { assert.deepEqual(f.events, []); assert.ok(refreshSignal.aborted); }
    else { assert.equal(f.events.length, 1); assert.match(f.events[0].message, mode === 'timeout' ? /连接超时/ : /License/); }
  }
});

test('cancel before the first Token response aborts fetch and opens no socket', async t => {
  let requestSignal;
  const f = await setup(t, { fetchImpl: (_, options) => {
    requestSignal = options.signal;
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }));
  } });
  const task = f.recognize(); await until(() => requestSignal); f.abort.abort(); await task;
  assert.ok(requestSignal.aborted); assert.equal(f.sockets.length, 0); assert.deepEqual(f.events, []);
});
