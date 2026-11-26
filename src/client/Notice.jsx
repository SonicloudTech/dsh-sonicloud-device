import { useLocale } from './use-locale.jsx';
import React, { useSyncExternalStore } from 'react';
import { Toast, IconWarningOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives';

export function Notice({ controller }) {
  const locale = useLocale(controller.locale);
  const { toast } = useSyncExternalStore(controller.subscribe, controller.snapshot);
  return toast ? <Toast key={toast.id} text={locale.text(toast.message)} icon={toast.kind === 'success' ? undefined : <IconWarningOutlineRegular />}
    onDone={() => controller.dismissToast(toast.id)} /> : null;
}
