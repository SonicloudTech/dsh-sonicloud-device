import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { DeviceStore } from '../src/devices/store.mjs';
import { defaultPreferences, languageKey } from '../src/shared/devices.mjs';
import { ServiceStore } from '../src/host/store.mjs';
import { AsyncItems, MemoryCredentials } from './helpers.mjs';

test('built client hides shared services, edits per-device preferences, and disposes UI', async () => {
  const dom = new JSDOM('<html><head></head><body><div id="root"></div></body></html>', { url: 'https://localhost/' });
  const original = { window: globalThis.window, document: globalThis.document, act: globalThis.IS_REACT_ACT_ENVIRONMENT };
  globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const registrations = new Map(); const cleanups = []; let remoteDisposed = false;
  const store = new ServiceStore(new MemoryCredentials());
  let catalogCalls = 0;
  const events = new AsyncItems();
  const deviceStore = new DeviceStore(new MemoryCredentials());
  let connectedDevices = [];
  const devicesEvent = () => ({ type: 'devices', status: '就绪', devices: connectedDevices, recognitionLanguages: [languageKey(defaultPreferences().recognition)], translationReady: false });
  const reportDpi = async (sn, dpi, level) => {
    const saved = await deviceStore.reportDpi(sn, dpi);
    connectedDevices = connectedDevices.map(device => device.sn === sn ? { ...device, ...saved, dpiRaw: level, dpiState: 'reported' } : device);
    events.push(devicesEvent());
  };
  const api = {
    watch: () => events,
    saveDevice: async (sn, revision, preferences) => {
      const saved = await deviceStore.save(sn, revision, preferences);
      connectedDevices = connectedDevices.map(device => device.sn === sn ? { ...device, ...saved } : device); events.push(devicesEvent());
      return { ok: true, value: { ...saved, message: '已保存' } };
    },
    cancel: async () => ({ ok: true, value: true }),
    catalog: async () => { catalogCalls++; return { ok: true, value: await store.catalog() }; },
  };
  const Button = ({ children, variant, size, icon, ...props }) => React.createElement('button', { type: 'button', ...props }, children);
  const Modal = ({ open, title, children }) => open ? React.createElement('div', { role: 'dialog', 'aria-label': title }, children) : null;
  const Menu = ({ open, anchor, items, onSelect }) => React.createElement(React.Fragment, null, anchor,
    open && React.createElement('div', { role: 'menu' }, items.map(item => React.createElement('button', {
      key: item.id, role: 'menuitem', disabled: item.disabled, 'data-value': item.id, onClick: () => onSelect(item.id),
    }, item.label))));
  const Switch = ({ checked, onChange, label }) => React.createElement('button', { role: 'switch', 'aria-label': label, 'aria-checked': checked, onClick: () => onChange(!checked) });
  let linkInputProps;
  const Input = props => {
    if (props['aria-label'] === '一键链接 URL') linkInputProps = props;
    return React.createElement('input', props);
  };
  const IconChevronDownOutlineRegular = () => null;
  const Toast = ({ text, onDone }) => React.createElement('div', { role: 'alert', 'data-test-toast': true }, text, React.createElement('button', { onClick: onDone }, '关闭提示'));
  const IconWarningOutlineRegular = () => null;
  let entry;
  const sandbox = { window: { __ModuleLoader__: { load: value => { entry = value; } } }, document: dom.window.document,
    crypto: globalThis.crypto, URL, AbortController, setTimeout, clearTimeout, console, MutationObserver: dom.window.MutationObserver };
  vm.runInNewContext(await readFile('dist/client.js', 'utf8'), sandbox);
  assert.equal(entry.id, 'dsh-sonicloud-device');
  const plugin = entry.factory(name => {
    if (name === 'react') return React;
    if (name === '@deepseek-ai/dsh-client-ui-primitives') return { Button, Modal, Menu, Switch, Input, IconChevronDownOutlineRegular, Toast, IconWarningOutlineRegular };
    throw new Error(`Unexpected browser dependency ${name}`);
  });
  const scope = {
    remote: { asr: api },
    effect: factory => { cleanups.push(factory()); },
    slots: { inject: (name, fn) => fn(), register: (options, component) => { registrations.set(options.name, { options, component }); } },
  };
  const ctx = {
    remote: { $mount: async remote => { assert.equal(remote.descriptors.length, 8); return () => { remoteDisposed = true; }; } },
    inject: (services, callback) => { callback(scope); return { dispose: async () => { for (const cleanup of cleanups) await cleanup(); } }; },
  };
  const dispose = await plugin.apply(ctx);
  const settings = registrations.get('settings.section');
  assert.equal(settings.options.label(), '声云设备'); assert.equal(registrations.get('conversation.input.overlay').options.id, 'dsh-sonicloud-device-ai-target');
  assert.equal(dom.window.document.querySelector('.dsh-mouse-status'), null);
  const root = createRoot(dom.window.document.getElementById('root'));
  const overlay = registrations.get('shell.overlay');
  const overlayNode = dom.window.document.createElement('div'); dom.window.document.body.append(overlayNode);
  const overlayRoot = createRoot(overlayNode);
  try {
    await act(async () => overlayRoot.render(React.createElement(overlay.component, overlay.options.inject())));
    await act(async () => root.render(React.createElement(settings.component, { ...settings.options.inject() })));
    assert.match(dom.window.document.body.textContent, /暂无设备连接/);
    assert.doesNotMatch(dom.window.document.body.textContent, /共享语音服务|语音服务 ·|声云 ASR|添加 ASR 服务/);
    assert.equal(dom.window.document.querySelector('.dsh-mouse-services'), null);
    assert.equal(catalogCalls, 0);
    assert.doesNotMatch(await readFile('dist/client.js', 'utf8'), /getUserMedia|bindLongPress|AudioWorklet/);
    connectedDevices = await Promise.all(['0001', '0002'].map(async sn => ({ id: sn, sn, type: 'smart-mouse', name: '智能鼠标', identityConfirmed: true, connection: 'usb', battery: 86, dpiState: 'unknown', ...await deviceStore.get(sn) })));
    await act(async () => { events.push(devicesEvent()); });
    assert.match(dom.window.document.body.textContent, /2 台设备已连接/);
    assert.doesNotMatch(dom.window.document.body.textContent, /共享语音服务|语音服务 ·|声云 ASR|添加 ASR 服务/);
    assert.equal(catalogCalls, 0);
    assert.match(dom.window.document.body.textContent, /长按语音打字，松手自动将文字填充到 AI 对话输入框/);
    assert.equal(dom.window.document.querySelector('[aria-label="AI 键动作"]'), null);
    const autoSendSwitch = () => dom.window.document.querySelector('[aria-label="自动发送"]');
    assert.equal(autoSendSwitch().getAttribute('aria-checked'), 'true');
    assert.match(autoSendSwitch().closest('.dsh-mouse-row').textContent, /AI 键/);
    await act(async () => autoSendSwitch().click());
    assert.equal(autoSendSwitch().getAttribute('aria-checked'), 'false');
    assert.equal((await deviceStore.get('0001')).preferences.aiAutoSend, false);
    assert.equal((await deviceStore.get('0002')).preferences.aiAutoSend, true);
    await act(async () => reportDpi('0001', '800', 0));
    assert.equal(dom.window.document.querySelector('[aria-label="DPI"]').textContent, '800');
    await act(async () => reportDpi('0002', '1200', 1));
    assert.equal(dom.window.document.querySelector('[aria-label="DPI"]').textContent, '800');
    for (const [label, count, excluded] of [
      ['识别语言', 43, languageKey({ language: 'zh_cn', accent: 'hakkanese', rlang: '' })],
      ['翻译源语言', 27, 'mn'], ['翻译目标语言', 28, 'ii'],
      ['M 键动作', 6, 'backHome'],
    ]) {
      await act(async () => dom.window.document.querySelector(`[aria-label="${label}"]`).click());
      const options = [...dom.window.document.querySelectorAll('[role="menuitem"]')];
      assert.equal(options.length, count);
      assert.ok(options.every(item => item.dataset.value !== excluded));
      if (label === '翻译目标语言') assert.ok(options.some(item => item.dataset.value === 'mn'));
      await act(async () => dom.window.document.querySelector(`[aria-label="${label}"]`).click());
    }
    const setField = async (label, value) => {
      await act(async () => dom.window.document.querySelector(`[aria-label="${label}"]`).click());
      const option = [...dom.window.document.querySelectorAll('[role="menuitem"]')].find(item => item.dataset.value === value);
      assert.ok(option && !option.disabled);
      await act(async () => option.click());
    };
    await setField('M 键动作', 'openWebUrl');
    await act(async () => linkInputProps.onChange({ target: { value: 'https://' } }));
    assert.equal(dom.window.document.querySelector('[role="alert"]'), null);
    assert.doesNotMatch(dom.window.document.querySelector('.dsh-mouse-key-group').textContent, /链接地址|地址尚未保存/);
    const blurLink = () => dom.window.document.querySelector('[aria-label="一键链接 URL"]').dispatchEvent(new dom.window.FocusEvent('focusout', { bubbles: true }));
    await act(async () => blurLink());
    assert.equal(dom.window.document.querySelector('[data-test-toast]'), null);
    const confirmLink = () => [...dom.window.document.querySelectorAll('.dsh-mouse-link-controls button')].find(button => button.textContent === '确认').click();
    await act(async () => confirmLink());
    assert.match(dom.window.document.querySelector('[data-test-toast]').textContent, /设置未生效/);
    assert.equal(dom.window.document.querySelector('.dsh-mouse-form [role="alert"]'), null);
    assert.equal((await deviceStore.get('0001')).preferences.mAction, 'enter');
    await act(async () => dom.window.document.querySelector('[data-test-toast] button').click());
    await act(async () => linkInputProps.onChange({ target: { value: 'www.google.com' } }));
    await act(async () => { events.push(devicesEvent()); });
    assert.equal(dom.window.document.querySelector('[aria-label="一键链接 URL"]').value, 'www.google.com');
    await act(async () => reportDpi('0001', '2400', 3));
    assert.equal(dom.window.document.querySelector('[aria-label="DPI"]').textContent, '2400');
    assert.equal(dom.window.document.querySelector('[aria-label="一键链接 URL"]').value, 'www.google.com');
    assert.equal((await deviceStore.get('0001')).preferences.linkUrl, '');
    await act(async () => blurLink());
    assert.equal((await deviceStore.get('0001')).preferences.linkUrl, '');
    assert.equal(dom.window.document.querySelector('[data-test-toast]'), null);
    await act(async () => confirmLink());
    assert.equal((await deviceStore.get('0001')).preferences.linkUrl, 'www.google.com', dom.window.document.querySelector('[role="alert"]')?.textContent);
    assert.equal((await deviceStore.get('0001')).preferences.mAction, 'openWebUrl');
    assert.match(dom.window.document.querySelector('[data-test-toast]').textContent, /链接设置成功，已生效/);
    assert.equal(settings.options.inject().controller.snapshot().toast.kind, 'success');
    assert.equal(dom.window.document.querySelector('.dsh-mouse-form [role="alert"]'), null);
    await act(async () => dom.window.document.querySelector('[data-test-toast] button').click());
    await setField('M 键动作', 'speechSearch');
    await setField('搜索引擎', 'https://www.bing.com/search?q=');
    assert.doesNotMatch(dom.window.document.body.textContent, /保存设备设置|重新加载/);
    assert.equal((await deviceStore.get('0001')).preferences.mAction, 'speechSearch');
    assert.equal((await deviceStore.get('0002')).preferences.mAction, 'enter');
    await act(async () => dom.window.document.querySelector('[aria-label="下一台设备"]').click());
    assert.equal(dom.window.document.querySelector('[aria-label="DPI"]').textContent, '1200');
    assert.equal(autoSendSwitch().getAttribute('aria-checked'), 'true');
    assert.equal(dom.window.document.querySelector('[aria-label="M 键动作"]').textContent, '回车');
    assert.match(dom.window.document.body.textContent, /0002/);
    await act(async () => dom.window.document.querySelector('[aria-label="上一台设备"]').click());
    assert.equal(autoSendSwitch().getAttribute('aria-checked'), 'false');
    assert.equal(dom.window.document.querySelector('[aria-label="搜索引擎"]').textContent, 'bing');

    await act(async () => dom.window.document.querySelector('[aria-label="标点符号"]').click());
    assert.equal((await deviceStore.get('0001')).preferences.punctuation, false);
    await act(async () => dom.window.document.querySelector('.dsh-mouse-reset').click());
    assert.equal(autoSendSwitch().getAttribute('aria-checked'), 'true');
    assert.deepEqual((await deviceStore.get('0001')).preferences, defaultPreferences());
    assert.deepEqual((await deviceStore.get('0002')).preferences, { ...defaultPreferences(), dpi: '1200' });

    connectedDevices = [{ ...connectedDevices[0], id: '0003', sn: '0003', revision: 0, preferences: {
      ...defaultPreferences(), recognition: { language: 'zh_cn', accent: 'hakkanese', rlang: '' }, from: 'mn', to: 'ii', punctuation: false,
    } }];
    await act(async () => { events.push(devicesEvent()); });
    assert.match(dom.window.document.body.textContent, /原语言选项已不再支持/);
    assert.equal(dom.window.document.querySelector('[aria-label="识别语言"]').textContent, '请重新选择');
    await setField('识别语言', languageKey(defaultPreferences().recognition));
    await setField('翻译源语言', 'cn');
    await setField('翻译目标语言', 'en');
    assert.doesNotMatch(dom.window.document.body.textContent, /原语言选项已不再支持/);
    assert.deepEqual((await deviceStore.get('0003')).preferences, { ...defaultPreferences(), punctuation: false });
    const controller = settings.options.inject().controller;
    await act(async () => controller.event({ type: 'notice', message: '认证失败，请稍后重试' }));
    assert.equal(dom.window.document.querySelectorAll('[data-test-toast]').length, 1);
    assert.match(dom.window.document.querySelector('[data-test-toast]').textContent, /认证失败/);
    await act(async () => dom.window.document.querySelector('[data-test-toast] button').click());
    assert.equal(dom.window.document.querySelector('[data-test-toast]'), null);

  } finally {
    events.end(); await act(async () => { root.unmount(); overlayRoot.unmount(); }); await dispose();
    assert.equal(remoteDisposed, true); assert.equal(dom.window.document.querySelector('[data-dsh-asr]'), null);
    dom.window.close(); globalThis.window = original.window; globalThis.document = original.document; globalThis.IS_REACT_ACT_ENVIRONMENT = original.act;
  }
});
