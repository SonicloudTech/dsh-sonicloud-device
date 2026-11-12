// 冒烟：启动已安装的语音浮层进程，验证编译与 IPC 响应
import { spawn } from 'node:child_process';
const ps1 = 'C:/Users/32691/.dsh/profiles/desktop/node_modules/@sonicloud/dsh-sonicloud-device/native/desktop/windows.ps1';
const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', ps1], { stdio: ['pipe', 'pipe', 'pipe'] });
let out = '';
child.stdout.on('data', d => { out += d; });
child.stderr.on('data', d => process.stderr.write('[err] ' + d));
const send = m => child.stdin.write(JSON.stringify(m) + '\n');
send({ id: 1, command: 'begin', sessionId: 's', action: 'speechSearch' });
setTimeout(() => send({ id: 2, command: 'event', sessionId: 's', type: 'finished' }), 300);
setTimeout(() => { console.log('[stdout]', out.trim() || '(空)'); child.kill(); }, 1500);
