# Changelog

## Unreleased

### Added

- Add a per-device “Auto-send” switch for the AI key, enabled by default. Send the complete draft after recognition and successful insertion when enabled; otherwise only fill the composer. Legacy preferences and restored defaults enable the switch.

- Add hold-to-talk AI-key input targeting the DeepSeek Harness conversation composer: activate Harness, reuse the current conversation or create one from other pages, and append recognized text without requiring input focus. Preserve existing drafts and offer copying on failure.

- Add a standalone desktop voice panel centered above the screen work-area bottom, showing typing, translation and search previews, progress and errors, with cancel and copy controls.

- Add `dev:setup` and `dev` commands to rebuild and reload the plugin and reconnect devices on source saves; failed builds preserve the previous version and saved per-SN preferences remain intact.
- Add Sonicloud Devices settings with multiple smart mice, per-SN preferences, device switching, connection type, and battery status.
- Integrate mouse-sdk 0.4.20 with bundled macOS ARM64 and Windows x64 native libraries, running the SDK in a separate process.
- Add DPI, M-key, and speech-key settings, voice search, one-click links, and system key actions.
- Integrate Sonicloud text translation with shared device tokens and language-code mapping; provide 43 built-in recognition option mappings and custom mappings.
- Add tests for device isolation, reconnection, translation, search, and settings while retaining ASR protocol and host Gateway integration checks.

### Changed

- Update the AI-key description to state that holding records speech and releasing fills the AI conversation input; remove the “Open AI conversation” dropdown.

- Dismiss the status pill immediately when recognition completes without speech, instead of leaving a no-speech notice visible.

- Use guarded clipboard paste by default on macOS, supporting apps without accessibility write APIs; retain target, focus and input-activity checks and restore the previous clipboard without overwriting newer copies.

- Restyle the desktop voice panel as a 48-point-high pill with vertically centered single-line text, a near-white thin border, an X icon for cancel/close and transparent corners; replace the green dot with an animated waveform.

- Move voice sessions to the plugin backend so minimizing or hiding Harness and disconnecting its UI no longer cancel speech. Insert final text only when the captured target remains unchanged, otherwise retain it for copying. Remove the in-composer voice bar; the backend still stops when Harness exits.

- Allow one-click links without an HTTP/HTTPS scheme; preserve the original address in the input, storage, and browser invocation without adding a scheme.

- Add usage descriptions for the DPI, M, speech, and AI keys; remove text labels for M-key sub-settings and the separator below the M-key selector.
- Hide save-success and DPI command delivery notices below device settings while retaining progress and error feedback.
- **Breaking change**: rename the package and plugin ID from `dsh-asr` to `dsh-sonicloud-device`; upgrades require removing the old plugin, installing the new package, and reapplying host plugin configuration. Device preferences retain their storage key; legacy service credentials are cleared on startup.
- Rename the settings sidebar entry and page from “我的设备” (My Devices) to “声云设备” (Sonicloud Devices).
- Use the Sonicloud brand logo in the plugin list and a matching monochrome SVG that follows the theme color in the settings sidebar.

- Position the ASR text preview 8px above the conversation composer at the same width, retaining the global voice status when no composer is available.
- Declare `engines.dsh: >=0.2.1-rc.5` to allow this and later versions through the host version check.
- Align Sonicloud Devices with General Settings and reuse host controls; save and apply changes automatically, replacing Save and Reload with a compact warning-colored Restore Defaults button scoped to the current device.
- Convert the plugin to a smart mouse plugin with shared ASR service configuration, a single voice-session scheduler, and audio from the originating mouse.
- **Breaking change**: obtain tokens using the originating mouse SN and remove local application credentials, custom service editing, and credential-reading endpoints; only the timeout option remains in translation configuration.
- Consolidate the plugin specification in `docs/specs/smart-mouse-plugin.md` and mouse settings, language mappings, and device options in `docs/specs/mouse-settings.md`; provide runtime data through `src/shared/languages.mjs` and `src/shared/mouse-settings.mjs`.

### Fixed

- Fix AI-key navigation leaving Settings open and failing to fill conversations created from other pages: dismiss Settings, create the conversation in an available workspace, and wait for the target composer before inserting text.

- Fix speech insertion in macOS Zed, which does not expose editable accessibility controls: use guarded paste when the window, document and input activity remain unchanged, restoring prior clipboard formats without overwriting newer copies.

- Replace the one-click link label and inline messages with a Confirm button beside the input; validate and save only on confirmation, show error toasts without applying invalid edits or failed saves, and show a success toast after saving. Preserve drafts across status updates and late replies, and use the newly saved URL for subsequent button presses.

- Refresh invalid tokens and retry once silently, showing a single toast on final failure; preserve unsent audio during retry and discard late output after cancellation.
- Update development watching, test fixtures, and package contents to `docs/`, fixing development tests and missing packaged documentation after the directory migration.

- Fix premature “ASR not ready” errors when mouse audio arrives before the ASR handshake; upload buffered audio in order once ready, including recordings released before readiness.
- Reconnect interrupted device event streams and clear stale device state; detect exclusive 2.4G data-interface owners on macOS and identify the blocking app instead of treating SDK initialization as device readiness.
- Use the live-tested `lanid=100` for Traditional Mandarin instead of an ID that returns Simplified text, and disable translation source options without an ASR mapping.

### Removed

- Remove the M-key Show Desktop option and its system action implementation; removed actions in saved preferences fall back to the default Enter action while preserving other settings.

- Remove 11 voice typing options without an exact documented match and Mongolian as a voice translation source; retain 43 voice typing options, 27 translation sources, and the existing 28 translation targets. Saved removed selections prompt reselection and block affected voice actions without substituting another language.

- **Breaking change**: remove press-and-hold recording in the conversation input and computer microphone capture; smart mouse keys now trigger voice actions.
