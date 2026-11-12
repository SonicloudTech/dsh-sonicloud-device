import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, copyFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const run = promisify(execFile);

// 只调用注入前即返回的路径（能力探测、状态机错误、非法 UTF-8 严格校验），不会向任何窗口打字。
const HARNESS = `
using System;
using System.Runtime.InteropServices;
namespace Sonicloud {
    public static class TyperTests {
        public static void Run(string directory) {
            Typer.Load(directory);
            if (!Typer.loaded) throw new Exception("typer.dll failed to load from " + directory);
            string version = Typer.StringAt(Typer.typer_version());
            if (version.Length == 0) throw new Exception("typer_version empty");
            var caps = new Typer.Caps();
            caps.size = (IntPtr)Marshal.SizeOf(typeof(Typer.Caps));
            int probed = Typer.typer_probe(ref caps);
            if (probed != 0) throw new Exception("probe failed: " + probed);
            if (caps.session_type != 1) throw new Exception("session_type " + caps.session_type + " is not Win32");
            if (caps.text_typing != 1 || caps.increment_typing != 1 || caps.whole_phrase_paste != 1)
                throw new Exception("caps missing typing support");
            var engine = new TyperEngine();
            if (!engine.Open(null)) throw new Exception("engine open failed");
            if (engine.Partial("hi") != -6) throw new Exception("feed before begin must be WRONG_STATE");
            if (engine.Begin(Typer.ModePerChar) != 0) throw new Exception("session begin failed");
            if (Typer.typer_feed_partial(engine.context, new byte[] { 0xC3, 0x28, 0x00 }) != -1)
                throw new Exception("invalid utf8 must be rejected");
            if (engine.End() != 0) throw new Exception("session end failed");
            engine.Close();
            if (engine.context != IntPtr.Zero) throw new Exception("close must clear context");
            if (!TyperEngine.ErrorText(-4).Contains("拒绝")) throw new Exception("access denied text");
            if (!TyperEngine.ErrorText(-99).Contains("-99")) throw new Exception("generic text keeps code");
            Console.WriteLine("typer smoke passed: version=" + version);
        }
    }
}
`;

test('Windows typing engine loads typer.dll and rejects invalid input without injecting', { skip: process.platform !== 'win32' }, async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'sonicloud-typer-'));
  try {
    const panel = join(temporary, 'VoicePanel.cs');
    const harness = join(temporary, 'typer-tests.cs');
    await copyFile('native/desktop/VoicePanel.cs', panel);
    await copyFile('native/desktop/typer.dll', join(temporary, 'typer.dll'));
    await writeFile(harness, HARNESS, 'utf8');
    const script = [
      'Add-Type -AssemblyName System.Windows.Forms, System.Drawing, UIAutomationClient, UIAutomationTypes, System.Web.Extensions',
      "$refs = @('System.Windows.Forms','System.Drawing','System.Web.Extensions','System.Core','WindowsBase',",
      '  [System.Windows.Automation.AutomationElement].Assembly.Location,',
      '  [System.Windows.Automation.Text.TextPatternRangeEndpoint].Assembly.Location)',
      `Add-Type -Path '${panel}', '${harness}' -ReferencedAssemblies $refs`,
      `[Sonicloud.TyperTests]::Run('${temporary}')`,
    ].join('\n');
    const result = await run('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: 60000 });
    assert.match(result.stdout, /typer smoke passed: version=\d+\.\d+\.\d+/);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
