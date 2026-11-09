import test from 'node:test';
import assert from 'node:assert/strict';
import { Transcript } from '../src/shared/transcript.mjs';
import { ServiceStore } from '../src/host/store.mjs';
import { MemoryCredentials } from './helpers.mjs';

const service = { id: 'custom', name: ' Test ', streamUrl: 'wss://example.com/asr', tokenUrl: 'https://example.com/token', appId: 'app', apiKey: 'key', apiSecret: 'secret' };

test('interim replacements and repeated final sentences do not duplicate text', () => {
  const transcript = new Transcript();
  transcript.update({ final: false, begin: 0, end: 0, text: '你' });
  transcript.update({ final: false, begin: 0, end: 0, text: '你好' });
  assert.equal(transcript.preview(), '你好');
  transcript.update({ final: true, begin: 0, end: 200, text: '你好。' });
  transcript.update({ final: true, begin: 0, end: 200, text: '你好。' });
  transcript.update({ final: false, begin: 0, end: 0, text: '迟到' });
  transcript.update({ final: true, begin: 300, end: 500, text: '世界。' });
  assert.equal(transcript.finalText(), '你好。世界。');
});

test('service migration removes old settings while preserving user identity and unrelated records', async () => {
  const credentials = new MemoryCredentials();
  const old = { kind: 'grant', payload: { version: 1, revision: 8, userId: 'original-user', activeId: 'custom', services: [service], sn: 'old-handwritten' } };
  await credentials.modifyRecord('dsh-asr/config', () => old);
  await credentials.modifyRecord('other-plugin', () => ({ kind: 'grant', payload: { keep: true } }));
  await credentials.modifyRecord('dsh-asr/devices', () => ({ kind: 'grant', payload: { keep: 'preferences' } }));
  const store = new ServiceStore(credentials);
  const selected = await store.resolve();
  assert.equal(selected.userId, 'original-user'); assert.equal(selected.id, 'builtin');
  assert.equal(selected.tokenUrl, 'https://dsh_device.sonicrhino.cc/api/open.sign/generate');
  assert.deepEqual(await credentials.readRecord('dsh-asr/config'), { kind: 'grant', payload: { version: 2, userId: 'original-user' } });
  assert.deepEqual(await credentials.readRecord('other-plugin'), { kind: 'grant', payload: { keep: true } });
  assert.deepEqual(await credentials.readRecord('dsh-asr/devices'), { kind: 'grant', payload: { keep: 'preferences' } });
  assert.equal((await new ServiceStore(credentials).resolve()).userId, 'original-user');
  assert.equal(store.mutate, undefined); assert.equal(store.reveal, undefined);
  assert.equal((await store.catalog()).services.length, 1);
});
