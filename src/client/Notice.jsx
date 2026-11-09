import React, { useSyncExternalStore } from 'react';
import { Toast, IconWarningOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives';

export function Notice({ controller }) {
  const { toast } = useSyncExternalStore(controller.subscribe, controller.snapshot);
  return toast ? <Toast key={toast.id} text={toast.message} icon={<IconWarningOutlineRegular />}
    onDone={() => controller.dismissToast(toast.id)} /> : null;
}
