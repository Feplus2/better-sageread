[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$ExecutablePath,
  [Parameter(Mandatory = $true)][string]$DirectoryPath,
  [Parameter(Mandatory = $true)][string]$DialogTitle,
  [Parameter(Mandatory = $true)][string]$SelectButtonText,
  [switch]$CancelExisting,
  [int]$TimeoutSeconds = 30
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class WorkspaceDialogNative {
  public delegate bool EnumWindowsProc(IntPtr window, IntPtr parameter);
  [DllImport("user32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool EnumChildWindows(IntPtr parent, EnumWindowsProc callback, IntPtr parameter);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern int GetClassName(IntPtr window, StringBuilder className, int maximum);
  public static IntPtr FindButton(IntPtr dialog, string label) {
    IntPtr found = IntPtr.Zero;
    EnumChildWindows(dialog, (window, parameter) => {
      var className = new StringBuilder(256);
      GetClassName(window, className, className.Capacity);
      if (className.ToString() != "Button") return true;
      var text = new StringBuilder(32768);
      SendMessage(window, 0x000D, (IntPtr)text.Capacity, text);
      if (text.ToString().Replace("&", "") != label) return true;
      found = window;
      return false;
    }, IntPtr.Zero);
    return found;
  }
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern IntPtr FindWindowEx(IntPtr parent, IntPtr childAfter, string className, string windowTitle);
  [DllImport("user32.dll", EntryPoint = "SendMessage", CharSet = CharSet.Unicode)]
  public static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr wParam, StringBuilder lParam);
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
  [DllImport("user32.dll")]
  public static extern bool IsWindow(IntPtr window);
  [DllImport("user32.dll")]
  public static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")]
  public static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")]
  public static extern IntPtr SetFocus(IntPtr window);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  public static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr wParam, string lParam);
  [DllImport("user32.dll", EntryPoint = "SendMessage")]
  public static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
}
'@

$executable = [IO.Path]::GetFullPath($ExecutablePath)
$directory = [IO.Path]::GetFullPath($DirectoryPath).TrimEnd([IO.Path]::DirectorySeparatorChar)
if (-not [IO.Directory]::Exists($directory)) { throw "Test directory does not exist: $directory" }
$preview = Get-Process -Name "better-sageread" | Where-Object { $_.Path -ieq $executable } | Select-Object -First 1
if (-not $preview) { throw "Isolated SageRead process not found" }
$dialog = $null
$selected = $false

function Get-NativeText([IntPtr]$window) {
  $buffer = New-Object System.Text.StringBuilder 32768
  [void][WorkspaceDialogNative]::SendMessage($window, 0x000D, [IntPtr]$buffer.Capacity, $buffer)
  return $buffer.ToString()
}

function Get-OwnedDialogs {
  $owned = @()
  $after = [IntPtr]::Zero
  while ($true) {
    $handle = [WorkspaceDialogNative]::FindWindowEx([IntPtr]::Zero, $after, "#32770", $DialogTitle)
    if ($handle -eq [IntPtr]::Zero) { break }
    $after = $handle
    [uint32]$ownerPid = 0
    [void][WorkspaceDialogNative]::GetWindowThreadProcessId($handle, [ref]$ownerPid)
    if ($ownerPid -eq $preview.Id -and [WorkspaceDialogNative]::IsWindowVisible($handle)) { $owned += $handle }
  }
  return $owned
}

function Wait-WindowGone([IntPtr]$window) {
  $deadline = [DateTime]::UtcNow.AddSeconds(5)
  while ([DateTime]::UtcNow -lt $deadline) {
    if (-not [WorkspaceDialogNative]::IsWindow($window)) { return $true }
    Start-Sleep -Milliseconds 80
  }
  return -not [WorkspaceDialogNative]::IsWindow($window)
}

function Close-OwnedDialogs {
  $closed = 0
  foreach ($owned in @(Get-OwnedDialogs)) {
    [void][WorkspaceDialogNative]::SendMessage($owned, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
    if (-not (Wait-WindowGone $owned)) { throw "Test directory dialog did not close: $owned" }
    $closed++
  }
  return $closed
}

try {
  if ($CancelExisting) {
    [PSCustomObject]@{ cancelled = Close-OwnedDialogs; processId = $preview.Id } | ConvertTo-Json -Compress
    exit 0
  }
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  while (-not $dialog -and [DateTime]::UtcNow -lt $deadline) {
    $candidates = @(Get-OwnedDialogs)
    if ($candidates.Count -eq 1) { $dialog = $candidates[0] }
    elseif ($candidates.Count -gt 1) { throw "Multiple owned directory dialogs are still open" }
    if (-not $dialog) { Start-Sleep -Milliseconds 100 }
  }
  if (-not $dialog) { throw "Owned native directory dialog not found" }
  $edit = [WorkspaceDialogNative]::FindWindowEx($dialog, [IntPtr]::Zero, "Edit", $null)
  if ($edit -eq [IntPtr]::Zero) { throw "Native folder path Edit control not found" }
  [void][WorkspaceDialogNative]::SendMessage($edit, 0x000C, [IntPtr]::Zero, $directory)
  if ((Get-NativeText $edit) -ne $directory) { throw "Native folder path did not stick" }
  $button = [WorkspaceDialogNative]::FindButton($dialog, $SelectButtonText)
  if ($button -eq [IntPtr]::Zero) { throw "Native select-folder button not found" }
  [void][WorkspaceDialogNative]::SendMessage($button, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero)
  $navigated = $false
  $navigationDeadline = [DateTime]::UtcNow.AddSeconds(15)
  while ([DateTime]::UtcNow -lt $navigationDeadline) {
    if (-not [WorkspaceDialogNative]::IsWindow($dialog)) {
      $navigated = $true
      break
    }
    if ((Get-NativeText $edit) -eq [IO.Path]::GetFileName($directory)) {
      $navigated = $true
      break
    }
    Start-Sleep -Milliseconds 100
  }
  if (-not $navigated) { throw "Native directory did not navigate to the requested path" }
  if ([WorkspaceDialogNative]::IsWindow($dialog)) {
    $button = [WorkspaceDialogNative]::FindButton($dialog, $SelectButtonText)
    if ($button -eq [IntPtr]::Zero) { throw "Native select-folder button not found" }
    [void][WorkspaceDialogNative]::SendMessage($button, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero)
    if (-not (Wait-WindowGone $dialog)) { throw "Native directory selection did not close the dialog" }
  }
  $selected = $true
  [PSCustomObject]@{ selectedPath = $directory; processId = $preview.Id; driver = "Win32 common dialog" } | ConvertTo-Json -Compress
} finally {
  if (-not $selected -and $dialog -and [WorkspaceDialogNative]::IsWindow($dialog)) {
    [void][WorkspaceDialogNative]::SendMessage($dialog, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
  }
}
