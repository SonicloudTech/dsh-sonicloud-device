import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { webUrl } from '../shared/devices.mjs';
const run = promisify(execFile);
const commandOptions = { timeout: 8000, windowsHide: true, maxBuffer: 8192 };
export async function systemAction(action, value, { platform = process.platform, execute = run } = {}) {
  let file, args;
  if (action === 'openUrl') {
    const url = webUrl(value);
    if (platform === 'darwin') {
      file = '/usr/bin/open'; args = [url];
      if (!/^https?:\/\//i.test(url)) {
        // Pass a bare address as a browser argument, not as a local file or a rewritten URL.
        try {
          const result = await execute('/usr/bin/osascript', ['-l', 'JavaScript', '-e',
            "ObjC.import('CoreServices'); ObjC.unwrap(ObjC.castRefToObject($.LSCopyDefaultHandlerForURLScheme($('http'))));"], commandOptions);
          const browser = result.stdout.trim();
          if (!/^[a-z\d][a-z\d.-]+$/i.test(browser)) throw new Error('默认浏览器不可用');
          args = ['-n', '-b', browser, '--args', url];
        } catch { throw new Error('浏览器打开失败，请检查默认浏览器'); }
      }
    }
    else if (platform === 'win32') { file = 'rundll32.exe'; args = ['url.dll,FileProtocolHandler', url]; }
    else { file = 'xdg-open'; args = [url]; }
  } else if (platform === 'darwin') {
    file = '/usr/bin/osascript';
    const scripts = {
      enter: 'tell application "System Events" to key code 36',
      backspace: 'tell application "System Events" to key code 51',
      openAi: 'tell application "DeepSeek Harness" to activate',
    };
    if (!scripts[action]) throw new Error('不支持此按键动作');
    args = ['-e', scripts[action]];
  } else if (platform === 'win32') {
    file = 'powershell.exe';
    const scripts = {
      enter: '$s=New-Object -ComObject WScript.Shell; $s.SendKeys("{ENTER}")',
      backspace: '$s=New-Object -ComObject WScript.Shell; $s.SendKeys("{BACKSPACE}")',
      openAi: '$s=New-Object -ComObject WScript.Shell; if(-not $s.AppActivate("DeepSeek Harness")){exit 1}',
    };
    if (!scripts[action]) throw new Error('不支持此按键动作');
    args = ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(scripts[action], 'utf16le').toString('base64')];
  } else throw new Error('当前平台尚不支持此系统按键动作');
  try { await execute(file, args, commandOptions); }
  catch { throw new Error(action === 'openUrl' ? '浏览器打开失败，请检查默认浏览器' : '系统动作执行失败，请检查辅助功能权限及宿主运行状态'); }
}
