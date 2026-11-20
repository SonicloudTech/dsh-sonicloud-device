import React, { useRef, useState, useSyncExternalStore } from 'react';
import { Button, Menu, Switch, Input, IconChevronDownOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives';
import { REC_LANG_LIST, TRANS_FROM_LANG_LIST, TRANS_TO_LANG_LIST, DPI_LIST, M_KEY_FUNC_LIST, M_KEY_SEARCH_URL_LIST, languageKey, sourceRecognitionLanguage } from '../shared/devices.mjs';

// General Settings keeps its row component private; mirror its layout using host tokens.
function Row({ label, description, children }) {
  return <div className="dsh-mouse-row"><div className="dsh-mouse-label"><span>{label}</span>{description && <p>{description}</p>}</div>{children && <div className="dsh-mouse-controls">{children}</div>}</div>;
}
function Select({ label, value, onChange, options }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef(null);
  return <Menu open={open} portal align="end" autoFocus minWidthFromAnchor selectedId={value}
    items={options.map(item => ({ id: item.value, label: item.label, disabled: item.disabled }))}
    onClose={() => setOpen(false)} onSelect={value => { trigger.current?.focus({ preventScroll: true }); setOpen(false); onChange(value); }}
    anchor={<Button ref={trigger} className="dsh-mouse-select" aria-label={label} aria-haspopup="menu" aria-expanded={open}
      onClick={() => setOpen(!open)} onKeyDown={event => {
        if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); setOpen(true); }
      }}><span>{options.find(item => item.value === value)?.label ?? '请重新选择'}</span><IconChevronDownOutlineRegular size={12} /></Button>} />;
}
function DeviceForm({ device, controller, state }) {
  const editor = controller.preferences(device);
  const { form, busy, error, invalid } = useSyncExternalStore(editor.subscribe, editor.snapshot);
  const change = (key, value) => editor.change(key, value);
  if (!device.identityConfirmed || !form) return <p role="status">设备身份未确认，暂不可编辑配置，请重连设备。</p>;
  const languages = REC_LANG_LIST.map(item => ({ value: languageKey(item), label: item.label + (state.recognitionLanguages.includes(languageKey(item)) ? '' : '（待适配）'), disabled: !state.recognitionLanguages.includes(languageKey(item)) }));
  const sourceOptions = TRANS_FROM_LANG_LIST.map(item => {
    const recognition = sourceRecognitionLanguage(item.value);
    const supported = recognition && state.recognitionLanguages.includes(languageKey(recognition));
    return { ...item, label: item.label + (supported ? '' : '（识别待适配）'), disabled: !supported };
  });
  const removedLanguage = !languages.some(item => item.value === languageKey(form.recognition))
    || !sourceOptions.some(item => item.value === form.from) || !TRANS_TO_LANG_LIST.some(item => item.value === form.to);
  return <div className="dsh-mouse-form" aria-busy={busy}>
    {removedLanguage && <p role="alert" className="dsh-asr-error">原语言选项已不再支持，请重新选择语音打字或翻译语言。</p>}
    <div>
      <Row label="语音打字">
        <span className="dsh-mouse-switch"><span>标点符号</span><Switch label="标点符号" checked={form.punctuation} onChange={value => change('punctuation', value)} /></span>
        <Select label="识别语言" value={languageKey(form.recognition)} options={languages} onChange={value => {
          const item = REC_LANG_LIST.find(item => languageKey(item) === value);
          change('recognition', { language: item.language, accent: item.accent, rlang: item.rlang });
        }} />
      </Row>
      <Row label="语音翻译" description={!state.translationReady ? '翻译服务尚未配置，暂不可用' : undefined}><Select label="翻译源语言" value={form.from} options={sourceOptions} onChange={value => change('from', value)} /><span aria-hidden="true">›</span><Select label="翻译目标语言" value={form.to} options={TRANS_TO_LANG_LIST} onChange={value => change('to', value)} /></Row>
      <Row label="DPI 键" description={<>用于调节鼠标光标移动灵敏度{device.dpiState === 'failed' && <><br /><span className="dsh-asr-error">DPI 尚未应用，请重新选择后重试</span></>}</>}><Select label="DPI" value={form.dpi} options={DPI_LIST} onChange={value => change('dpi', value)} /></Row>
      <div className="dsh-mouse-key-group">
        <Row label="M 键" description="鼠标多功能键"><Select label="M 键动作" value={form.mAction} options={M_KEY_FUNC_LIST} onChange={value => change('mAction', value)} /></Row>
        {form.mAction === 'speechSearch' && <div className="dsh-mouse-subrow"><div className="dsh-mouse-controls"><Select label="搜索引擎" value={form.searchUrl} options={M_KEY_SEARCH_URL_LIST} onChange={value => change('searchUrl', value)} /></div></div>}
        {form.mAction === 'openWebUrl' && <div className="dsh-mouse-subrow"><div className="dsh-mouse-controls dsh-mouse-link-controls">
          <Input aria-label="一键链接 URL" type="url" placeholder="https://example.com" value={form.linkUrl} aria-invalid={invalid || undefined} onChange={event => change('linkUrl', event.target.value)} />
          <Button disabled={busy} onClick={() => editor.commitLink()}>确认</Button>
        </div></div>}
      </div>
      <Row label="语音键" description="长按语音打字或翻译，松手将文字填充到已获取焦点的输入框"><Select label="语音键动作" value={form.speechAction} options={[{ value: 'voice_input', label: '语音打字' }, { value: 'translate', label: '语音翻译' }]} onChange={value => change('speechAction', value)} /></Row>
      <Row label="AI 键" description="长按语音打字，松手自动将文字填充到 AI 对话输入框">
        <span className="dsh-mouse-switch"><span>自动发送</span><Switch label="自动发送" checked={form.aiAutoSend} onChange={value => change('aiAutoSend', value)} /></span>
      </Row>
    </div>
    {error && form.mAction !== 'openWebUrl' && <p role="alert" className="dsh-asr-error">{error}</p>}
    <div className="dsh-mouse-footer">
      <span role="status" className="dsh-asr-muted">{busy ? '正在应用…' : ''}</span>
      <Button size="sm" className="dsh-mouse-reset" onClick={() => editor.reset()}>恢复默认</Button>
    </div>
  </div>;
}
// 未传显隐偏好时使用的稳定兜底，避免条件调用 Hook。
const NO_SIDEBAR = { sidebarVisible: true };
const subscribeNone = () => () => {};

export function Devices({ controller, sidebar }) {
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot);
  const { sidebarVisible } = useSyncExternalStore(sidebar?.subscribe ?? subscribeNone, sidebar?.snapshot ?? (() => NO_SIDEBAR));
  const [selected, setSelected] = useState(null);
  const devices = state.devices, device = devices.find(item => item.id === selected) ?? devices[0];
  const index = device ? devices.indexOf(device) : 0;
  const count = new Set(devices.filter(item => item.identityConfirmed).map(item => item.sn)).size;
  const permissions = state.screenshotPermissions;
  const screenMissing = permissions?.supported && !permissions.screenRecording;
  const permissionBusy = state.screenshotPermissionBusy;
  const typingPermissions = state.typingPermissions;
  return <section className="dsh-mouse-settings" aria-label="声云设备">
    <header className="dsh-mouse-head">
      <h2>声云设备</h2>
      {sidebar && <span className="dsh-mouse-switch"><span>侧边栏</span><Switch label="侧边栏" checked={sidebarVisible} onChange={value => sidebar.setVisible(value)} /></span>}
    </header>
    <p className="dsh-asr-intro">{count} 台设备已连接 · 为每台设备设置专属偏好</p>
    {!device ? <div className="dsh-mouse-empty"><span aria-hidden="true">⌁</span><h3>暂无设备连接</h3><p>请连接智能鼠标的 USB 接收器，或通过蓝牙连接鼠标。</p><p className="dsh-asr-muted">{state.status}</p></div> : <>
      <div className="dsh-mouse-carousel">
        {devices.length > 1 && <button type="button" aria-label="上一台设备" onClick={() => setSelected(devices[(index + devices.length - 1) % devices.length].id)}>‹</button>}
        <div className="dsh-mouse-product"><div className="dsh-mouse-illustration" role="img" aria-label="智能鼠标示意图"><span className="dsh-mouse-wheel" /><span className="dsh-mouse-ai">AI</span></div><h3>{device.name}</h3></div>
        {devices.length > 1 && <button type="button" aria-label="下一台设备" onClick={() => setSelected(devices[(index + 1) % devices.length].id)}>›</button>}
      </div>
      {devices.length > 1 && <div className="dsh-mouse-dots">{devices.map((item, i) => <button type="button" key={item.id} aria-label={`切换到设备 ${i + 1}`} aria-current={item.id === device.id ? 'true' : undefined} onClick={() => setSelected(item.id)} />)}</div>}
      <Row label="SN"><span className="dsh-mouse-value">{device.sn || '设备身份未确认'}</span></Row>
      <Row label="连接方式"><span className="dsh-mouse-value">{device.connection === 'usb' ? 'USB 接收器' : '蓝牙'}</span></Row>
      <Row label="设备电量"><span className="dsh-mouse-value">{device.battery === null ? '未知' : `${device.battery}%`}</span></Row>
      {device.type === 'smart-mouse' ? <DeviceForm key={device.id} device={device} controller={controller} state={state} /> : <p>此设备类型暂未提供专属设置。</p>}
    </>}
    {typingPermissions?.supported && <div aria-label="打字上屏权限" aria-busy={state.typingPermissionBusy}>
      <p><strong>Sonicloud Voice</strong> 辅助功能：{typingPermissions.accessibility ? '已授权' : '待授权'}</p>
      {!typingPermissions.accessibility && <p>将识别文字自动填入桌面应用需要此权限；未授权时仍可识别并复制文字。</p>}
      <div className="dsh-mouse-controls">
        {!typingPermissions.accessibility && <Button aria-label="授权打字辅助功能" disabled={state.typingPermissionBusy} onClick={() => controller.refreshTypingPermissions('accessibility')}>授权打字辅助功能</Button>}
        <Button aria-label="重新检查打字权限" disabled={state.typingPermissionBusy} onClick={() => controller.refreshTypingPermissions('refresh')}>{state.typingPermissionBusy ? '正在检查…' : '已授权，重新检查'}</Button>
      </div>
      {state.typingPermissionMessage && <p role="status">{state.typingPermissionMessage}</p>}
      {!typingPermissions.accessibility && typingPermissions.helperApp && <details>
        <summary>找不到 Sonicloud Voice 时查看组件位置</summary>
        <p>在辅助功能权限列表中需要手动添加时，使用下方位置：</p>
        <code style={{ overflowWrap: 'anywhere' }}>{typingPermissions.helperApp}</code>
      </details>}
    </div>}
    {state.typingPermissionError && <div role="alert">
      <p>{state.typingPermissionError}</p>
      <Button aria-label="重新检查打字权限" disabled={state.typingPermissionBusy} onClick={() => controller.refreshTypingPermissions('refresh')}>{state.typingPermissionBusy ? '正在检查…' : '重新检查打字权限'}</Button>
    </div>}
    <Row label="截图" description={screenMissing ? '首次截图前请先授权屏幕录制，授权期间不会显示截图蒙层' : '点击按钮或按鼠标截图键，框选后可标注、复制、保存或贴图'}>
      <Button aria-label="开始截图" disabled={state.screenshotBusy || screenMissing || Boolean(state.screenshotPermissionError) || (permissionBusy && !permissions)} onClick={() => controller.captureScreenshot()}>{state.screenshotBusy ? '正在启动…' : '开始截图'}</Button>
    </Row>
    {permissions?.supported && <div aria-label="截图权限" aria-busy={permissionBusy}>
      <p>{permissions.screenRecording && permissions.accessibility ? <>截图组件 <strong>screenhelper</strong> 权限已就绪。</> : <>请为截图组件 <strong>screenhelper</strong> 授权。</>}</p>
      <p role="status">屏幕录制：{permissions.screenRecording ? '已授权' : '待授权'}（截图必需）<br />辅助功能：{permissions.accessibility ? '已授权' : '待授权'}（自动滚动可选，普通截图和手动滚动不受影响）</p>
      <div className="dsh-mouse-controls">
        {!permissions.screenRecording && <Button aria-label="授权屏幕录制" disabled={permissionBusy} onClick={() => controller.refreshScreenshotPermissions('screen')}>授权屏幕录制</Button>}
        {!permissions.accessibility && <Button aria-label="授权辅助功能" disabled={permissionBusy} onClick={() => controller.refreshScreenshotPermissions('accessibility')}>授权辅助功能</Button>}
        <Button aria-label="重新检查截图权限" disabled={permissionBusy} onClick={() => controller.refreshScreenshotPermissions('refresh')}>{permissionBusy ? '正在检查…' : '已授权，重新检查'}</Button>
      </div>
      {state.screenshotPermissionMessage && <p role="status">{state.screenshotPermissionMessage}</p>}
      {(!permissions.screenRecording || !permissions.accessibility) && permissions.helperApp && <details>
        <summary>找不到 screenhelper 时查看组件位置</summary>
        <p>在系统权限列表中需要手动添加时，使用下方位置：</p>
        <code style={{ overflowWrap: 'anywhere' }}>{permissions.helperApp}</code>
      </details>}
    </div>}
    {state.screenshotPermissionError && <div role="alert">
      <p>{state.screenshotPermissionError}</p>
      <Button aria-label="重新检查截图权限" disabled={permissionBusy} onClick={() => controller.refreshScreenshotPermissions('refresh')}>{permissionBusy ? '正在检查…' : '重新检查截图权限'}</Button>
    </div>}
  </section>;
}

// main 全局面板包装：约束内容宽度并预留窗口顶部安全距离，对齐宿主入口页规范。
export function DevicesPanel(props) {
  return <div className="dsh-mouse-panel"><Devices {...props} /></div>;
}
