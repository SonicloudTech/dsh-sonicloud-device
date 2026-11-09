import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import TypertRegistry from '@deepseek-ai/dsh-typert-registry';
import Gateway from '@deepseek-ai/dsh-api-gateway';
import * as plugin from '../src/host/index.mjs';
import { MemoryCredentials } from './helpers.mjs';

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
