// 侧边栏“声云设备”面板：sidebar.panellist 导航行 + main 同 id 全局面板。
// 注册归子作用域所有，随显隐偏好挂载/卸载；卸载时若面板正被选中，宿主布局自动回退对话页。
export const SIDEBAR_PANEL_ID = 'dsh-sonicloud-device-panel';
export const SIDEBAR_PREFERENCE_KEY = 'sonicloud.sidebar-panel';

export function readSidebarPanelPreference(storage) {
  try { return storage?.getItem(SIDEBAR_PREFERENCE_KEY) !== 'false'; } catch { return true; }
}

// 显隐偏好：本机 localStorage 持久化，默认显示；存储不可用时退化为内存态。
export class SidebarPanelPreference {
  constructor(storage) {
    this.storage = storage ?? null;
    this.visible = readSidebarPanelPreference(storage);
    this.state = { sidebarVisible: this.visible }; // snapshot 稳定引用，供 useSyncExternalStore 使用
    this.listeners = new Set();
  }
  subscribe = listener => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  snapshot = () => this.state;
  setVisible(visible) {
    const next = !!visible;
    if (next === this.visible) return;
    this.visible = next;
    this.state = { sidebarVisible: next };
    try { this.storage?.setItem(SIDEBAR_PREFERENCE_KEY, String(next)); } catch { /* 存储失败仅内存生效 */ }
    for (const listener of this.listeners) listener();
  }
}

// 在独立子作用域注册两个座位，返回可卸载的作用域；icon/panel 组件由调用方传入。
export function mountSidebarPanel(ctx, { icon, panel, props }) {
  return ctx.inject(['slots'], scope => {
    scope.slots.inject('sidebar.panellist', () => scope.slots.register({
      name: 'sidebar.panellist', id: SIDEBAR_PANEL_ID, order: 20, label: () => '声云设备',
    }, icon));
    scope.slots.inject('main', () => scope.slots.register({
      name: 'main', key: SIDEBAR_PANEL_ID, inject: () => props(),
    }, panel));
  });
}

// 按偏好挂载/卸载面板注册，返回清理函数。
export function attachSidebarPanel(ctx, { icon, panel, props, preferences }) {
  let mounted = null;
  const unmount = () => { const scope = mounted; mounted = null; void scope?.dispose(); };
  const sync = () => {
    if (preferences.visible === (mounted !== null)) return;
    if (preferences.visible) mounted = mountSidebarPanel(ctx, { icon, panel, props });
    else unmount();
  };
  sync();
  const unsubscribe = preferences.subscribe(sync);
  return () => { unsubscribe(); unmount(); };
}
