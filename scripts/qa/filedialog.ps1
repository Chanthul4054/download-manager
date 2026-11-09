# Fills in a Windows Open/Save dialog owned by -ProcessId with -Path and presses its OK button
# (Save / Open), as a user typing a file name would. The dialog's file-name box and buttons expose
# no UI Automation patterns here, so they get the messages typing and a click send (WM_SETTEXT,
# BM_CLICK) through their own window handles.
# Prints "done" (exit 0); "not-found" (1) or "no-field" (2) otherwise.
param([Parameter(Mandatory)][string]$Path, [Parameter(Mandatory)][int]$ProcessId, [int]$TimeoutSec = 20)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -Namespace W -Name F -MemberDefinition @'
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern System.IntPtr SendMessage(System.IntPtr h, uint m, System.IntPtr w, string l);
[DllImport("user32.dll")] public static extern System.IntPtr SendMessage(System.IntPtr h, uint m, System.IntPtr w, System.IntPtr l);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h);
'@
$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$P = { param($prop, $v) New-Object System.Windows.Automation.PropertyCondition($prop, $v) }
$dlgCond = & $P $AE::ClassNameProperty '#32770'
$sawDialog = $false
$deadline = (Get-Date).AddSeconds($TimeoutSec)
while ((Get-Date) -lt $deadline) {
    foreach ($top in $AE::RootElement.FindAll($TS::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
        if ($top.Current.ProcessId -ne $ProcessId) { continue }
        # The dialog is either a top-level window or (owned) under the app window.
        $dlgs = @(if ($top.Current.ClassName -eq '#32770') { $top }) + @($top.FindAll($TS::Descendants, $dlgCond))
        foreach ($d in $dlgs) {
            $sawDialog = $true
            # File name box: an Edit with id 1148 (Open) or 1001 (Save).
            $edit = $null
            foreach ($id in '1148', '1001') {
                $edit = $d.FindFirst($TS::Descendants, (New-Object System.Windows.Automation.AndCondition((& $P $AE::AutomationIdProperty $id), (& $P $AE::ClassNameProperty 'Edit'))))
                if ($edit) { break }
            }
            $ok = $d.FindFirst($TS::Descendants, (New-Object System.Windows.Automation.AndCondition((& $P $AE::AutomationIdProperty '1'), (& $P $AE::ClassNameProperty 'Button'))))
            if (-not $edit -or -not $ok -or -not $edit.Current.NativeWindowHandle) { continue }
            [void][W.F]::SetForegroundWindow([IntPtr]$d.Current.NativeWindowHandle)
            [void][W.F]::SendMessage([IntPtr]$edit.Current.NativeWindowHandle, 0x000C, [IntPtr]::Zero, $Path)  # WM_SETTEXT
            [void][W.F]::SendMessage([IntPtr]$ok.Current.NativeWindowHandle, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero)  # BM_CLICK
            'done'; exit 0
        }
    }
    Start-Sleep -Milliseconds 250
}
if ($sawDialog) { 'no-field'; exit 2 }
'not-found'; exit 1
