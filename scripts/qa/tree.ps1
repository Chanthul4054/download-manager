param([int]$Root)
$all = Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, WorkingSetSize, PrivatePageCount, KernelModeTime, UserModeTime
$ids = @($Root); $added = $true
while ($added) { $added = $false; foreach ($p in $all) { if (($ids -contains $p.ParentProcessId) -and -not ($ids -contains $p.ProcessId)) { $ids += $p.ProcessId; $added = $true } } }
$tree = $all | Where-Object { $ids -contains $_.ProcessId }
$app = $all | Where-Object { $_.ProcessId -eq $Root }
$ws = ($tree | Measure-Object WorkingSetSize -Sum).Sum
$priv = ($tree | Measure-Object PrivatePageCount -Sum).Sum
$cpu = (($tree | Measure-Object KernelModeTime -Sum).Sum + ($tree | Measure-Object UserModeTime -Sum).Sum) / 1e7
$appcpu = ($app.KernelModeTime + $app.UserModeTime) / 1e7
Write-Output ("{0} {1} {2} {3} {4} {5}" -f [math]::Round($app.WorkingSetSize/1MB,1), [math]::Round($ws/1MB,1), [math]::Round($priv/1MB,1), $ids.Count, $cpu, $appcpu)
