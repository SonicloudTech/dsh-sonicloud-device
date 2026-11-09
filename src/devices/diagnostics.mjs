import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

// Read only the production receiver's vendor data interface; keyboard/mouse clients
// and non-exclusive HID observers (such as Logitech Options) are not blockers.
export function parseUsbOwners(output, workerPid) {
  let receiver, iface, client;
  const receivers = [], owners = [];
  for (const line of output.split('\n')) {
    const node = line.indexOf('+-o ');
    if (node >= 0) {
      client = undefined;
      if (node === 0) { receiver = {}; receivers.push(receiver); iface = undefined; }
      if (line.includes('<class IOUSBHostInterface,')) iface = undefined;
      if (line.includes('<class IOHIDLibUserClient,')) client = { receiver, iface };
      continue;
    }
    let match;
    if (receiver && (match = line.match(/"idVendor" = (\d+)/))) receiver.vid = Number(match[1]);
    if (receiver && (match = line.match(/"idProduct" = (\d+)/))) receiver.pid = Number(match[1]);
    if ((match = line.match(/"bInterfaceNumber" = (\d+)/))) iface = Number(match[1]);
    if (!client) continue;
    if ((match = line.match(/"IOUserClientCreator" = "pid (\d+), ([^"]+)"/))) {
      client.pid = Number(match[1]); client.name = match[2].replace(/[\x00-\x1f\x7f]/g, '').slice(0, 80);
    }
    if ((match = line.match(/"ClientOptions"=(\d+)/))) {
      client.exclusive = (Number(match[1]) & 1) !== 0 && /"ClientOpened"=Yes/.test(line);
    }
    if (client.exclusive && client.pid && !client.recorded) { owners.push(client); client.recorded = true; }
  }
  const matches = item => item?.vid === 0xabc9 && item?.pid === 0xca89;
  return {
    receiverPresent: receivers.some(matches),
    owners: owners.filter(item => matches(item.receiver) && item.iface === 1 && item.pid !== workerPid)
      .map(({ pid, name }) => ({ pid, name })),
  };
}

export async function diagnoseUsb(workerPid, { platform = process.platform, execute = run } = {}) {
  if (platform !== 'darwin') return '';
  const { stdout } = await execute('/usr/sbin/ioreg', ['-r', '-n', 'uMouse', '-l', '-w', '0'], { timeout: 2000, maxBuffer: 8 * 1024 * 1024 });
  const result = parseUsbOwners(stdout, workerPid);
  if (result.owners.length) {
    const names = [...new Set(result.owners.map(item => item.name))].join('、');
    return `鼠标 USB 数据接口被 ${names} 占用，请退出该应用；释放后会自动重试连接。`;
  }
  return result.receiverPresent
    ? '已检测到 2.4G 接收器，正在等待鼠标响应。请确认鼠标已开机并切到 2.4G 模式。'
    : '正在查找智能鼠标，请插入 2.4G 接收器或连接蓝牙。';
}
