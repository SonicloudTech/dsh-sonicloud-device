import React, { useRef, useState, useSyncExternalStore } from 'react';
import { Button, Menu, Switch, Input, IconChevronDownOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives';
import { REC_LANG_LIST, TRANS_FROM_LANG_LIST, TRANS_TO_LANG_LIST, DPI_LIST, M_KEY_FUNC_LIST, M_KEY_SEARCH_URL_LIST, languageKey, sourceRecognitionLanguage } from '../shared/devices.mjs';

// General Settings keeps its row component private; mirror its layout using host tokens.
function Row({ label, description, children }) {
  return <div className="dsh-mouse-row"><div className="dsh-mouse-label"><span>{label}</span>{description && <p>{description}</p>}</div><div className="dsh-mouse-controls">{children}</div></div>;
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
  const { form, busy, error } = useSyncExternalStore(editor.subscribe, editor.snapshot);
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
      <Row label="DPI 键" description={device.dpiState === 'failed' ? 'DPI 尚未应用，请重新选择后重试' : undefined}><Select label="DPI" value={form.dpi} options={DPI_LIST} onChange={value => change('dpi', value)} /></Row>
      <Row label="M 键"><Select label="M 键动作" value={form.mAction} options={M_KEY_FUNC_LIST} onChange={value => change('mAction', value)} /></Row>
      {form.mAction === 'speechSearch' && <Row label="搜索引擎"><Select label="搜索引擎" value={form.searchUrl} options={M_KEY_SEARCH_URL_LIST} onChange={value => change('searchUrl', value)} /></Row>}
      {form.mAction === 'openWebUrl' && <Row label="链接地址"><Input aria-label="一键链接 URL" type="url" placeholder="https://example.com" value={form.linkUrl} onChange={event => change('linkUrl', event.target.value)} /></Row>}
      <Row label="语音键"><Select label="语音键动作" value={form.speechAction} options={[{ value: 'voice_input', label: '语音打字' }, { value: 'translate', label: '语音翻译' }]} onChange={value => change('speechAction', value)} /></Row>
      <Row label="AI 键"><Select label="AI 键动作" value={form.aiAction} options={[{ value: 'openAi', label: '打开 AI 对话' }]} onChange={value => change('aiAction', value)} /></Row>
    </div>
    {error && <p role="alert" className="dsh-asr-error">{error}</p>}
    <div className="dsh-mouse-footer">
      <span role="status" className="dsh-asr-muted">{busy ? '正在应用…' : ''}</span>
      <Button size="sm" className="dsh-mouse-reset" onClick={() => editor.reset()}>恢复默认</Button>
    </div>
  </div>;
}
export function Devices({ controller }) {
  const state = useSyncExternalStore(controller.subscribe, controller.snapshot);
  const [selected, setSelected] = useState(null);
  const devices = state.devices, device = devices.find(item => item.id === selected) ?? devices[0];
  const index = device ? devices.indexOf(device) : 0;
  const count = new Set(devices.filter(item => item.identityConfirmed).map(item => item.sn)).size;
  return <section className="dsh-mouse-settings" aria-label="声云设备">
    <h2>声云设备</h2><p className="dsh-asr-intro">{count} 台设备已连接 · 为每台设备设置专属偏好</p>
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
  </section>;
}
