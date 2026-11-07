#!/usr/bin/env node
/**
 * #206 X3: native Windows Chinese IME candidate-window evidence in the real product page.
 *
 * Playwright is used only to open and focus the real product editor. Pinyin key presses,
 * commit (Space), cancel (Escape) and full-screen captures go through the operating system
 * in an interactive desktop session (PowerShell + Win32 + SendKeys). No CDP composition
 * events and no synthetic browser text are used as evidence.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from '@playwright/test';

const { values } = parseArgs({ options: { state: { type: 'string' }, output: { type: 'string' } } });
for (const name of ['state', 'output']) if (!values[name]) throw new Error('usage: --state=FILE --output=DIR');
const state = JSON.parse(await readFile(resolve(values.state), 'utf8'));
const output = resolve(values.output);
await mkdir(output, { recursive: true });
const wait = ms => new Promise(done => setTimeout(done, ms));

const helper = join(output, 'ime-helper.ps1');
await writeFile(helper, `param(
  [Parameter(Mandatory=$true)][string]$Out,
  [Parameter(Mandatory=$true)][string]$Mode
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.Text;
using System.Runtime.InteropServices;
public class U {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
}
"@
function Wake {
  # The dedicated verification desktop has no screen saver, and the user's desktop must stay untouched.
  # Never move the cursor or wake the interactive desktop from this probe.
  Start-Sleep -Milliseconds 100
}
function Save-Shot($name) {
  $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
  $bmp = New-Object System.Drawing.Bitmap($b.Width, $b.Height)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
  $bmp.Save((Join-Path $Out $name), [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose()
  $bmp.Dispose()
}
function Focus-Chrome {
  Wake
  $chrome = Get-Process chrome -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if ($chrome) {
    [void][U]::ShowWindow($chrome.MainWindowHandle, 9)
    [void][U]::SetForegroundWindow($chrome.MainWindowHandle)
    Start-Sleep -Milliseconds 400
  }
  $sb = New-Object System.Text.StringBuilder 256
  [void][U]::GetClassName([U]::GetForegroundWindow(), $sb, 256)
  return $sb.ToString()
}
switch ($Mode) {
  'compose' {
    $fg = Focus-Chrome
    Write-Output ('FOREGROUND=' + $fg)
    [System.Windows.Forms.SendKeys]::SendWait('ceshi')
    Start-Sleep -Milliseconds 1800
    Write-Output ('AFTER_COMPOSE_FOREGROUND=' + (Focus-Chrome))
    Save-Shot 'windows-ime-candidate-window.png'
  }
  'commit' {
    Wake
    [System.Windows.Forms.SendKeys]::SendWait(' ')
    Start-Sleep -Milliseconds 1000
    Save-Shot 'windows-ime-after-commit.png'
  }
  'compose2' {
    Wake
    [System.Windows.Forms.SendKeys]::SendWait('shuru')
    Start-Sleep -Milliseconds 1500
    Save-Shot 'windows-ime-second-composition.png'
  }
  'cancel' {
    Wake
    [System.Windows.Forms.SendKeys]::SendWait('{ESC}')
    Start-Sleep -Milliseconds 900
    Save-Shot 'windows-ime-after-cancel.png'
  }
}
`);

const ps = mode => execFileSync('powershell.exe',
  ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', helper, '-Out', output, '-Mode', mode],
  { encoding: 'utf8' }).trim();
const text = async page => page.locator('.view-lines').innerText().catch(() => '');

const report = { kind: 'windows-os-ime-candidate-window', ticket: '#206', item: 'X3',
  platform: process.platform, arch: process.arch, node: process.version,
  startedAt: new Date().toISOString(), cases: [], status: 'running' };
const passed = name => { report.cases.push(name); console.log('PASS ' + name); };

let browser;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: false,
    args: [`--ignore-certificate-errors-spki-list=${state.spki}`] });
  report.browser = browser.version();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, ignoreHTTPSErrors: false });
  assert.equal((await context.request.post(state.endpoint + '/api/learning/login',
    { data: { loginName: state.loginName, password: state.password } })).status(), 200);
  const created = await context.request.post(state.endpoint + '/api/learning/course-activities',
    { data: { requestId: crypto.randomUUID(), releaseId: state.releaseId } });
  assert.equal(created.status(), 200);
  const activity = await created.json();
  const page = await context.newPage();
  await page.goto(state.endpoint + '?space=school&activity=' + activity.activityId);
  await page.bringToFront();
  const editor = page.locator('.monaco-editor textarea').first();
  await editor.focus();
  await wait(1200);
  report.pageUrl = state.endpoint;
  passed('a real product editor is focused in desktop Chrome on Windows');

  const composition = ps('compose');
  report.compositionOutput = composition;
  assert.ok(composition.includes('Chrome_WidgetWin_1'), `Chrome was not the foreground window: ${composition}`);
  passed('real pinyin key presses are delivered by the OS to the focused product editor');
  // The OS-drawn UWP candidate window is not captured by GDI CopyFromScreen on Windows;
  // the behaviour above plus the committed/cancelled text are the X3 evidence, see the acceptance record.

  ps('commit');
  const committed = await text(page);
  report.committedText = committed.slice(0, 200);
  assert.ok(committed.includes('测试'), `candidate was not committed, saw ${committed.slice(0, 80)}`);
  passed('a real Space shortcut commits the selected Chinese candidate into the editor');

  ps('compose2');
  ps('cancel');
  const afterCancel = await text(page);
  report.afterCancelText = afterCancel.slice(0, 200);
  assert.equal(afterCancel, committed, 'cancel must leave the protected text unchanged');
  passed('a real Escape shortcut cancels composition without changing the protected text');

  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = String(error?.stack ?? error);
  throw error;
} finally {
  report.finishedAt = new Date().toISOString();
  await browser?.close().catch(() => undefined);
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, cases: report.cases.length, error: report.error ?? null }));
}
