import { useLayoutEffect } from 'react';

export function AiConversationTarget({ view, useSession, inputActions }) {
  const sessionId = useSession(session => session.sessionId);
  useLayoutEffect(() => view.mount(sessionId, inputActions), [view, sessionId, inputActions]);
  return null;
}
