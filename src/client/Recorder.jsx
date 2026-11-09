import React, { useEffect, useRef } from 'react';
// Registers only insertion actions; no pointer handlers or computer microphone access.
export function Recorder({ controller, sessionId, inputActions }) {
  const anchor = useRef(null);
  useEffect(() => {
    if (!sessionId || !inputActions) return;
    const target = {
      statusAnchor: anchor.current,
      capture: () => inputActions.captureInsertion(),
      insert: (text, span) => inputActions.insertText(text, span),
      valid: () => Boolean(anchor.current?.isConnected && anchor.current.closest('[data-composer-card]')?.querySelector('[data-composer-input][contenteditable="true"]')),
    };
    const unbind = controller.bindTarget(target);
    const card = anchor.current?.closest('[data-composer-card]');
    const observer = new MutationObserver(() => { if (controller.run?.target === target && !target.valid()) controller.cancel(); });
    if (card) observer.observe(card, { subtree: true, childList: true, attributes: true, attributeFilter: ['contenteditable'] });
    return () => { observer.disconnect(); unbind(); };
  }, [sessionId, inputActions, controller]);
  return <div ref={anchor} className="dsh-asr-anchor" />;
}
