import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { streamRecognition } from '../src/asr/stream.mjs';
import { AsyncItems } from './helpers.mjs';

function fakeSocket(onSend = () => {}, autoReady = true) {
  return class extends EventEmitter {
    static instance;
    bufferedAmount = 0;
    constructor(url, options) {
      super(); this.constructor.instance = this; this.url = url; this.options = options;
      if (autoReady) queueMicrotask(() => this.message({ errCode: '1000' }));
    }
    message(value) { this.emit('message', Buffer.from(JSON.stringify(value))); }
    send(value) { onSend(this, value); }
    terminate() { this.terminated = true; this.emit('close'); }
  };
}
const service = { streamUrl: 'wss://example.invalid/asr', userId: 'user-test' };

test('audio and key release before ASR readiness wait for handshake and upload in order', { timeout: 1000 }, async () => {
  const uploads = [], input = new AsyncItems(), events = [];
  const packets = [Buffer.alloc(3200, 1), Buffer.alloc(3200, 2)];
  for (const packet of packets) input.push(packet.toString('base64'));
  input.end();
  const Socket = fakeSocket((socket, value) => {
    uploads.push(value);
    if (value === 'end') socket.message({ errCode: '10', result: '完整语音', Begin: 0, End: 200 });
  }, false);
  const watching = (async () => {
    for await (const event of streamRecognition({ service, token: 'x', uplink: input, signal: new AbortController().signal, WebSocketImpl: Socket })) events.push(event);
  })();
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(events, []);
    assert.deepEqual(uploads, []);
    Socket.instance.message({ errCode: '1000' });
    await watching;
    assert.deepEqual(uploads, [...packets, 'end']);
    assert.deepEqual(events.map(item => item.type), ['ready', 'finishing', 'transcript', 'complete']);
  } finally { Socket.instance.terminate(); await watching; }
});

test('cancel, timeout and rejection before readiness never upload buffered audio', { timeout: 1000 }, async () => {
  for (const mode of ['cancel', 'timeout', 'auth', 'close']) {
    const uploads = [], input = new AsyncItems(), events = [], abort = new AbortController();
    let invalidated = 0;
    input.push(Buffer.alloc(3200).toString('base64')); input.end();
    const Socket = fakeSocket((socket, value) => uploads.push(value), false);
    const watching = (async () => {
      for await (const event of streamRecognition({ service, token: 'x', uplink: input, signal: abort.signal,
        WebSocketImpl: Socket, connectTimeout: 20, onAuthFailure: () => invalidated++ })) events.push(event);
    })();
    if (mode === 'cancel') abort.abort();
    if (mode === 'auth') Socket.instance.message({ errCode: '4010' });
    if (mode === 'close') Socket.instance.emit('close');
    await watching;
    Socket.instance.message({ errCode: '1000' });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(uploads, []);
    assert.ok(Socket.instance.terminated);
    if (mode === 'cancel') assert.deepEqual(events, []);
    else {
      assert.equal(events.length, 1);
      assert.equal(events[0].type, 'error');
      assert.match(events[0].message, mode === 'timeout' ? /连接超时/ : mode === 'auth' ? /认证失败/ : /连接中断/);
    }
    assert.equal(invalidated, mode === 'auth' ? 1 : 0);
  }
});

test('stream sends PCM binary and end; consumes last sentence before completion', async () => {
  const uploads = [], input = new AsyncItems();
  const Socket = fakeSocket((socket, value) => {
    uploads.push(value);
    if (value === 'end') {
      socket.message({ errCode: '0', result: '末句', Begin: 0, End: 100 });
      socket.message({ errCode: '10' }); socket.emit('close');
    }
  });
  const events = [];
  for await (const event of streamRecognition({ service, token: 'test-token', uplink: input, signal: new AbortController().signal, WebSocketImpl: Socket })) {
    events.push(event);
    if (event.type === 'ready') {
      Socket.instance.message({ errCode: '1001' });
      input.push(Buffer.alloc(3200).toString('base64')); input.end();
    }
  }
  assert.deepEqual(events.map(item => item.type), ['ready', 'warning', 'finishing', 'transcript', 'complete']);
  assert.ok(Buffer.isBuffer(uploads[0])); assert.equal(uploads[1], 'end');
  assert.equal(Socket.instance.options.headers['X-SC-Authorization'], 'test-token');
  assert.equal(Socket.instance.url.href.includes('test-token'), false);
  assert.ok(Socket.instance.terminated);
});

test('live code 3 previews and code 10 final payload complete without waiting for socket close', async () => {
  const input = new AsyncItems();
  const Socket = fakeSocket((socket, value) => {
    if (value === 'end') {
      // Observed from the live service: timestamps become strings on the final frame;
      // no subsequent close frame arrives, even after 20 seconds.
      socket.message({ errCode: '10', result: '今天天气怎么样？', Begin: '0', End: '1781' });
    } else socket.message({ errCode: '3', result: '今天天气', Begin: 0, End: 1700 });
  });
  const events = [];
  for await (const event of streamRecognition({ service, token: 'x', uplink: input, signal: new AbortController().signal,
    WebSocketImpl: Socket, finalTimeout: 20 })) {
    events.push(event);
    if (event.type === 'ready') { input.push(Buffer.alloc(3200).toString('base64')); input.end(); }
  }
  const text = events.filter(item => item.type === 'transcript');
  assert.deepEqual(text.map(item => item.final), [false, true]);
  assert.equal(text[1].text, '今天天气怎么样？'); assert.equal(text[1].end, 1781);
  assert.equal(events.at(-1).type, 'complete'); assert.ok(Socket.instance.terminated);
});

test('terminal frame without speech completes cleanly even if socket stays open', async () => {
  const input = new AsyncItems();
  const Socket = fakeSocket((socket, value) => { if (value === 'end') socket.message({ errCode: '10' }); });
  const events = [];
  for await (const event of streamRecognition({ service, token: 'x', uplink: input, signal: new AbortController().signal, WebSocketImpl: Socket })) {
    events.push(event); if (event.type === 'ready') input.end();
  }
  assert.deepEqual(events.map(item => item.type), ['ready', 'finishing', 'complete']);
});

test('abnormal close and malformed audio never report completion', async () => {
  for (const mode of ['close', 'audio']) {
    const Socket = fakeSocket(); const input = new AsyncItems(); const events = [];
    for await (const event of streamRecognition({ service, token: 'x', uplink: input, signal: new AbortController().signal, WebSocketImpl: Socket })) {
      events.push(event);
      if (event.type === 'ready') {
        if (mode === 'close') Socket.instance.emit('close'); else input.push('bad-base64');
        input.end();
      }
    }
    assert.equal(events.at(-1).type, 'error'); assert.ok(!events.some(item => item.type === 'complete'));
  }
});

test('server final timeout terminates socket, and authentication failures invalidate token', async () => {
  for (const mode of ['timeout', 'auth']) {
    let invalidated = 0;
    const Socket = fakeSocket(); const input = new AsyncItems(); const events = [];
    for await (const event of streamRecognition({ service, token: 'x', uplink: input, signal: new AbortController().signal,
      WebSocketImpl: Socket, finalTimeout: 10, onAuthFailure: () => invalidated++ })) {
      events.push(event);
      if (event.type === 'ready') {
        if (mode === 'auth') Socket.instance.message({ errCode: '4010' });
        input.end();
      }
    }
    assert.equal(events.at(-1).type, 'error'); assert.equal(invalidated, mode === 'auth' ? 1 : 0);
    assert.ok(Socket.instance.terminated);
  }
});

test('cancellation is silent and closes upstream socket', async () => {
  const Socket = fakeSocket(); const input = new AsyncItems(); const abort = new AbortController(); const events = [];
  for await (const event of streamRecognition({ service, token: 'x', uplink: input, signal: abort.signal, WebSocketImpl: Socket })) {
    events.push(event); abort.abort(); input.end();
  }
  assert.deepEqual(events.map(item => item.type), ['ready']); assert.ok(Socket.instance.terminated);
});

test('stream forwards selected language IDs without replacing them with Chinese defaults', async () => {
  for (const lanid of ['1', '4', '100', '106']) {
    const input = new AsyncItems();
    const Socket = fakeSocket((socket, value) => { if (value === 'end') socket.message({ errCode: '10' }); });
    for await (const event of streamRecognition({ service: { ...service, recognitionQuery: { lanid, lid: '0', role: '0' } }, token: 'test', uplink: input, signal: new AbortController().signal, WebSocketImpl: Socket })) {
      if (event.type === 'ready') input.end();
    }
    assert.equal(Socket.instance.url.searchParams.get('lanid'), lanid);
    assert.equal(Socket.instance.url.searchParams.get('lid'), '0');
    assert.equal(Socket.instance.url.searchParams.get('role'), '0');
  }
});
