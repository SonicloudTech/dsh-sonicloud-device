import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseUsb, parseUsbOwners } from '../src/devices/diagnostics.mjs';

const tree = (pid = 50819, name = 'ClawMouse', options = 1, iface = 1) => `+-o uMouse@123 <class IOUSBHostDevice, id 1>
  | "idVendor" = 43977
  | "idProduct" = 51849
  +-o IOUSBHostInterface@${iface} <class IOUSBHostInterface, id 2>
    | "bInterfaceNumber" = ${iface}
    +-o HID <class AppleUserHIDDevice, id 3>
      +-o IOHIDLibUserClient <class IOHIDLibUserClient, id 4>
          "IOUserClientCreator" = "pid ${pid}, ${name}"
          "DebugState" = {"ClientSeized"=No,"ClientOptions"=${options},"ClientOpened"=Yes}
`;

test('USB diagnosis identifies the exclusive vendor-interface owner and excludes SDK/shared/keyboard clients', () => {
  assert.deepEqual(parseUsbOwners(tree(), 999), { receiverPresent: true, owners: [{ pid: 50819, name: 'ClawMouse' }] });
  assert.deepEqual(parseUsbOwners(tree(999, 'DeepSeek Harness'), 999).owners, []);
  assert.deepEqual(parseUsbOwners(tree(4301, 'Logi Options', 0), 999).owners, []);
  assert.deepEqual(parseUsbOwners(tree(4301, 'Keyboard App', 1, 0), 999).owners, []);
  assert.deepEqual(parseUsbOwners(tree().replace('43977', '1234'), 999), { receiverPresent: false, owners: [] });
});

test('USB diagnosis differentiates absent receiver, waiting hardware and external ownership', async () => {
  const diagnose = stdout => diagnoseUsb(999, { platform: 'darwin', execute: async (file, args) => {
    assert.equal(file, '/usr/sbin/ioreg'); assert.deepEqual(args, ['-r', '-n', 'uMouse', '-l', '-w', '0']); return { stdout };
  } });
  assert.match(await diagnose(tree()), /ClawMouse 占用/);
  assert.match(await diagnose(tree(999, 'DeepSeek Harness')), /已检测到 2.4G 接收器/);
  assert.match(await diagnose(''), /请插入 2.4G 接收器/);
  assert.equal(await diagnoseUsb(999, { platform: 'win32', execute: () => { throw new Error('must not run'); } }), '');
});
