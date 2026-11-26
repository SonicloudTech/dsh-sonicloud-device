import { LocaleContext, useLocale } from './use-locale.jsx';
import { fallbackLocale } from './locale.mjs';
import { languageLabel, actionOptions } from './locale-options.mjs';
import React, { useRef, useState, useSyncExternalStore } from 'react';
import { Button, Menu, Switch, Input, IconChevronDownOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives';
import { REC_LANG_LIST, TRANS_FROM_LANG_LIST, TRANS_TO_LANG_LIST, DPI_LIST, M_KEY_FUNC_LIST, M_KEY_SEARCH_URL_LIST, languageKey, sourceRecognitionLanguage } from '../shared/devices.mjs';

// General Settings keeps its row component private; mirror its layout using host tokens.
function Row({ label, description, children }) {
  return <div className="dsh-mouse-row"><div className="dsh-mouse-label"><span>{label}</span>{description && <p>{description}</p>}</div>{children && <div className="dsh-mouse-controls">{children}</div>}</div>;
}
function Select({ label, value, onChange, options }) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const trigger = useRef(null);
  return <Menu open={open} portal align="end" autoFocus minWidthFromAnchor selectedId={value}
    items={options.map(item => ({ id: item.value, label: item.label, disabled: item.disabled }))}
    onClose={() => setOpen(false)} onSelect={value => { trigger.current?.focus({ preventScroll: true }); setOpen(false); onChange(value); }}
    anchor={<Button ref={trigger} className="dsh-mouse-select" aria-label={label} aria-haspopup="menu" aria-expanded={open}
      onClick={() => setOpen(!open)} onKeyDown={event => {
        if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); setOpen(true); }
      }}><span>{options.find(item => item.value === value)?.label ?? t('common.choose')}</span><IconChevronDownOutlineRegular size={12} /></Button>} />;
}
function DeviceForm({ device, controller, state }) {
  const locale = useLocale();
  const { t, text } = locale;
  const editor = controller.preferences(device);
  const { form, busy, error, invalid } = useSyncExternalStore(editor.subscribe, editor.snapshot);
  const change = (key, value) => editor.change(key, value);
  if (!device.identityConfirmed || !form) return <p role="status">{t('device.identityHelp')}</p>;
  const languages = REC_LANG_LIST.map(item => ({ value: languageKey(item), label: state.recognitionLanguages.includes(languageKey(item)) ? languageLabel(item, locale) : t('voice.pending', { name: languageLabel(item, locale) }), disabled: !state.recognitionLanguages.includes(languageKey(item)) }));
  const sourceOptions = TRANS_FROM_LANG_LIST.map(item => {
    const recognition = sourceRecognitionLanguage(item.value);
    const supported = recognition && state.recognitionLanguages.includes(languageKey(recognition));
    return { ...item, label: supported ? languageLabel(item, locale) : t('voice.recognitionPending', { name: languageLabel(item, locale) }), disabled: !supported };
  });
  const removedLanguage = !languages.some(item => item.value === languageKey(form.recognition))
    || !sourceOptions.some(item => item.value === form.from) || !TRANS_TO_LANG_LIST.some(item => item.value === form.to);
  return <div className="dsh-mouse-form" aria-busy={busy}>
    {removedLanguage && <p role="alert" className="dsh-asr-error">{t('voice.unsupported')}</p>}
    <div>
      <Row label={t('voice.input')}>
        <span className="dsh-mouse-switch"><span>{t('voice.punctuation')}</span><Switch label={t('voice.punctuation')} checked={form.punctuation} onChange={value => change('punctuation', value)} /></span>
        <Select label={t('voice.recognition')} value={languageKey(form.recognition)} options={languages} onChange={value => {
          const item = REC_LANG_LIST.find(item => languageKey(item) === value);
          change('recognition', { language: item.language, accent: item.accent, rlang: item.rlang });
        }} />
      </Row>
      <Row label={t('voice.translate')} description={!state.translationReady ? t('voice.unavailable') : undefined}><Select label={t('voice.from')} value={form.from} options={sourceOptions} onChange={value => change('from', value)} /><span aria-hidden="true">›</span><Select label={t('voice.to')} value={form.to} options={TRANS_TO_LANG_LIST.map(item => ({ ...item, label: languageLabel(item, locale) }))} onChange={value => change('to', value)} /></Row>
      <Row label={t('keys.dpi')} description={<>{t('keys.dpiHelp')}{device.dpiState === 'failed' && <><br /><span className="dsh-asr-error">{t('keys.dpiFailed')}</span></>}</>}><Select label="DPI" value={form.dpi} options={DPI_LIST} onChange={value => change('dpi', value)} /></Row>
      <div className="dsh-mouse-key-group">
        <Row label={t('keys.m')} description={t('keys.mHelp')}><Select label={t('keys.mAction')} value={form.mAction} options={actionOptions(M_KEY_FUNC_LIST, t)} onChange={value => change('mAction', value)} /></Row>
        {form.mAction === 'speechSearch' && <div className="dsh-mouse-subrow"><div className="dsh-mouse-controls"><Select label={t('keys.searchEngine')} value={form.searchUrl} options={M_KEY_SEARCH_URL_LIST.map(item => ({ ...item, label: item.value === 'https://www.baidu.com/baidu?wd=' && locale.language !== 'zh' ? 'Baidu' : item.label }))} onChange={value => change('searchUrl', value)} /></div></div>}
        {form.mAction === 'openWebUrl' && <div className="dsh-mouse-subrow"><div className="dsh-mouse-controls dsh-mouse-link-controls">
          <Input aria-label={t('keys.linkUrl')} type="url" placeholder="https://example.com" value={form.linkUrl} aria-invalid={invalid || undefined} onChange={event => change('linkUrl', event.target.value)} />
          <Button disabled={busy} onClick={() => editor.commitLink()}>{t('common.confirm')}</Button>
        </div></div>}
      </div>
      <Row label={t('keys.speech')} description={t('keys.speechHelp')}><Select label={t('keys.speechAction')} value={form.speechAction} options={[{ value: 'voice_input', label: t('voice.input') }, { value: 'translate', label: t('voice.translate') }]} onChange={value => change('speechAction', value)} /></Row>
      <Row label={t('keys.ai')} description={t('keys.aiHelp')}>
        <span className="dsh-mouse-switch"><span>{t('keys.autoSend')}</span><Switch label={t('keys.autoSend')} checked={form.aiAutoSend} onChange={value => change('aiAutoSend', value)} /></span>
      </Row>
    </div>
    {error && form.mAction !== 'openWebUrl' && <p role="alert" className="dsh-asr-error">{text(error)}</p>}
    <div className="dsh-mouse-footer">
      <span role="status" className="dsh-asr-muted">{busy ? t('common.applying') : ''}</span>
      <Button size="sm" className="dsh-mouse-reset" onClick={() => editor.reset()}>{t('common.reset')}</Button>
    </div>
  </div>;
}
// 未传显隐偏好时使用的稳定兜底，避免条件调用 Hook。
const NO_SIDEBAR = { sidebarVisible: true };
const subscribeNone = () => () => {};

export function Devices(props) {
  return <LocaleContext.Provider value={props.controller.locale ?? fallbackLocale}><DevicesContent {...props} /></LocaleContext.Provider>;
}
function DevicesContent({ controller, sidebar }) {
  const locale = useLocale();
  const { t, text } = locale;
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
  return <section className="dsh-mouse-settings" aria-label={t('app.title')}>
    <header className="dsh-mouse-head">
      <h2>{t('app.title')}</h2>
      {sidebar && <span className="dsh-mouse-switch"><span>{t('app.sidebar')}</span><Switch label={t('app.sidebar')} checked={sidebarVisible} onChange={value => sidebar.setVisible(value)} /></span>}
    </header>
    <p className="dsh-asr-intro">{locale.count(count)}</p>
    {!device ? <div className="dsh-mouse-empty"><span aria-hidden="true">⌁</span><h3>{t('device.empty')}</h3><p>{t('device.connect')}</p><p className="dsh-asr-muted">{text(state.status)}</p></div> : <>
      <div className="dsh-mouse-carousel">
        {devices.length > 1 && <button type="button" aria-label={t('device.previous')} onClick={() => setSelected(devices[(index + devices.length - 1) % devices.length].id)}>‹</button>}
        <div className="dsh-mouse-product"><div className="dsh-mouse-illustration" role="img" aria-label={t('device.image')}><span className="dsh-mouse-wheel" /><span className="dsh-mouse-ai">AI</span></div><h3>{device.defaultName ? t(device.type === 'smart-mouse' ? 'device.mouse' : 'device.generic') : device.name}</h3></div>
        {devices.length > 1 && <button type="button" aria-label={t('device.next')} onClick={() => setSelected(devices[(index + 1) % devices.length].id)}>›</button>}
      </div>
      {devices.length > 1 && <div className="dsh-mouse-dots">{devices.map((item, i) => <button type="button" key={item.id} aria-label={t('device.switch', { index: i + 1 })} aria-current={item.id === device.id ? 'true' : undefined} onClick={() => setSelected(item.id)} />)}</div>}
      <Row label="SN"><span className="dsh-mouse-value">{device.sn || t('device.identity')}</span></Row>
      <Row label={t('device.connection')}><span className="dsh-mouse-value">{device.connection === 'usb' ? t('device.usb') : t('device.bluetooth')}</span></Row>
      <Row label={t('device.battery')}><span className="dsh-mouse-value">{device.battery === null ? t('common.unknown') : `${device.battery}%`}</span></Row>
      {device.type === 'smart-mouse' ? <DeviceForm key={device.id} device={device} controller={controller} state={state} /> : <p>{t('device.unsupported')}</p>}
    </>}
    {typingPermissions?.supported && <div aria-label={t('permission.typing')} aria-busy={state.typingPermissionBusy}>
      <p><strong>Sonicloud Voice</strong> {t('permission.accessibility')}：{typingPermissions.accessibility ? t('permission.granted') : t('permission.missing')}</p>
      {!typingPermissions.accessibility && <p>{t('permission.typingHelp')}</p>}
      <div className="dsh-mouse-controls">
        {!typingPermissions.accessibility && <Button aria-label={t('permission.grantTyping')} disabled={state.typingPermissionBusy} onClick={() => controller.refreshTypingPermissions('accessibility')}>{t('permission.grantTyping')}</Button>}
        <Button aria-label={t('permission.checkTyping')} disabled={state.typingPermissionBusy} onClick={() => controller.refreshTypingPermissions('refresh')}>{state.typingPermissionBusy ? t('permission.checking') : t('permission.recheck')}</Button>
      </div>
      {state.typingPermissionMessage && <p role="status">{text(state.typingPermissionMessage)}</p>}
      {!typingPermissions.accessibility && typingPermissions.helperApp && <details>
        <summary>{t('permission.location', { helper: 'Sonicloud Voice' })}</summary>
        <p>{t('permission.pathHelp')}</p>
        <code style={{ overflowWrap: 'anywhere' }}>{typingPermissions.helperApp}</code>
      </details>}
    </div>}
    {state.typingPermissionError && <div role="alert">
      <p>{text(state.typingPermissionError)}</p>
      <Button aria-label={t('permission.checkTyping')} disabled={state.typingPermissionBusy} onClick={() => controller.refreshTypingPermissions('refresh')}>{state.typingPermissionBusy ? t('permission.checking') : t('permission.checkTyping')}</Button>
    </div>}
    <Row label={t('screenshot.title')} description={screenMissing ? t('screenshot.permissionHelp') : t('screenshot.help')}>
      <Button aria-label={t('screenshot.start')} disabled={state.screenshotBusy || screenMissing || Boolean(state.screenshotPermissionError) || (permissionBusy && !permissions)} onClick={() => controller.captureScreenshot()}>{state.screenshotBusy ? t('screenshot.starting') : t('screenshot.start')}</Button>
    </Row>
    {permissions?.supported && <div aria-label={t('permission.screenshot')} aria-busy={permissionBusy}>
      <p>{permissions.screenRecording && permissions.accessibility ? t('permission.ready', { helper: 'screenhelper' }) : t('permission.grantHelp', { helper: 'screenhelper' })}</p>
      <p role="status">{t('permission.screenState', { state: t(permissions.screenRecording ? 'permission.granted' : 'permission.missing') })}<br />{t('permission.accessState', { state: t(permissions.accessibility ? 'permission.granted' : 'permission.missing') })}</p>
      <div className="dsh-mouse-controls">
        {!permissions.screenRecording && <Button aria-label={t('permission.grantScreen')} disabled={permissionBusy} onClick={() => controller.refreshScreenshotPermissions('screen')}>{t('permission.grantScreen')}</Button>}
        {!permissions.accessibility && <Button aria-label={t('permission.grantAccess')} disabled={permissionBusy} onClick={() => controller.refreshScreenshotPermissions('accessibility')}>{t('permission.grantAccess')}</Button>}
        <Button aria-label={t('permission.checkScreenshot')} disabled={permissionBusy} onClick={() => controller.refreshScreenshotPermissions('refresh')}>{permissionBusy ? t('permission.checking') : t('permission.recheck')}</Button>
      </div>
      {state.screenshotPermissionMessage && <p role="status">{text(state.screenshotPermissionMessage)}</p>}
      {(!permissions.screenRecording || !permissions.accessibility) && permissions.helperApp && <details>
        <summary>{t('permission.location', { helper: 'screenhelper' })}</summary>
        <p>{t('permission.pathHelp')}</p>
        <code style={{ overflowWrap: 'anywhere' }}>{permissions.helperApp}</code>
      </details>}
    </div>}
    {state.screenshotPermissionError && <div role="alert">
      <p>{text(state.screenshotPermissionError)}</p>
      <Button aria-label={t('permission.checkScreenshot')} disabled={permissionBusy} onClick={() => controller.refreshScreenshotPermissions('refresh')}>{permissionBusy ? t('permission.checking') : t('permission.checkScreenshot')}</Button>
    </div>}
  </section>;
}

// main 全局面板包装：约束内容宽度并预留窗口顶部安全距离，对齐宿主入口页规范。
export function DevicesPanel(props) {
  return <div className="dsh-mouse-panel"><Devices {...props} /></div>;
}
