import React from 'react';
import { REMOTE } from '../shared/remote.mjs';
import { DeviceController } from './controller.mjs';
import { Devices } from './Devices.jsx';
import { Recorder } from './Recorder.jsx';
import { Notice } from './Notice.jsx';
import { SonicloudIcon } from './SonicloudIcon.jsx';
import { mountStatus } from './status.mjs';
import css from './styles.css';
export const inject = ['remote', 'slots'];
export async function apply(ctx) {
  const unmountRemote = await ctx.remote.$mount(REMOTE);
  let ui;
  try {
    ui = ctx.inject(['remote.asr', 'slots'], scope => {
      const api = scope.remote.asr;
      const controller = new DeviceController(api);
      scope.effect(() => {
        const style = document.createElement('style'); style.textContent = css;
        style.dataset.dshAsr = ''; document.head.append(style);
        const removeStatus = mountStatus(controller);
        void controller.connect();
        return () => { controller.dispose(); removeStatus(); style.remove(); };
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
        name: 'conversation.input.overlay', id: 'dsh-sonicloud-device-recorder', inject: () => ({ controller }),
      }, Recorder));
    });
    await ui;
  } catch (error) { await ui?.dispose(); await unmountRemote(); throw error; }
  return async () => { await ui.dispose(); await unmountRemote(); };
}
