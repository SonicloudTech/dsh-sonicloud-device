import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
if (process.platform !== 'darwin') throw new Error('macOS 浮层须在 macOS 上构建');
const bundle = `native/desktop/darwin-${process.arch}/Sonicloud Voice.app`;
const target = `${bundle}/Contents/MacOS/sonicloud-voice`;
mkdirSync(`${root}${bundle}/Contents/MacOS`, { recursive: true });
writeFileSync(`${root}${bundle}/Contents/Info.plist`, `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.sonicloud.voice-panel</string>
<key>CFBundleName</key><string>Sonicloud Voice</string>
<key>CFBundleExecutable</key><string>sonicloud-voice</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSUIElement</key><true/>
<key>NSHighResolutionCapable</key><true/>
<key>LSMinimumSystemVersion</key><string>11.0</string>
</dict></plist>\n`);
execFileSync('/usr/bin/xcrun', ['swiftc', '-O', '-module-cache-path', '/private/tmp/sonicloud-swift-cache',
  '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx11.0`,
  'native/desktop/VoicePanel.swift', 'native/desktop/CompatibilityPolicy.swift', '-o', target], { cwd: root, stdio: 'inherit' });
console.log(`Built ${target}`);
