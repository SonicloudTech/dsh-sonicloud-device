import React from 'react';
import { closeTopModal } from '@deepseek-ai/dsh-client-ui-primitives';
import { REMOTE } from '../shared/remote.mjs';
import { DeviceController } from './controller.mjs';
import { AiConversationClient } from './ai-conversation.mjs';
import { AiConversationView } from './ai-conversation-view.mjs';
import { AiConversationTarget } from './AiConversationTarget.jsx';
import { Devices } from './Devices.jsx';
import { Notice } from './Notice.jsx';
import { SonicloudIcon } from './SonicloudIcon.jsx';
import css from './styles.css';
export const inject = ['remote', 'slots'];
export async function apply(ctx) {
  const unmountRemote = await ctx.remote.$mount(REMOTE);
  const view = new AiConversationView({ document, closeTopModal });
  let ui, aiUi;
  try {
    ui = ctx.inject(['remote.asr', 'slots'], scope => {
      const api = scope.remote.asr;
      const controller = new DeviceController(api);
      scope.effect(() => {
        const style = document.createElement('style'); style.textContent = css;
        style.dataset.dshAsr = ''; document.head.append(style);
        void controller.connect();
        return () => { controller.dispose(); style.remove(); };
      });
      scope.slots.inject('settings.section', () => scope.slots.register({
        name: 'settings.section', id: 'dsh-sonicloud-device', order: 11, label: () => '声云设备', inject: () => ({ api, controller }),
      }, Devices));
      scope.slots.inject('settings.section.icon', () => scope.slots.register({
        name: 'settings.section.icon', id: 'dsh-sonicloud-device',
      }, SonicloudIcon));
      scope.slots.inject('shell.overlay', () => scope.slots.register({
        name: 'shell.overlay', id: 'dsh-sonicloud-device-notice', inject: () => ({ controller }),
      }, Notice));
      scope.slots.inject('conversation.input.overlay', () => scope.slots.register({
        name: 'conversation.input.overlay', id: 'dsh-sonicloud-device-ai-target', inject: () => ({ view }),
      }, AiConversationTarget));
    });
    await ui;
    aiUi = ctx.inject(['remote.asr', 'sessions', 'layout', 'conversation', 'uiWorkspace', 'workspaces'], scope => {
      const ai = new AiConversationClient(scope.remote.asr, scope, { view });
      scope.effect(() => { void ai.connect(); return () => ai.dispose(); });
    });
    await aiUi;
  } catch (error) { await aiUi?.dispose(); await ui?.dispose(); await unmountRemote(); throw error; }
  return async () => { await aiUi.dispose(); await ui.dispose(); await unmountRemote(); };
}
