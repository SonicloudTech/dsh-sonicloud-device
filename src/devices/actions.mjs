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
      // The window title varies with the active page, so title matching fails intermittently; activate by handle.
      // Minimized windows need ShowWindow(SW_RESTORE) because AppActivate never restores them. When no visible handle
      // exists (hidden to the tray), a second launch of the running exe reaches the single-instance handler, which
      // restores or recreates the window from inside the app. The plugin backend itself runs the app exe as node via
      // ELECTRON_RUN_AS_NODE, and a second launch inheriting that variable would also start as plain node and exit
      // without any window, so the Electron overrides must be stripped before handing off.
      openAi: "$p=Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1; if($p){ Add-Type -Namespace Win -Name Native -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);[DllImport(\"user32.dll\")] public static extern bool SetForegroundWindow(IntPtr hWnd);'; [Win.Native]::ShowWindow($p.MainWindowHandle, 9) | Out-Null; if([Win.Native]::SetForegroundWindow($p.MainWindowHandle)){ exit 0 } }; Remove-Item Env:\\ELECTRON_RUN_AS_NODE, Env:\\ELECTRON_NO_ATTACH_CONSOLE, Env:\\ELECTRON_NO_ASAR -ErrorAction SilentlyContinue; $exe=(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Select-Object -First 1).Path; if($exe){ Start-Process -FilePath $exe -ArgumentList 'dsh://open'; exit 0 }; Start-Process -FilePath rundll32.exe -ArgumentList 'url.dll,FileProtocolHandler','dsh://open' -WindowStyle Hidden; exit 0",
    };
    if (!scripts[action]) throw new Error('不支持此按键动作');
    args = ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(scripts[action], 'utf16le').toString('base64')];
  } else throw new Error('当前平台尚不支持此系统按键动作');
  try { await execute(file, args, commandOptions); }
  catch { throw new Error(action === 'openUrl' ? '浏览器打开失败，请检查默认浏览器' : '系统动作执行失败，请检查辅助功能权限及宿主运行状态'); }
}
