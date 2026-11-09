# Sonicloud Smart Mouse Plugin

English | [简体中文](README.zh.md)

Use a Sonicloud smart mouse for voice typing, translation, and search in desktop apps, and manage its buttons and sensitivity through DeepSeek Harness. After installation, open **Sonicloud Devices (声云设备)** in Harness settings to view and configure your mice.

## Features

- **Voice typing**: Hold the mouse's voice button to speak. Release it to insert recognized text into the editable field that was focused when you pressed the button, without sending it automatically.
- **Voice translation**: Choose source and target languages, assign voice translation to the voice or M button, and release the button to insert the translation.
- **Voice search**: Assign voice search to the M button, then speak your query to search with your selected engine.
- **Custom buttons**: Assign Enter, Backspace, Open Link, or other actions to the M button. Hold the AI button to bring Harness to the foreground and dictate into an AI conversation. Auto-send is enabled by default and can be disabled in device settings.
- **Multiple mice**: View connection type, battery level, and serial number, and save language, button, and sensitivity settings separately for each mouse.

The plugin connects to services using the current mouse's identity. No manual authentication configuration is required.

## Requirements

- DeepSeek Harness **0.2.1-rc.5 or later**.
- A supported Sonicloud smart mouse connected via Bluetooth or a 2.4 GHz USB receiver.
- The plugin package (`.tgz`) and network access to the speech service.

The package includes device components for Apple silicon Macs and Windows x64. The maintainer has confirmed hardware acceptance testing for version 0.1.0; other systems are not currently guaranteed to work.

## Installation and activation

1. Launch Harness once to complete initialization, then quit the app completely.
2. Run the following command in a terminal, replacing the path with the full path to your package:

   ```sh
   dsh plugin --profile desktop add "/absolute/path/sonicloud-dsh-sonicloud-device-0.1.1.tgz"
   ```

   Use the actual package filename. On a Mac, if `dsh` cannot be found, use:

   ```sh
   "/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh" plugin --profile desktop add "/absolute/path/sonicloud-dsh-sonicloud-device-0.1.1.tgz"
   ```

3. Restart Harness and enable `dsh-sonicloud-device` in the plugin manager.
4. Open Settings and select **Sonicloud Devices (声云设备)** in the sidebar.

You can also install a specific release from npm:

```sh
dsh plugin --profile desktop add @sonicloud/dsh-sonicloud-device@0.1.1
```

If installation reports `ERR_PNPM_IGNORED_BUILDS` for `koffi`, add the following to that profile's `pnpm-workspace.yaml`, replacing the placeholder with the exact version in the error, then retry. Preserve existing configuration and approve only this native dependency:

```yaml
allowBuilds:
  "koffi@<version-from-error>": true
```

To migrate from the old package, quit Harness completely, run `dsh plugin --profile desktop remove dsh-sonicloud-device`, then install the new package. The plugin instance ID remains `dsh-sonicloud-device`, and device preferences keyed by serial number keep their existing storage keys. Do not delete profile data.

Download test packages from the run summary in [Actions](https://github.com/SonicloudTech/dsh-sonicloud-device/actions/workflows/release.yml). They are retained for 30 days and require a GitHub login to download. Extract the outer archive, then install the `.tgz` inside.

## Getting started

### Connect and configure a mouse

Turn on your mouse, select Bluetooth or 2.4 GHz mode, and connect it. Select the mouse in **Sonicloud Devices (声云设备)** to view its battery level, connection type, and serial number (SN).

You can change the recognition language, punctuation setting, mouse sensitivity (DPI), and button actions. Changes save automatically; there is no Save button. **Restore Defaults (恢复默认)** resets only the current mouse. Reconnecting the same mouse restores its saved settings.

### Voice typing

1. In **Sonicloud Devices (声云设备)**, set **Voice Button (语音键)** to **Voice Typing (语音打字)** and choose a recognition language.
2. Place the cursor in an editable field in the target app. You do not need to open a Harness conversation.
3. Hold the mouse's voice button to speak, then release it and wait for recognition to finish.
4. Review the inserted text and send it yourself.

Audio comes from the mouse. Interim text, finishing status, and translation status appear in a separate overlay centered at the bottom of the screen containing the mouse pointer, without taking input focus. Minimizing or hiding the Harness window, or switching pages, does not cancel the session. The plugin must remain running in the background; quitting Harness completely stops it.

Click the overlay's close button or disconnect the mouse to cancel. If the target, content, or selection changes, or the app does not support safe text insertion, the overlay keeps the result available to copy. On macOS, automatic insertion requires allowing **Sonicloud Voice** under **System Settings → Privacy & Security → Accessibility**. Recognition and copying still work without this permission. On Windows, results remain available to copy when an input field does not expose an editable UI Automation text interface.

macOS uses a compatibility paste method by default, supporting apps such as Zed that do not expose an accessibility write interface. Keep the target window and document unchanged during recording, and avoid typing, clicking, or scrolling. Where readable, content and selection are also checked for changes. Insertion temporarily uses the clipboard and restores its previous contents without overwriting anything newly copied in the meantime. If the target or input activity changes, the result remains available to copy.

### Buttons and search

| Button | Behavior |
| --- | --- |
| Voice | Choose voice typing or translation; hold to speak and release to finish |
| M | Choose Enter, Backspace, voice typing, translation, voice search, or Open Link; hold for voice actions, while other actions run on release |
| AI | Hold to speak and release to finish; brings Harness to the foreground if needed, fills the current AI conversation or creates one when on another page; input focus is not required; Auto-send is enabled by default, or disable it to fill the draft only |

The AI button works only with DeepSeek Harness and uses the current mouse's recognition language and punctuation settings. Recognized text is appended to the existing draft. With **Auto-send (自动发送)** enabled, the complete draft and attachments are submitted; otherwise, they remain for manual sending. This setting is saved per device, and each recording uses the setting captured when the button was pressed. If you switch pages or conversations during recording, the plugin returns to the captured conversation and fills it when recognition finishes. If activation, conversation creation, or insertion fails, the overlay keeps the result available to copy. Harness and the plugin must already be running; this feature is unavailable after quitting completely.

For voice search, choose Baidu, Bing, or Google in settings. For **Open Link (一键链接)**, enter a URL and click **Confirm (确认)**. You may omit `https://` or `http://`; the address is preserved as entered when saved and opened. Searching and opening links do not require a focused conversation input field.

Multiple mice can be connected and configured separately, but only one voice operation can run at a time.

## Troubleshooting

### Receiver connected but no device appears

Make sure the mouse is powered on, in 2.4 GHz mode, and awake. Quit other mouse management apps, such as ClawMouse, which may hold the connection. Normal cursor movement does not mean the voice connection is working.

On a Mac, check **Sonicloud Devices (声云设备)** for connection ownership warnings. If it reports that a 2.4 GHz receiver was detected and is waiting for the mouse to respond, check the mouse's power and connection mode again.

### Voice recognition or translation fails

Make sure the mouse's identity has been recognized, the network is available, and the translation source and target languages differ. Authentication failures trigger one automatic retry; a message appears if it still fails. If translation fails, you can copy the recognized source text.

### Settings or buttons do not take effect

- If applying DPI fails, select the value again to retry.
- On a Mac, system key actions such as Enter and Backspace may require Accessibility permission for Harness.
- If a saved language is no longer supported, select a supported language again.

### Update or uninstall

To update, quit Harness completely, install the new `.tgz` using the installation command, and restart Harness.

To uninstall, quit Harness completely and run:

```sh
dsh plugin --profile desktop remove @sonicloud/dsh-sonicloud-device
```

On a Mac, if `dsh` cannot be found, use the full CLI path shown in the installation steps.

## Contact

For business partnerships, technical support, or mouse hardware purchases:

- Email: [xu_heng_yu@sinicloud.com](mailto:xu_heng_yu@sinicloud.com)
- WeChat: Scan the QR code below.

<img src="src/client/assets/contact-wechat.jpg" alt="WeChat contact QR code for business partnerships, technical support, and mouse hardware purchases" width="300" />

## Contributing

Read the [local development and contribution guide](docs/contributing/development.md) (in Chinese) for environment setup, debugging, testing, and contribution instructions.

See the [changelog](CHANGELOG.md) for release notes.

## License

Project code is licensed under the [MIT License](LICENSE). Bundled native SDKs and third-party libraries retain their own licenses; see the [component notices](native/THIRD_PARTY_LICENSES.txt).
