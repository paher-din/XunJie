param(
  [Parameter(Mandatory=$true)][string]$Mode,
  [Parameter(Mandatory=$true)][int]$ChromeProcessId,
  [string]$KeysBase64,
  [string]$ImagePath
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class AluIme211 {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern IntPtr GetKeyboardLayout(uint thread);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
$chrome = Get-Process -Id $ChromeProcessId -ErrorAction Stop
if ($chrome.SessionId -ne [Diagnostics.Process]::GetCurrentProcess().SessionId) {
  throw 'The probe and its Chrome must share the unlocked interactive desktop.'
}
if (Get-Process LogonUI -ErrorAction SilentlyContinue | Where-Object {$_.SessionId -eq $chrome.SessionId}) {
  throw 'The interactive desktop is locked; no IME evidence can be collected.'
}
$foreground = [AluIme211]::GetForegroundWindow()
$foregroundProcess = [uint32]0
$thread = [AluIme211]::GetWindowThreadProcessId($foreground, [ref]$foregroundProcess)
if ($foregroundProcess -ne $ChromeProcessId) {
  [void][AluIme211]::ShowWindow($chrome.MainWindowHandle, 9)
  [void][AluIme211]::SetForegroundWindow($chrome.MainWindowHandle)
  Start-Sleep -Milliseconds 300
  $foreground = [AluIme211]::GetForegroundWindow()
  $thread = [AluIme211]::GetWindowThreadProcessId($foreground, [ref]$foregroundProcess)
}
if ($foregroundProcess -ne $ChromeProcessId) {
  throw "Refusing native input: foreground process $foregroundProcess is not probe Chrome $ChromeProcessId."
}
if ($Mode -eq 'keys') {
  $keys = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($KeysBase64))
  [System.Windows.Forms.SendKeys]::SendWait($keys)
}
if ($Mode -eq 'screenshot') {
  $ffmpeg = (Get-Command ffmpeg.exe -ErrorAction Stop).Source
  # Desktop Duplication captures the actual composited OS candidate popup, unlike page screenshots.
  $capture = & $ffmpeg -hide_banner -loglevel error -y -f lavfi -i 'ddagrab=framerate=30' -vf 'hwdownload,format=bgra' -frames:v 1 -update 1 $ImagePath 2>&1
  if ($LASTEXITCODE -ne 0) { throw "Desktop Duplication failed: $capture" }
}
$windows = New-Object System.Collections.ArrayList
$enum = [AluIme211+EnumProc]{param($handle,$unused)
  if ([AluIme211]::IsWindowVisible($handle)) {
    $windowProcess = [uint32]0
    [void][AluIme211]::GetWindowThreadProcessId($handle,[ref]$windowProcess)
    $owner = (Get-Process -Id $windowProcess -ErrorAction SilentlyContinue).ProcessName
    $class = New-Object Text.StringBuilder 256
    [void][AluIme211]::GetClassName($handle,$class,256)
    $rect = New-Object AluIme211+RECT
    [void][AluIme211]::GetWindowRect($handle,[ref]$rect)
    if ($owner -match 'TextInputHost|InputApp|ChsIME|Sogou|Doubao|IME' -and $rect.Right -gt $rect.Left -and $rect.Bottom -gt $rect.Top) {
      [void]$windows.Add([pscustomobject]@{owner=$owner;class=$class.ToString();processId=$windowProcess;
        x=$rect.Left;y=$rect.Top;width=($rect.Right-$rect.Left);height=($rect.Bottom-$rect.Top)})
    }
  }
  return $true
}
[void][AluIme211]::EnumWindows($enum,[IntPtr]::Zero)
[pscustomobject]@{sessionId=$chrome.SessionId;foregroundProcessId=$foregroundProcess;
  keyboardLayout=([AluIme211]::GetKeyboardLayout($thread).ToInt64().ToString('X'));
  candidateWindows=@($windows.ToArray())} | ConvertTo-Json -Depth 5 -Compress
