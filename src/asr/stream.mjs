import WebSocket from 'ws';

class Queue {
  items = [];
  ended = false;
  push(item) {
    if (this.ended) return;
    if (this.items.length >= 256) { this.items = [{ type: 'error', message: '识别结果接收过慢，请重新录音' }]; this.end(); return; }
    this.items.push(item); this.wake?.();
  }
  end() { this.ended = true; this.wake?.(); }
  async *[Symbol.asyncIterator]() {
    while (true) {
      if (this.items.length) yield this.items.shift();
      else if (this.ended) return;
      else await new Promise(resolve => { this.wake = resolve; });
    }
  }
}

const errors = {
  '4010': 'Token 认证失败，请稍后重试',
  '4011': 'ASR 额度不足，请充值后重试',
  '4012': 'ASR 应用不存在、未认证或已下线',
  '4013': 'ASR 并发连接已达上限，请稍后重试',
  '4014': 'License 设备未注册', '4015': 'License 设备已被其他会话占用',
  '-1': '语音太短，请重新录音', '16': '未识别到语音',
};

// The live service also uses numeric strings and code 3 interim / code 10 final frames.
function timestamp(value) {
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value))) return undefined;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

/** The end marker is authoritative; upstream may keep its WebSocket open afterwards. */
export async function* streamRecognition({ service, token, uplink, signal, onAuthFailure = () => {}, WebSocketImpl = WebSocket,
  connectTimeout = 10_000, finalTimeout = 5_000, idleTimeout = 15_000 }) {
  signal.throwIfAborted();
  const queue = new Queue();
  const url = new URL(service.streamUrl);
  for (const [key, value] of Object.entries(service.recognitionQuery ?? { lanid: '0', lid: '0', role: '0' })) url.searchParams.set(key, String(value));
  // Credentials stay out of connection URLs and browser storage.
  const socket = new WebSocketImpl(url, {
    headers: { 'X-SC-Authorization': token, 'X-SC-User-Id': service.userId },
    handshakeTimeout: connectTimeout, maxPayload: 128 * 1024, followRedirects: false,
  });
  let ready = false, ended = false, complete = false, timer, connectTimer, totalBytes = 0;
  let settleReady;
  const readiness = new Promise(resolve => { settleReady = resolve; });
  const fail = (message, code) => {
    if (queue.ended) return;
    queue.push({ type: 'error', message, ...(code ? { code, retryable: code === '4010' && !ready } : {}) }); queue.end();
    settleReady(false);
    socket.terminate();
  };
  const arm = (delay, message) => { clearTimeout(timer); timer = setTimeout(() => fail(message), delay); };
  connectTimer = setTimeout(() => fail('ASR 连接超时，请检查网络后重试'), connectTimeout);
  const abort = () => { queue.end(); settleReady(false); socket.terminate(); };
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  socket.on('error', () => fail('ASR 连接失败，请检查服务地址与网络'));
  const transcript = (message, forcedFinal) => {
    const begin = timestamp(message.Begin), end = timestamp(message.End);
    if (!ready || complete || typeof message.result !== 'string' || message.result.length > 4096 ||
        begin === undefined || end === undefined || (end > 0 && end < begin)) {
      fail('ASR 返回了无效识别结果'); return false;
    }
    queue.push({ type: 'transcript', text: message.result, begin, end, final: forcedFinal ?? end > 0 });
    return true;
  };
  socket.on('message', data => {
    if (queue.ended) return;
    let message;
    try { message = JSON.parse(data.toString()); } catch { fail('ASR 返回了无效数据'); return; }
    const code = String(message?.errCode);
    if (code === '1000') {
      if (ready) return;
      ready = true; clearTimeout(connectTimer);
      arm(idleTimeout, '录音数据中断，请重新录音'); queue.push({ type: 'ready' });
      settleReady(true);
    } else if (code === '1001') queue.push({ type: 'warning', message: 'ASR 余额较低，请及时充值' });
    else if (code === '0') transcript(message);
    else if (code === '3') {
      // End can be nonzero on live rolling results; code 3 is never a final sentence.
      if (Object.hasOwn(message, 'Begin') || Object.hasOwn(message, 'End')) transcript(message, false);
    } else if (code === '10') {
      if (!ended) { fail('ASR 服务提前结束了录音'); return; }
      // Older responses send the final sentence separately with code 0. Newer ones
      // include it in code 10. Do not treat an untimed status message as transcript.
      if ((Object.hasOwn(message, 'Begin') || Object.hasOwn(message, 'End')) && !transcript(message, true)) return;
      complete = true;
      clearTimeout(timer);
      queue.push({ type: 'complete' }); queue.end();
    }
    else {
      if (code === '4010') onAuthFailure();
      fail(errors[code] ?? (code.startsWith('400') ? 'ASR 连接参数无效，请检查配置' : 'ASR 识别失败，请稍后重试'), code);
    }
  });
  socket.on('close', () => {
    if (queue.ended) return;
    fail('ASR 连接中断，识别结果未完成');
  });
  const input = uplink[Symbol.asyncIterator]();
  const upload = async () => {
    try {
      // Hardware can produce audio (and release the key) before the handshake.
      // Keep it in the device's bounded queue until the service accepts audio.
      if (!await readiness || queue.ended || signal.aborted) return;
      while (!queue.ended) {
        const { done, value } = await input.next();
        if (queue.ended || signal.aborted) return;
        if (done) {
          ended = true;
          arm(finalTimeout, '最终识别结果超时，可复制已有预览后重试');
          queue.push({ type: 'finishing' });
          socket.send('end'); return;
        }
        if (typeof value !== 'string' || value.length > 4400) throw new Error('音频包无效');
        const bytes = Buffer.from(value, 'base64');
        if (bytes.toString('base64') !== value || bytes.length <= 80 || bytes.length > 3200 || bytes.length % 2) throw new Error('音频包无效');
        totalBytes += bytes.length;
        if (totalBytes > 16_000 * 2 * 600) throw new Error('单次录音最长 10 分钟');
        if (socket.bufferedAmount > 320_000) throw new Error('网络发送过慢，请重新录音');
        socket.send(bytes); arm(idleTimeout, '录音数据中断，请重新录音');
      }
    } catch (error) {
      if (!signal.aborted) fail(error.message === '音频包无效' || error.message === '单次录音最长 10 分钟' || error.message === '网络发送过慢，请重新录音'
        ? error.message : '音频上传中断，请重新录音');
    }
  };
  void upload();
  try { yield* queue; }
  finally {
    clearTimeout(timer); clearTimeout(connectTimer); queue.end(); settleReady(false);
    signal.removeEventListener('abort', abort);
    if (complete && socket.readyState === WebSocket.OPEN) {
      // Finish locally after code 10; a missing server close handshake cannot delay insertion.
      const closing = setTimeout(() => socket.terminate(), 1000);
      closing.unref?.();
      socket.once('close', () => clearTimeout(closing));
      socket.close();
    } else socket.terminate();
    // Carrier cancellation owns completion of an input.next() still in flight.
    if (ready) void Promise.resolve(input.return?.()).catch(() => {});
  }
}
