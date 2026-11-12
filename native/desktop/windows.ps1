$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName System.Windows.Forms, System.Drawing, UIAutomationClient, UIAutomationTypes, System.Web.Extensions
$references = @('System.Windows.Forms', 'System.Drawing', 'System.Web.Extensions', 'System.Core', 'WindowsBase',
  [System.Windows.Automation.AutomationElement].Assembly.Location,
  [System.Windows.Automation.Text.TextPatternRangeEndpoint].Assembly.Location)
Add-Type -Path (Join-Path $PSScriptRoot 'VoicePanel.cs') -ReferencedAssemblies $references
[Sonicloud.VoicePanel]::Run($PSScriptRoot)
