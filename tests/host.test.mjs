import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import TypertRegistry from '@deepseek-ai/dsh-typert-registry';
import Gateway from '@deepseek-ai/dsh-api-gateway';
import * as plugin from '../src/host/index.mjs';
import { MemoryCredentials } from './helpers.mjs';
import { EventEmitter } from 'node:events';
import { TYPERT } from '../src/shared/remote.mjs';

test('Harness 0.2.1-rc.5 Gateway dispatches plugin, validates inputs and removes routes on disable', async () => {
  const ctx = new Context();
  const peer = { id: 'test-owner', ctx, principal: { kind: 'owner' }, signal: new AbortController().signal };
  ctx.provide('credentials', new MemoryCredentials());
  ctx.provide('remoteAccess', { decide: () => ({ kind: 'deny', reason: 'not-owner' }) });
  try {
    await ctx.plugin(TypertRegistry);
    await ctx.plugin(Gateway, {});
    const fiber = ctx.plugin(plugin); await fiber;
    const call = (method, args = {}, selectedPeer = peer) => ctx.typertGateway.invoke({ namespace: 'asr', method, args, peer: selectedPeer });
    const result = await call('catalog');
    assert.equal(result.activeId, 'builtin');
    assert.deepEqual((await ctx.credentials.readRecord('dsh-asr/config')).payload.version, 2);
    assert.equal(ctx.typert.local.get('asr/watch').mode, 'stream');
    for (const method of ['listen', 'mutate', 'reveal']) assert.equal(ctx.typert.local.get(`asr/${method}`), undefined);
    await assert.rejects(call('saveDevice', { sn: '__proto__', revision: 0, preferences: {} }));
    await assert.rejects(call('mutate', { request: { type: 'delete', id: 'builtin', revision: 0, ignored: true } }));
    await assert.rejects(call('reveal', { id: 'builtin', field: '__proto__' }));
    await assert.rejects(call('catalog', {}, { ...peer, principal: { kind: 'guest' } }), /access denied/);
    await fiber.dispose();
    assert.equal(ctx.typert.local.get('asr/catalog'), undefined);
    await assert.rejects(call('catalog'));
  } finally { await ctx.fiber.dispose(); }
});

test('Gateway streams AI prepare/insert/release and validates client acknowledgements', async () => {
  const ctx = new Context(), life = new AbortController();
  const peer = { id: 'ai-owner', ctx, principal: { kind: 'owner' }, signal: life.signal };
  ctx.provide('credentials', new MemoryCredentials());
  ctx.provide('remoteAccess', { decide: () => ({ kind: 'deny' }) });
  const sdk = new EventEmitter(); sdk.close = async () => {};
  let controller, stream;
  try {
    await ctx.plugin(TypertRegistry); await ctx.plugin(Gateway, {});
    await ctx.plugin({ inject: plugin.inject, apply(scope) {
      scope.effect(() => scope.typert.register(TYPERT));
      controller = new plugin.MouseController(scope, {}, { sdk });
    } });
    stream = await ctx.typertGateway.stream({ namespace: 'asr', method: 'watchAi', args: { clientId: 'ai-client' }, peer, signal: life.signal });
    const iterator = stream[Symbol.asyncIterator]();
    const call = args => ctx.typertGateway.invoke({ namespace: 'asr', method: 'answerAi', args, peer });
    const run = { id: 'ai-run', lifetime: new AbortController() };
    let eventPromise = iterator.next();
    const prepared = controller.aiConversation.prepare(run);
    let event = (await eventPromise).value;
    assert.equal(event.operation, 'prepare');
    assert.equal(await call({ clientId: 'other', requestId: event.requestId, ok: true }), false);
    assert.equal(await call({ clientId: 'ai-client', requestId: event.requestId, ok: true }), true);
    await prepared;
    for (const autoSend of [true, false]) {
      run.preferences = { aiAutoSend: autoSend };
      eventPromise = iterator.next();
      const inserted = controller.aiConversation.insert(run, '语音结果');
      event = (await eventPromise).value;
      assert.equal(event.operation, 'insert'); assert.equal(event.text, '语音结果');
      assert.equal(event.autoSend, autoSend);
      await call({ clientId: 'ai-client', requestId: event.requestId, ok: true }); await inserted;
    }
    eventPromise = iterator.next(); controller.aiConversation.release(run.id);
    assert.equal((await eventPromise).value.operation, 'release');
    await assert.rejects(call({ clientId: 'ai-client', requestId: event.requestId, ok: 'true' }));
    life.abort(); await iterator.return();
  } finally { life.abort(); stream?.dispose?.(); await ctx.fiber.dispose(); }
});
