// Plugin-owned global status also works when voice search has no composer mounted.
export function mountStatus(controller, doc = document) {
  const root = doc.createElement('aside'); root.className = 'dsh-mouse-status'; root.setAttribute('aria-label', '智能鼠标语音');
  const row = doc.createElement('div'); row.className = 'dsh-mouse-status-row';
  const dot = doc.createElement('span'); dot.className = 'dsh-asr-mic-dot dsh-asr-pulse';
  const text = doc.createElement('div'); text.className = 'dsh-mouse-status-text'; text.setAttribute('role', 'status');
  const close = doc.createElement('button'); close.type = 'button';
  const warning = doc.createElement('p'); warning.className = 'dsh-asr-muted';
  const copy = doc.createElement('button'); copy.type = 'button'; copy.textContent = '复制结果';
  row.append(dot, text, close); root.append(row, warning, copy); doc.body.append(root);
  close.onclick = () => controller.run ? controller.cancel() : controller.dismiss();
  copy.onclick = async () => {
    try { await doc.defaultView.navigator.clipboard.writeText(controller.snapshot().preview); copy.textContent = '已复制'; }
    catch { copy.textContent = '复制失败，请手动选择文字'; }
  };
  let previous;
  const update = () => {
    const state = controller.snapshot(), active = Boolean(controller.run);
    const anchor = (controller.run?.target ?? controller.target)?.statusAnchor;
    const anchored = Boolean(anchor?.isConnected);
    const container = anchored ? anchor : doc.body;
    if (root.parentNode !== container) container.append(root);
    root.classList.toggle('is-anchored', anchored);
    root.hidden = !(active || state.message); dot.hidden = !active;
    text.textContent = active && ['connecting', 'recording'].includes(state.phase) ? state.preview : [state.message, state.preview].filter(Boolean).join(' ');
    text.classList.toggle('is-live', active);
    text.scrollLeft = text.scrollWidth;
    close.textContent = active ? '取消' : '关闭';
    warning.textContent = state.warning; warning.hidden = !state.warning;
    copy.hidden = active || !state.preview;
    if (previous !== state.preview) copy.textContent = '复制结果';
    previous = state.preview;
  };
  const unsubscribe = controller.subscribe(update); update();
  const cancel = () => { if (controller.run) controller.cancel(); };
  const key = event => { if (event.key === 'Escape' && controller.run) { event.preventDefault(); cancel(); } };
  const visibility = () => { if (doc.hidden) cancel(); };
  doc.defaultView.addEventListener('blur', cancel); doc.defaultView.addEventListener('keydown', key, true); doc.addEventListener('visibilitychange', visibility);
  return () => { unsubscribe(); root.remove(); doc.defaultView.removeEventListener('blur', cancel); doc.defaultView.removeEventListener('keydown', key, true); doc.removeEventListener('visibilitychange', visibility); };
}
