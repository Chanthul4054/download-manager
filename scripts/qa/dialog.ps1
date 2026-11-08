# Waits for a top-level window titled -Title owned by process -ProcessId and presses its -Button,
# as a user would. Task dialogs' command buttons (CCPushButton) expose no UI Automation pattern,
# so those get the click a mouse sends (BM_CLICK to the button's own window).
# Prints "clicked" (exit 0); "not-found" (1), "no-button" (2) or "cannot-click" (3) otherwise.
param([Parameter(Mandatory)][string]$Title, [Parameter(Mandatory)][string]$Button, [int]$ProcessId = 0, [int]$TimeoutSec = 20)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -Namespace W -Name U -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(System.IntPtr h);
[DllImport("user32.dll")] public static extern System.IntPtr SendMessage(System.IntPtr h, uint m, System.IntPtr w, System.IntPtr l);
'@
$AE = [System.Windows.Automation.AutomationElement]
$byName = { param($n) New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, $n) }
$noButton = $false
$deadline = (Get-Date).AddSeconds($TimeoutSec)
while ((Get-Date) -lt $deadline) {
    # Top-level windows with that title, and dialogs owned by one of the process's windows (a
    # message box sits under the main window, which may share its title).
    $wins = @($AE::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, (& $byName $Title)))
    foreach ($top in $AE::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children, [System.Windows.Automation.Condition]::TrueCondition)) {
        if (-not $ProcessId -or $top.Current.ProcessId -eq $ProcessId) {
            $wins += @($top.FindAll([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.AndCondition((& $byName $Title), (New-Object System.Windows.Automation.PropertyCondition($AE::ClassNameProperty, '#32770'))))))
        }
    }
    foreach ($w in $wins) {
        if ($ProcessId -and $w.Current.ProcessId -ne $ProcessId) { continue }
        $b = $w.FindFirst([System.Windows.Automation.TreeScope]::Descendants, (& $byName $Button))
        if (-not $b) { $noButton = $true; continue }
        $p = $null
        if ($b.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$p)) {
            $p.Invoke()
        } elseif ($b.Current.NativeWindowHandle) {
            [void][W.U]::SetForegroundWindow([IntPtr]$w.Current.NativeWindowHandle)
            [void][W.U]::SendMessage([IntPtr]$b.Current.NativeWindowHandle, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero)  # BM_CLICK
        } else { 'cannot-click'; exit 3 }
        'clicked'; exit 0
    }
    Start-Sleep -Milliseconds 250
}
if ($noButton) { 'no-button'; exit 2 }
'not-found'; exit 1
