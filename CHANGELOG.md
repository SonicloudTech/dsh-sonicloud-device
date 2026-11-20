# Changelog

## Unreleased

### Added

- Check macOS typing and screenshot permissions on initial activation and reconnection, with separate Sonicloud Voice and screenhelper authorization and recheck guidance in Sonicloud Devices; system permission confirmation remains manual.
- Integrate standalone screenshot processes for Windows x64 and macOS ARM64, triggered by the mouse capture button or Start Screenshot in Sonicloud Devices, with region selection, annotation, copying, saving, pinning, and scrolling capture; report repeated triggers and startup failures, and close capture and pinned windows when the plugin is disabled.

### Changed

- Sign macOS Sonicloud Voice with a Developer ID; existing Accessibility grants from older versions may need to be confirmed again as prompted by the system.
- Move the screenshot controls to the bottom of the Sonicloud Devices page.

### Fixed

- Check macOS Screen Recording permission in both the host and native screenshot process before showing the overlay, preventing it from covering system permission prompts; missing Accessibility permission does not block regular screenshots or manual scrolling.
- Restore macOS voice helper execution permissions lost during cross-platform packaging so packages built on Windows can start Sonicloud Voice.
- Hide unsupported image translation and scrolling OCR/Word export actions in both Windows and macOS screenshot processes while keeping scrolling capture available; retain the original Developer ID identity for the macOS package.
- Parse Windows tar line endings correctly during package checks so complete packages are not reported as missing files.

## 0.1.2 - 2026-11-12

### Added

- Add a Sonicloud Devices panel to the left navigation bar with the same device management UI as the settings page; shown by default, with a settings-page switch to hide or restore it without affecting the settings page.
- Switch Windows voice typing and translation to the typer injection library: text is typed live into the focused window character by character while speaking, with automatic backspace corrections, and finalized on release; translation types only the final translated text. Character injection never reads from or writes to the clipboard; password fields, a missing library, or rejected injection (for example, elevated windows) keep the result available to copy.
- Restore the Harness window for the AI button on Windows: activation now restores minimized windows directly, and for tray-hidden windows launches a second instance of the running app (stripping node-mode Electron environment overrides) handled by its single-instance handler; an activation failure alone no longer blocks filling the conversation draft.
- Offer one-click submit on Windows when the AI conversation cannot be filled: the overlay keeps the recognized text, prompts to open a target input, and types it into the focused window through the typer library when clicked.

### Changed

- Provide an English-default user guide with a Chinese version, UI installation, update, and removal instructions, and screenshots.
- Refactor device and speech handling and share retry logic, preserving functionality and UI.
- Streamline specifications and development docs, consolidating CI/CD configuration and release verification records.
- Standardize on npm and remove outdated pnpm lockfile and configuration.
- Relax release-notes rules: publishing falls back to the Unreleased section when the changelog has no section for the current version, so merging dev directly can ship.
- Accept fully folded changelogs in release checks: an Unreleased section must stay at the top when present, and a fully folded changelog (version sections only) publishes from the current version section.

## 0.1.1 - 2026-11-09

### Added

- Enable GitHub Actions: dev pushes build test packages and main pushes publish releases through npm Trusted Publisher, with bilingual changelog and package checks, run summaries, and release recovery.

### Fixed

- Wait for npm processing before checking the version and download, avoiding premature failures after a successful upload.

## 0.1.0 - 2026-11-09

Initial release of the Sonicloud smart mouse plugin for DeepSeek Harness 0.2.1-rc.5 and later.

### Added

- Integrate Sonicloud smart mice connected through Bluetooth or a 2.4G USB receiver, with bundled native SDKs for macOS ARM64 and Windows x64.
- Add Sonicloud Devices settings showing device names, SNs, connection types, and battery levels, with device switching, per-device preferences, automatic saving, restored defaults, and preference restoration on reconnection.
- Support 800, 1200, 1600, and 2400 DPI settings; synchronize physical DPI-button changes to the originating device's displayed and saved values, with separately configurable report and command mappings.
- Support hold-to-talk voice typing and translation using the mouse, with recognition language, punctuation, and translation source and target language settings.
- Configure the M key for Enter, Backspace, voice typing, voice translation, voice search, or opening a link; offer Baidu, Bing, and Google search, and save links on confirmation with optional HTTP/HTTPS schemes.
- Use the AI key to activate Harness, reuse the current conversation or create one, and append recognized text to the conversation draft; provide a per-device Auto-send switch enabled by default.
- Add a standalone desktop voice panel with recognition previews, processing status, errors, cancellation, and result copying; continue voice processing while the main window is minimized or hidden, with one voice session at a time.
- Insert text into desktop application inputs after checking the target and input state, retaining results for copying when safe insertion is unavailable; use compatibility paste on macOS while protecting and restoring clipboard contents.
- Obtain voice and translation service credentials automatically using the originating device SN, refreshing and retrying once on authentication failure without manual credential setup; handle device disconnections, reconnect event streams, and report macOS USB interface contention.
- Provide local development and automatic reload commands, development and feature specifications, and tests for device isolation, settings UI, voice flows, and host Gateway integration.

### Changed

- **Breaking change:** Compared with the old local package, rename the npm package to `@sonicloud/dsh-sonicloud-device`; preserve the plugin instance ID and device configuration storage keys.
- License project code under MIT; bundled native components retain their own licenses.
