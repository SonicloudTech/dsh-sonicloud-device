import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { AiConversationBridge } from '../src/host/ai-conversation.mjs';
import { AiConversationClient } from '../src/client/ai-conversation.mjs';
import { AiConversationView } from '../src/client/ai-conversation-view.mjs';
import { JSDOM } from 'jsdom';
import { DeviceManager } from '../src/devices/manager.mjs';
import { defaultPreferences } from '../src/shared/devices.mjs';
import { MemoryCredentials, until, tick } from './helpers.mjs';

function harness({ panel = null, current = 'existing', draft = '已有草稿', create, blocked = false, blank = false,
  workspaces = [{ workspaceId: 'project', path: '/project', sessionIds: ['existing'], createdAt: '2026-11-01' }] } = {}) {
  const drafts = new Map([[current, draft]]), opened = [], created = [], retained = [], inserted = [];
  const services = {
    workspaces: { list: { getSnapshot: () => ({ items: workspaces }) }, initializeDefault: async () => undefined },
    layout: { panelInfo: { getSnapshot: () => ({ activePanelId: panel }) } },
    sessions: {
      list: { getSnapshot: () => ({ byId: current ? { [current]: { id: current, cwd: '/project', blank, updatedAt: Date.now(), retainedBy: { mainView: 1 } } } : {} }) },
      create: async options => {
        created.push(options); const id = create ? await create() : `new-${created.length}`;
        const workspace = workspaces.find(item => item.workspaceId === options.workspaceId);
        assert.ok(workspace, 'a new conversation must belong to a workspace for its composer to be usable');
        workspace.sessionIds.push(id); drafts.set(id, ''); return id;
      },
      retain: (id, options) => {
        const binding = { sessionId: id }, ref = { sessionId: id, binding, ready: Promise.resolve(binding), released: 0, release() { this.released++; } };
        retained.push({ ref, options }); return ref;
      },
    },
    uiWorkspace: { openSession: id => { opened.push(id); current = id; panel = null; } },
    conversation: { input: { requestDraftInitialization: (binding, options) => {
      if (blocked) return 'blocked';
      assert.equal(options.whenDraftExists, 'append');
      inserted.push([binding.sessionId, options.prompt]);
      const previous = drafts.get(binding.sessionId);
      drafts.set(binding.sessionId, previous ? previous + '\n\n' + options.prompt : options.prompt);
      return 'applied';
    } } },
  };
  return { services, drafts, opened, created, retained, inserted,
    navigate: (id, nextPanel = null) => { current = id; panel = nextPanel; } };
}
async function fixture(options = {}) {
  const ui = harness(options), bridge = new AiConversationBridge({ timeoutMs: 100 });
  const submitted = [];
  const dom = new JSDOM('<body></body>');
  const view = new AiConversationView({ document: dom.window.document, closeTopModal: () => {} });
  const retain = ui.services.sessions.retain;
  ui.services.sessions.retain = (id, opts) => {
    view.mount(id, { submit: () => {
      if (options.submitError) throw new Error('发送不可用');
      submitted.push([id, ui.drafts.get(id)]);
    } });
    return retain(id, opts);
  };
  const api = { watchAi: (id, signal) => bridge.watch(id, signal),
    answerAi: async (...args) => ({ ok: true, value: bridge.answer(...args) }) };
  const client = new AiConversationClient(api, ui.services, { retryDelayMs: 5, view });
  const watching = client.connect();
  const sdk = new EventEmitter();
  sdk.start = async () => {}; sdk.sources = []; sdk.source = async id => { sdk.sources.push(id); return 1; }; sdk.close = async () => {};
  const events = [], actions = [], audio = [];
  const desktop = { begin: async run => events.push({ type: 'begin', action: run.action }), event: e => events.push(e),
    complete: async () => assert.fail('AI speech must never use system input insertion'), close: async () => {} };
  const manager = new DeviceManager({ credentials: new MemoryCredentials(), sdk, desktop, aiConversation: bridge,
    config: { tailMs: 0 }, action: async action => { actions.push(action); if (options.activationError) throw new Error('唤起失败'); },
    recognize: async function* ({ uplink, signal }) {
      yield { type: 'ready' };
      for await (const chunk of uplink) { signal.throwIfAborted(); audio.push(chunk); }
      yield { type: 'finishing' };
      if (options.recognitionError) throw new Error('识别失败');
      yield { type: 'transcript', text: options.text ?? '语音结果', final: true, begin: 0, end: 1 };
      yield { type: 'complete' };
    } });
  await manager.start(); await manager.event({ type: 'connected', id: '0001', mode: 0 });
  if (options.autoSend !== undefined) await manager.save('0001', 0, { ...defaultPreferences(), aiAutoSend: options.autoSend });
  const key = (action, id = '0001', key = 'ai') => {
    sdk.emit('event', { type: 'message', id, message: { type: 'keyEvent', key, action } });
    return manager.pending;
  };
  const stop = async () => { client.dispose(); await watching; await manager.close(); dom.window.close(); };
  return { ...ui, bridge, client, manager, sdk, events, actions, audio, submitted, key, stop };
}

test('AI press fills and submits the current conversation once by default without DOM focus', async () => {
  const s = await fixture();
  try {
    await s.key('down'); await s.key('down'); await s.key('hold'); await s.key('click');
    s.sdk.emit('event', { type: 'audio', id: '0001', data: Buffer.alloc(3200).toString('base64') });
    await s.key('up'); await s.key('up'); await until(() => !s.manager.run);
    assert.deepEqual(s.actions, ['openAi']); assert.equal(s.created.length, 0);
    assert.equal(s.drafts.get('existing'), '已有草稿\n\n语音结果'); assert.equal(s.inserted.length, 1);
    assert.deepEqual(s.submitted, [['existing', '已有草稿\n\n语音结果']]);
    assert.equal(s.audio.length, 1); assert.equal(s.events[0].type, 'devices');
    assert.ok(s.events.some(e => e.type === 'begin' && e.action === 'ai_input'));
    assert.ok(s.events.some(e => e.type === 'finished'));
    await until(() => s.client.targets.size === 0);
    assert.equal(s.retained[0].ref.released, 1); assert.deepEqual(s.sdk.sources, ['0001', '']);
  } finally { await s.stop(); }
});

test('disabled auto-send only fills the draft and the recording keeps its initial preference', async () => {
  const s = await fixture({ autoSend: false });
  try {
    await s.key('down');
    await s.manager.save('0001', 1, { ...defaultPreferences(), aiAutoSend: true });
    await s.key('up'); await until(() => !s.manager.run);
    assert.deepEqual(s.submitted, []);
    assert.equal(s.drafts.get('existing'), '已有草稿\n\n语音结果');
    await s.key('down'); await s.key('up'); await until(() => !s.manager.run);
    assert.equal(s.submitted.length, 1);
  } finally { await s.stop(); }
});

test('auto-send follows the originating device preference', async () => {
  const s = await fixture({ autoSend: false });
  try {
    await s.manager.event({ type: 'connected', id: '0002', mode: 0 });
    await s.key('down'); await s.key('up'); await until(() => !s.manager.run);
    assert.equal(s.submitted.length, 0);
    await s.key('down', '0002'); await s.key('up', '0002'); await until(() => !s.manager.run);
    assert.equal(s.submitted.length, 1);
  } finally { await s.stop(); }
});

test('submission invocation failure leaves the appended draft and copyable result', async () => {
  const s = await fixture({ submitError: true });
  try {
    await s.key('down'); await s.key('up'); await until(() => !s.manager.run);
    assert.equal(s.drafts.get('existing'), '已有草稿\n\n语音结果');
    assert.equal(s.inserted.length, 1); assert.equal(s.submitted.length, 0);
    assert.ok(s.events.some(e => e.type === 'failed'));
    assert.ok(s.events.some(e => e.type === 'preview' && e.text === '语音结果'));
  } finally { await s.stop(); }
});

test('a non-conversation page creates one fresh conversation and preserves the previous draft', async () => {
  const s = await fixture({ panel: 'settings' });
  try {
    await s.key('down'); await s.key('hold'); await s.key('up'); await until(() => !s.manager.run);
    assert.deepEqual(s.created, [{ workspaceId: 'project' }]); assert.deepEqual(s.opened, ['new-1']);
    assert.equal(s.drafts.get('new-1'), '语音结果'); assert.equal(s.drafts.get('existing'), '已有草稿');
    assert.deepEqual(s.submitted, [['new-1', '语音结果']]);
  } finally { await s.stop(); }
});

test('a conversation is created when no current session exists', async () => {
  const s = await fixture({ current: null });
  try {
    await s.key('down'); await s.key('up'); await until(() => !s.manager.run);
    assert.deepEqual(s.created, [{ workspaceId: 'project' }]); assert.equal(s.drafts.get('new-1'), '语音结果');
  } finally { await s.stop(); }
});

test('a blank conversation without workspace ownership is replaced with a usable conversation', async () => {
  const ui = harness({ current: 'orphan', blank: true });
  const client = new AiConversationClient({}, ui.services);
  try {
    await client.prepare('repair');
    assert.deepEqual(ui.created, [{ workspaceId: 'project' }]);
    assert.deepEqual(ui.opened, ['new-1']);
    assert.equal(await client.insert('repair', '可输入'), true);
  } finally { client.dispose(); }
});

test('new conversations prefer their owning workspace over a matching working directory', async () => {
  const ui = harness({ panel: 'plugins', workspaces: [
    { workspaceId: 'same-path', path: '/project', sessionIds: [], createdAt: '2026-11-09' },
    { workspaceId: 'owner', path: '/other', sessionIds: ['existing'], createdAt: '2026-11-01' },
  ] });
  const client = new AiConversationClient({}, ui.services);
  try {
    await client.prepare('owned');
    assert.deepEqual(ui.created, [{ workspaceId: 'owner' }]);
  } finally { client.dispose(); }
});

test('without a current conversation the most recently used workspace is selected', async () => {
  const ui = harness({ current: null, workspaces: [
    { workspaceId: 'older', path: '/older', sessionIds: [], createdAt: '2026-11-01' },
    { workspaceId: 'recent', path: '/recent', sessionIds: [], createdAt: '2026-11-09' },
  ] });
  const client = new AiConversationClient({}, ui.services);
  try {
    await client.prepare('recent');
    assert.deepEqual(ui.created, [{ workspaceId: 'recent' }]);
  } finally { client.dispose(); }
});

test('no available workspace fails without creating an unusable conversation', async () => {
  const ui = harness({ current: null, workspaces: [] });
  const client = new AiConversationClient({}, ui.services);
  try {
    await assert.rejects(client.prepare('missing'), /没有可用的工作区/);
    assert.deepEqual(ui.created, []); assert.deepEqual(ui.opened, []);
  } finally { client.dispose(); }
});

test('navigation and focus changes cannot redirect the recognized text to another conversation', async () => {
  const s = await fixture();
  try {
    await s.key('down'); await until(() => s.retained.length === 1);
    s.navigate('other', 'settings');
    await s.key('up'); await until(() => !s.manager.run);
    assert.deepEqual(s.opened, ['existing']); assert.equal(s.drafts.has('other'), false);
    assert.deepEqual(s.inserted, [['existing', '语音结果']]);
    assert.deepEqual(s.submitted, [['existing', '已有草稿\n\n语音结果']]);
  } finally { await s.stop(); }
});

test('slow conversation creation does not block key-up and cancellation discards late navigation', async () => {
  let resolveCreate;
  const s = await fixture({ panel: 'settings', create: () => new Promise(resolve => { resolveCreate = resolve; }) });
  try {
    await s.key('down'); await until(() => resolveCreate);
    await s.key('up'); assert.equal(s.manager.run.released, true);
    s.manager.cancel(); await until(() => !s.manager.run && !s.client.targets.size);
    resolveCreate('late'); await tick();
    assert.deepEqual(s.opened, []); assert.deepEqual(s.inserted, []); assert.equal(s.retained.length, 0);
    assert.deepEqual(s.submitted, []);
  } finally { resolveCreate?.('late'); await s.stop(); }
});

test('a second device or another key cannot end or steal an AI recording', async () => {
  const s = await fixture();
  try {
    await s.manager.event({ type: 'connected', id: '0002', mode: 0 });
    await s.key('down'); await s.key('down', '0002'); await s.key('up', '0002'); await s.key('up', '0001', 'speech');
    assert.equal(s.manager.run.released, false); assert.deepEqual(s.actions, ['openAi']);
    await s.key('up'); await until(() => !s.manager.run);
    assert.equal(s.inserted.length, 1);
  } finally { await s.stop(); }
});

for (const options of [{ activationError: true }, { blocked: true }, { create: async () => { throw new Error('create failed'); }, panel: 'settings' }]) {
  test(`AI target failure retains final text for copying: ${Object.keys(options)[0]}`, async () => {
    const s = await fixture(options);
    try {
      await s.key('down'); await s.key('up'); await until(() => !s.manager.run);
      assert.equal(s.inserted.length, 0);
      assert.deepEqual(s.submitted, []);
      assert.ok(s.events.some(e => e.type === 'preview' && e.text === '语音结果'));
      assert.ok(s.events.some(e => e.type === 'failed'));
      assert.equal(s.events.some(e => e.type === 'finished'), false);
    } finally { await s.stop(); }
  });
}

for (const options of [{ text: '' }, { recognitionError: true }]) {
  test(`empty or failed recognition never inserts AI text: ${Object.keys(options)[0]}`, async () => {
    const s = await fixture(options);
    try {
      await s.key('down'); await s.key('up'); await until(() => !s.manager.run);
      assert.equal(s.inserted.length, 0);
      assert.deepEqual(s.submitted, []);
      assert.ok(s.events.some(e => e.type === (options.recognitionError ? 'failed' : 'finished')));
    } finally { await s.stop(); }
  });
}

test('client disconnect preserves recognized text and never switches to another client', async () => {
  const s = await fixture();
  try {
    await s.key('down'); await until(() => s.retained.length);
    s.client.dispose(); await until(() => s.bridge.clients.size === 0);
    await s.key('up'); await until(() => !s.manager.run);
    assert.equal(s.inserted.length, 0); assert.ok(s.events.some(e => e.type === 'failed'));
    assert.ok(s.events.some(e => e.type === 'preview' && e.text === '语音结果'));
  } finally { await s.stop(); }
});

test('bridge waits for a renderer, validates acknowledgements, bounds timeouts and releases ownership', async () => {
  const bridge = new AiConversationBridge({ timeoutMs: 50 });
  const life = new AbortController(), run = { id: 'voice', lifetime: new AbortController() };
  try {
    const prepared = bridge.prepare(run);
    const stream = bridge.watch('window', life.signal), request = (await stream.next()).value;
    assert.equal(request.operation, 'prepare'); assert.equal(bridge.answer('wrong-window', request.requestId, true), false);
    assert.equal(bridge.answer('window', request.requestId, true), true); await prepared;
    assert.equal(bridge.answer('window', request.requestId, true), false);
    const timeout = bridge.insert(run, 'timeout');
    await assert.rejects(timeout, /未响应/); assert.equal(bridge.sessions.size, 0);
    life.abort(); await stream.return();
    assert.equal(bridge.requests.size, 0);
  } finally { life.abort(); bridge.close(); }
});

test('client treats duplicate inserts as acknowledgements and releases session references on disposal', async () => {
  let submissions = 0;
  const ui = harness(), client = new AiConversationClient({}, ui.services, { view: {
    settingsOpen: () => false, closeSettings: async () => {}, ready: async () => {},
    submit: () => { submissions++; return true; },
  } });
  await client.prepare('one');
  assert.deepEqual(await Promise.all([client.insert('one', '一次', Infinity, true), client.insert('one', '一次', Infinity, true)]), [true, true]);
  assert.equal(submissions, 1);
  assert.equal(ui.inserted.length, 1); client.dispose();
  assert.equal(ui.retained[0].ref.released, 1); assert.equal(await client.insert('one', '迟到'), false);
});

function visibleHarness({ panel = null, settings = false } = {}) {
  const ui = harness({ panel });
  const dom = new JSDOM('<body><main></main></body>');
  const doc = dom.window.document;
  const showSettings = () => {
    const modal = doc.createElement('div'); modal.dataset.shortcutModal = 'settings'; modal.role = 'dialog';
    doc.body.append(modal); return modal;
  };
  if (settings) showSettings();
  let closed = 0;
  const view = new AiConversationView({ document: doc, closeTopModal: () => {
    closed++; queueMicrotask(() => doc.querySelector('[data-shortcut-modal="settings"]')?.remove());
  } });
  const client = new AiConversationClient({}, ui.services, { view });
  const originalInsert = ui.services.conversation.input.requestDraftInitialization;
  ui.services.conversation.input.requestDraftInitialization = (binding, options) => {
    assert.ok(view.composers.has(binding.sessionId), 'insertion requires the target composer, not just history readiness');
    assert.equal(view.settingsOpen(), false);
    return originalInsert(binding, options);
  };
  return { ...ui, view, client, showSettings, closed: () => closed,
    dispose: () => { client.dispose(); dom.window.close(); } };
}

test('settings over a conversation is closed before creating a new conversation; prepare waits for its composer', async () => {
  const s = visibleHarness({ settings: true });
  try {
    s.view.mount('existing', {});
    let ready = false;
    const preparing = s.client.prepare('from-settings', Date.now() + 500).then(() => { ready = true; });
    await until(() => s.opened.length);
    assert.equal(s.closed(), 1); assert.equal(s.view.settingsOpen(), false);
    assert.equal(s.created.length, 1); assert.equal(ready, false);
    assert.deepEqual(s.opened, ['new-1']);
    s.view.mount('new-1', {}); await preparing;
    assert.equal(await s.client.insert('from-settings', '设置页语音'), true);
    assert.equal(s.drafts.get('new-1'), '设置页语音');
    assert.equal(s.drafts.get('existing'), '已有草稿');
  } finally { s.dispose(); }
});

test('navigation from another panel waits for the new composer and inserts once after readiness', async () => {
  const s = visibleHarness({ panel: 'plugins' });
  try {
    const preparing = s.client.prepare('from-panel', Date.now() + 500);
    await until(() => s.opened.length);
    assert.equal(s.inserted.length, 0);
    s.view.mount('new-1', {}); await preparing;
    assert.equal(await s.client.insert('from-panel', '新对话文字'), true);
    assert.deepEqual(s.inserted, [['new-1', '新对话文字']]);
  } finally { s.dispose(); }
});

test('settings reopened during recognition is closed; an unmounted captured composer is awaited again', async () => {
  const s = visibleHarness();
  try {
    const unmount = s.view.mount('existing', {});
    await s.client.prepare('recording'); unmount(); s.showSettings(); s.navigate('other');
    const inserting = s.client.insert('recording', '返回原对话', Date.now() + 500);
    await until(() => s.opened.length);
    assert.deepEqual(s.opened, ['existing']); assert.equal(s.inserted.length, 0);
    assert.equal(s.closed(), 1); assert.equal(s.view.settingsOpen(), false);
    s.view.mount('existing', {}); assert.equal(await inserting, true);
    assert.deepEqual(s.inserted, [['existing', '返回原对话']]);
  } finally { s.dispose(); }
});

test('cancellation and timeout while waiting for the composer remove listeners and block late insertion', async () => {
  const s = visibleHarness({ panel: 'files' });
  try {
    const preparing = s.client.prepare('cancelled', Date.now() + 500);
    const cancelled = assert.rejects(preparing, /取消/);
    await until(() => s.opened.length);
    s.client.release('cancelled'); await cancelled;
    s.view.mount('new-1', {});
    assert.equal(await s.client.insert('cancelled', '迟到文字'), false);
    s.navigate('other', 'files');
    await assert.rejects(s.client.prepare('timeout', Date.now() + 15), /未就绪/);
    assert.equal(s.inserted.length, 0); assert.equal(s.view.listeners.size, 0);
  } finally { s.dispose(); }
});

test('a suspended renderer rejects expired insertions instead of applying queued text after timeout', async () => {
  const ui = harness(), answers = [];
  const client = new AiConversationClient({ answerAi: async (...args) => answers.push(args) }, ui.services);
  try {
    await client.prepare('old');
    await client.handle({ sessionId: 'old', requestId: 'late', operation: 'insert', text: '迟到结果', expiresAt: Date.now() - 1 });
    assert.equal(ui.inserted.length, 0); assert.equal(answers[0][2], false);
    assert.equal(client.targets.size, 0); assert.equal(ui.retained[0].ref.released, 1);
  } finally { client.dispose(); }
});
