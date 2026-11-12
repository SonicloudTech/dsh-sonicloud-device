import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SIDEBAR_PANEL_ID, SIDEBAR_PREFERENCE_KEY, SidebarPanelPreference,
  attachSidebarPanel, readSidebarPanelPreference,
} from '../src/client/sidebar-panel.mjs';

function memoryStorage(initial = new Map()) {
  return {
    getItem: key => (initial.has(key) ? initial.get(key) : null),
    setItem: (key, value) => { initial.set(key, String(value)); },
  };
}

// 模拟 cordis 上下文：子作用域注销时移除其中注册的插槽项。
function fakeContext() {
  const registrations = new Map();
  const record = (options, component) => {
    const key = options.name + (options.key !== undefined ? ':' + options.key : '');
    registrations.set(key, { options, component });
    return () => registrations.delete(key);
  };
  const scope = {
    slots: { inject: (name, factory) => factory(), register: record },
    inject: (services, callback) => {
      const teardowns = [];
      callback({
        slots: { inject: (name, factory) => { teardowns.push(factory()); }, register: record },
      });
      return { dispose: () => { for (const teardown of teardowns.splice(0).reverse()) teardown?.(); } };
    },
  };
  return { registrations, scope };
}

const PANEL = () => null;
const ICON = () => null;

test('sidebar panel preference defaults to visible and persists toggles', () => {
  const storage = memoryStorage();
  const preference = new SidebarPanelPreference(storage);
  assert.equal(preference.visible, true);
  let notifications = 0;
  const unsubscribe = preference.subscribe(() => { notifications++; });
  preference.setVisible(false);
  assert.equal(preference.visible, false);
  assert.equal(storage.getItem(SIDEBAR_PREFERENCE_KEY), 'false');
  assert.equal(notifications, 1);
  preference.setVisible(false); // 重复设置不通知
  assert.equal(notifications, 1);
  preference.setVisible(true);
  assert.equal(storage.getItem(SIDEBAR_PREFERENCE_KEY), 'true');
  assert.equal(notifications, 2);
  unsubscribe();
  preference.setVisible(false); // 退订只停通知，持久化仍然生效
  assert.equal(notifications, 2);
  assert.equal(new SidebarPanelPreference(memoryStorage(new Map([[SIDEBAR_PREFERENCE_KEY, 'false']]))).visible, false);
  assert.equal(readSidebarPanelPreference(storage), false);
});

test('sidebar panel preference survives unavailable storage', () => {
  assert.equal(new SidebarPanelPreference().visible, true);
  assert.equal(readSidebarPanelPreference({ getItem: () => { throw new Error('denied'); } }), true);
  const failing = { getItem: () => null, setItem: () => { throw new Error('denied'); } };
  const preference = new SidebarPanelPreference(failing);
  preference.setVisible(false);
  assert.equal(preference.visible, false); // 内存态仍然生效
  assert.equal(new SidebarPanelPreference(failing).visible, true); // 未持久化，下次启动回到默认
});

test('attachSidebarPanel mounts the panellist row and main panel, then follows visibility', () => {
  const { registrations, scope } = fakeContext();
  const preferences = new SidebarPanelPreference(memoryStorage());
  const detach = attachSidebarPanel(scope, { icon: ICON, panel: PANEL, props: () => ({ token: 1 }), preferences });
  const row = registrations.get('sidebar.panellist');
  const main = registrations.get('main:' + SIDEBAR_PANEL_ID);
  assert.equal(row.options.id, SIDEBAR_PANEL_ID);
  assert.equal(row.options.order, 20);
  assert.equal(row.options.label(), '声云设备');
  assert.equal(row.component, ICON);
  assert.equal(main.options.key, SIDEBAR_PANEL_ID);
  assert.equal(main.component, PANEL);
  assert.deepEqual(main.options.inject(), { token: 1 });

  preferences.setVisible(false);
  assert.equal(registrations.get('sidebar.panellist'), undefined);
  assert.equal(registrations.get('main:' + SIDEBAR_PANEL_ID), undefined);

  preferences.setVisible(true);
  assert.equal(registrations.get('sidebar.panellist').options.id, SIDEBAR_PANEL_ID);
  assert.equal(registrations.get('main:' + SIDEBAR_PANEL_ID).options.inject().token, 1);

  detach();
  assert.equal(registrations.get('sidebar.panellist'), undefined);
  assert.equal(registrations.get('main:' + SIDEBAR_PANEL_ID), undefined);
});

test('attachSidebarPanel stays dormant while the preference starts hidden', () => {
  const { registrations, scope } = fakeContext();
  const preferences = new SidebarPanelPreference(memoryStorage(new Map([[SIDEBAR_PREFERENCE_KEY, 'false']])));
  const detach = attachSidebarPanel(scope, { icon: ICON, panel: PANEL, props: () => ({}), preferences });
  assert.equal(registrations.size, 0);
  preferences.setVisible(true);
  assert.equal(registrations.get('sidebar.panellist').options.id, SIDEBAR_PANEL_ID);
  detach();
  assert.equal(registrations.size, 0);
});
