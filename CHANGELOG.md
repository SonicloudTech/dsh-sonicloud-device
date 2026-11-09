# Changelog

## Unreleased

### Changed

- Use English for the default README and preserve the Chinese guide in README.zh.md, with links between both versions and both included in the package.
- Document CI/CD platform configuration and release verification results with traceable workflow links.
- Separate device event and speech result handling and share client retry waits, preserving functionality, protocols, and UI.
- Streamline specifications and development documentation, centralize behavior contracts and verification records, and standardize development on npm by removing the outdated pnpm lockfile and placeholder configuration.

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
