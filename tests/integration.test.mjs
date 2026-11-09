import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once, EventEmitter } from 'node:events';
import { WebSocketServer } from 'ws';
import { Context } from '@deepseek-ai/cordis';
import TypertRegistry from '@deepseek-ai/dsh-typert-registry';
import Gateway from '@deepseek-ai/dsh-api-gateway';
import * as plugin from '../src/host/index.mjs';
import { defaultPreferences } from '../src/shared/devices.mjs';
import { REMOTE, TYPERT } from '../src/shared/remote.mjs';
import { MemoryCredentials, until } from './helpers.mjs';

for (const protocol of ['legacy', 'live', 'retry', 'translate']) test(`real Gateway → Token HTTP → WebSocket preserves ${protocol} final sentence and cancellation`, async () => {
  let tokenCalls = 0, audioBytes = 0, translationCalls = 0;
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    if (request.url === '/translate') {
      translationCalls++;
      assert.deepEqual(body, { text: '最后一句。', from: 'zh', to: 'en' });
      assert.equal(request.headers['x-sc-authorization'], `fixture-token-${tokenCalls}`);
      assert.ok(request.headers['x-sc-user-id']);
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify(translationCalls === 1 ? { code: 1004 } : { code: 0, data: { resultText: 'Last sentence.' } }));
      return;
    }
    assert.equal(request.url, '/token'); assert.deepEqual(body, { sn: '0001' });
    tokenCalls++;
    response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ code: 0, data: { token: `fixture-token-${tokenCalls}`, expire_time: Math.floor(Date.now() / 1000) + 7200 } }));
  });
  const sockets = new WebSocketServer({ server });
  sockets.on('connection', (socket, request) => {
    assert.equal(request.headers['x-sc-authorization'], `fixture-token-${tokenCalls}`);
    assert.ok(request.headers['x-sc-user-id']); assert.equal(request.url.includes('fixture-token'), false);
    if (protocol === 'retry' && tokenCalls === 1) { socket.send(JSON.stringify({ errCode: '4010' })); socket.close(); return; }
    socket.send(JSON.stringify({ errCode: '1000' }));
    socket.on('message', (bytes, binary) => {
      if (binary) {
        audioBytes += bytes.length;
        socket.send(JSON.stringify({ errCode: protocol === 'live' ? '3' : '0', result: '实时', Begin: 0, End: protocol === 'live' ? 100 : 0 }));
      }
      else {
        assert.equal(bytes.toString(), 'end');
        if (protocol === 'live') {
          socket.send(JSON.stringify({ errCode: '10', result: '最后一句。', Begin: '0', End: '100' }));
          // The live server leaves the connection open after the final payload.
        } else {
          socket.send(JSON.stringify({ errCode: '0', result: '最后一句。', Begin: 0, End: 100 }));
          socket.send(JSON.stringify({ errCode: '10' })); socket.close();
        }
      }
    });
  });
  const sdk = new EventEmitter(); sdk.start = async () => 'test'; sdk.source = async () => 1; sdk.close = async () => {};
  let controller;
  const installed = { inject: plugin.inject, apply(ctx) { ctx.effect(() => ctx.typert.register(TYPERT)); controller = new plugin.MouseController(ctx, { tailMs: 0 }, { sdk, endpoints: { streamUrl: `ws://127.0.0.1:${server.address().port}/asr`, tokenUrl: `http://127.0.0.1:${server.address().port}/token`, translateUrl: `http://127.0.0.1:${server.address().port}/translate` } }); } };
  const ctx = new Context(); const peer = { id: 'test-owner', ctx, principal: { kind: 'owner' }, signal: new AbortController().signal };
  ctx.provide('credentials', new MemoryCredentials()); ctx.provide('remoteAccess', { decide: () => ({ kind: 'deny' }) });
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    await ctx.plugin(TypertRegistry); await ctx.plugin(Gateway, {}); await ctx.plugin(installed);
    const call = (method, args = {}) => ctx.typertGateway.invoke({ namespace: 'asr', method, args, peer });
    const catalog = await call('catalog');
    REMOTE.descriptors.find(item => item.method === 'catalog').result.create().parse(catalog);
    const life = new AbortController();
    const events = []; let booted = false, audioSent = false;
    const watch = await ctx.typertGateway.stream({ namespace: 'asr', method: 'watch', args: { clientId: 'integration' }, peer, signal: life.signal });
    for await (const event of watch) {
      events.push(event);
      if (event.type === 'devices' && !booted) {
        booted = true;
        sdk.emit('event', { type: 'connected', id: '0001', mode: 0 }); await controller.manager.pending;
        if (protocol === 'translate') await call('saveDevice', { sn: '0001', revision: 0, preferences: { ...defaultPreferences(), speechAction: 'translate' } });
        sdk.emit('event', { type: 'message', id: '0001', message: { type: 'keyEvent', key: 'speech', action: 'down' } });
      }
      if (event.type === 'request' && !audioSent) {
        // A real mouse does not wait for ASR's ready phase before producing PCM.
        audioSent = true;
        sdk.emit('event', { type: 'audio', id: '0001', data: Buffer.alloc(3200).toString('base64') });
        await call('accept', { clientId: 'integration', sessionId: event.sessionId });
        sdk.emit('event', { type: 'message', id: '0001', message: { type: 'keyEvent', key: 'speech', action: 'up' } });
      }
      if (event.type === 'failed') assert.fail(event.message);
      if (event.type === 'result') break;
    }
    assert.equal(events.at(-1).type, 'result'); assert.equal(events.at(-1).text, protocol === 'translate' ? 'Last sentence.' : '最后一句。');
    assert.equal(translationCalls, protocol === 'translate' ? 2 : 0);
    assert.ok(events.some(item => item.type === 'preview' && item.text === '实时'));
    assert.equal(audioBytes, 3200); assert.equal(tokenCalls, ['retry', 'translate'].includes(protocol) ? 2 : 1);
    life.abort(); await until(() => !controller.manager.run);
    const cancel = new AbortController();
    const second = await ctx.typertGateway.stream({ namespace: 'asr', method: 'watch', args: { clientId: 'second' }, peer, signal: cancel.signal });
    let requested = false, cancelled = false;
    try {
      for await (const event of second) {
        if (event.type === 'devices' && !requested) {
          requested = true;
          sdk.emit('event', { type: 'message', id: '0001', message: { type: 'keyEvent', key: 'speech', action: 'down' } });
        }
        if (event.type === 'request') await call('accept', { clientId: 'second', sessionId: event.sessionId });
        if (event.type === 'phase' && event.phase === 'recording') { cancelled = true; cancel.abort(); }
      }
    } catch (error) { assert.match(error.code ?? '', /cancelled/); }
    assert.equal(cancelled, true); assert.equal(tokenCalls, ['retry', 'translate'].includes(protocol) ? 2 : 1);

  } finally {
    await ctx.fiber.dispose(); for (const socket of sockets.clients) socket.terminate();
    await new Promise(resolve => sockets.close(resolve)); await new Promise(resolve => server.close(resolve));
  }
});
