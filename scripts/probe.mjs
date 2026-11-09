import WebSocket from 'ws';
import { BUILTIN_ASR } from '../src/asr/config.mjs';
import { createTokenProvider } from '../src/asr/auth.mjs';

// Explicit connectivity check: no microphone, no audio, no credentials in output.
try {
  const sn = process.argv[2];
  if (!sn) throw new Error('missing SN');
  const token = await createTokenProvider({ sn })();
  console.log('Token: OK');
  const endpoint = BUILTIN_ASR.streamUrl.replace(/^ws:/, 'wss:');
  await new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint, { headers: { 'X-SC-Authorization': token, 'X-SC-User-Id': 'dsh-sonicloud-device-connectivity-probe' }, handshakeTimeout: 10_000 });
    const timer = setTimeout(() => { socket.terminate(); reject(new Error('timeout')); }, 12_000);
    let accepted = false;
    socket.on('message', bytes => {
      let message;
      try { message = JSON.parse(bytes.toString()); } catch { return; }
      if (String(message.errCode) === '1000') { accepted = true; console.log('WSS authenticated handshake: OK'); socket.close(); }
      else if (String(message.errCode) !== '1001') { console.log('ASR status:', String(message.errCode).replace(/[^0-9-]/g, '').slice(0, 6)); socket.close(); }
    });
    socket.on('error', () => { clearTimeout(timer); reject(new Error('connection')); });
    socket.on('close', () => { clearTimeout(timer); accepted ? resolve() : reject(new Error('rejected')); });
  });
} catch { console.error('连接检查失败；请通过 npm run probe -- <设备SN> 指定真实设备，详情不输出。'); process.exitCode = 1; }
