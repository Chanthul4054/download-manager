<#
OpenDM installer test: clean install, uninstall, and upgrades from the published 1.1.0 (Electron)
and the published 2.0.0 (Tauri) to the release candidate.

Run ONLY in a dedicated Windows test account: it installs and uninstalls OpenDM for the current
user and deletes this account's %APPDATA%\OpenDM between steps. It refuses to start if this account
already has OpenDM installed or an OpenDM data folder.

  powershell -NoProfile -ExecutionPolicy Bypass -File installer-test.ps1 -Pkg D:\OpenDM-installer-test

Pkg folder: OpenDM-Setup-1.1.0.exe, OpenDM-Setup-2.0.0-published.exe, OpenDM_2.0.0_x64-setup.exe (the RC),
bench_server.exe, expected.json {old, published200, new, rcExe},
qa\cdp.mjs, qa\installer-check.mjs. Results go to <Pkg>\results\<user>-<time>\.
#>
param([Parameter(Mandatory)][string]$Pkg)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$OldSetup = Join-Path $Pkg 'OpenDM-Setup-1.1.0.exe'
$NewSetup = Join-Path $Pkg 'OpenDM_2.0.0_x64-setup.exe'  # the release candidate
$Pub200Setup = Join-Path $Pkg 'OpenDM-Setup-2.0.0-published.exe'
$Expected = Get-Content (Join-Path $Pkg 'expected.json') -Raw | ConvertFrom-Json
$Data = Join-Path $env:APPDATA 'OpenDM'
$WebData = Join-Path $env:LOCALAPPDATA 'com.opendm.app'
$Work = Join-Path $env:USERPROFILE 'odm-installer-test'
$Out = Join-Path $Pkg ("results\{0}-{1}" -f $env:USERNAME, (Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Force $Out | Out-Null
Start-Transcript -Path (Join-Path $Out 'transcript.txt') | Out-Null

$R = [ordered]@{ user = $env:USERNAME; computer = $env:COMPUTERNAME; started = (Get-Date).ToString('o'); steps = @() }
function Step($name, [bool]$ok, $detail = $null) {
    $R.steps += [ordered]@{ name = $name; ok = $ok; detail = $detail }
    Write-Host ("{0} {1} {2}" -f ($(if ($ok) { 'PASS' } else { 'FAIL' })), $name, ($detail | ConvertTo-Json -Compress -Depth 6))
}
function Entries {
    $keys = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
    @(Get-ItemProperty $keys -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match '^OpenDM' } |
        ForEach-Object { [ordered]@{ key = $_.PSChildName; name = $_.DisplayName; version = $_.DisplayVersion; location = ($_.InstallLocation -replace '"', ''); uninstall = $_.UninstallString; quiet = $_.QuietUninstallString; binary = $_.MainBinaryName; hive = ($_.PSPath -replace '^.*::', '' -replace '\\.*$', '') } })
}
function Shortcuts {
    $dirs = [Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('CommonPrograms'), [Environment]::GetFolderPath('CommonDesktopDirectory')
    $sh = New-Object -ComObject WScript.Shell
    @(foreach ($d in $dirs) { Get-ChildItem $d -Recurse -Filter '*.lnk' -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'OpenDM' } |
            ForEach-Object { [ordered]@{ path = $_.FullName; target = $sh.CreateShortcut($_.FullName).TargetPath } } })
}
function RunKeys {
    $k = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -ErrorAction SilentlyContinue
    if ($k) { @($k.PSObject.Properties | Where-Object { $_.Name -notmatch '^PS' -and "$($_.Value)" -match 'opendm' } | ForEach-Object { "$($_.Name)=$($_.Value)" }) } else { @() }
}
function Snapshot($label) {
    $s = [ordered]@{ entries = Entries; shortcuts = Shortcuts; run = RunKeys; dataDir = (Test-Path $Data); dataFiles = @(if (Test-Path $Data) { Get-ChildItem $Data -File | ForEach-Object Name }); webData = (Test-Path $WebData) }
    $s | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $Out "snapshot-$label.json")
    $s
}
function Stop-OpenDM {
    Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path -match '\\(opendm|OpenDM)[^\\]*\\[^\\]+\.exe$' -and $_.Path -like "$env:LOCALAPPDATA*" } | Stop-Process -Force -ErrorAction SilentlyContinue
}
function Wait-Gone($test, $sec = 120) {
    for ($i = 0; $i -lt $sec * 2; $i++) { if (-not (& $test)) { return $true }; Start-Sleep -Milliseconds 500 }
    $false
}
function Uninstall($entry) {
    # NSIS uninstallers copy themselves to %TEMP% and return at once: wait for the entry to go.
    $cmd = $entry.uninstall
    $exe = if ($cmd -match '^"([^"]+)"') { $Matches[1] } else { ($cmd -split ' /')[0] }
    Start-Process -FilePath $exe -ArgumentList '/S' -Wait
    Wait-Gone { Entries | Where-Object { $_.key -eq $entry.key } }
}
function Check($exe, $label, $extra = @()) {
    $json = Join-Path $Out "app-$label.json"
    & node (Join-Path $Pkg 'qa\installer-check.mjs') $exe $json @extra | Tee-Object -FilePath (Join-Path $Out "app-$label.txt") | Write-Host
    $ok = $LASTEXITCODE -eq 0
    $res = if (Test-Path $json) { Get-Content $json -Raw | ConvertFrom-Json } else { $null }
    Stop-OpenDM
    @{ ok = $ok; res = $res }
}

function UpgradeFrom($setup, $oldVersion, $label) {
    Start-Process $setup -ArgumentList '/S' -Wait
    Start-Sleep 5
    Stop-OpenDM  # some installers start the app after a silent install
    $s = Snapshot "$label-old-installed"
    $old = $s.entries | Where-Object { $_.version -eq $oldVersion } | Select-Object -First 1
    $oldExe = Get-ChildItem $old.location -Filter '*.exe' | Where-Object { $_.Name -notmatch 'uninstall' } | Select-Object -First 1
    $oldHash = (Get-FileHash $oldExe.FullName -Algorithm SHA256).Hash.ToLower()
    Step "${label}: install the published $oldVersion" ($null -ne $old -and $oldHash -ne $Expected.rcExe.ToLower()) @{ entry = $old; exe = $oldExe.FullName; sha256 = $oldHash; shortcuts = $s.shortcuts }

    # Data such a user has: a finished download, a half-finished one, and changed settings.
    $N = 64MB; $half = 24MB
    New-Item -ItemType Directory -Force "$Work\out", "$Work\tmp", $Data | Out-Null
    & curl.exe -s -o "$Work\out\done.bin" "$base/file/1048576"
    $pid2 = 'upgradeTestPaused01'
    $temp = "$Work\tmp\${pid2}_big.bin"
    & curl.exe -s -r "0-$($half - 1)" -o $temp "$base/file/$N"
    $sha = (& curl.exe -s "$base/hash/$N").Trim()
    $now = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
    $items = @(
        [ordered]@{ id = 'upgradeTestDone01'; url = "$base/file/1048576"; fileName = 'done.bin'; saveDir = "$Work\out"; category = 'general'; status = 'complete'; size = 1048576; downloaded = 1048576; resumable = $true; added = $now - 60000; completedAt = $now - 50000; savedPath = "$Work\out\done.bin"; maxConnections = 0; speedLimitKB = 0 },
        [ordered]@{ id = $pid2; url = "$base/file/$N"; fileName = 'big.bin'; saveDir = "$Work\out"; category = 'general'; status = 'paused'; size = $N; downloaded = $half; resumable = $true; added = $now; tempPath = $temp; segments = @([ordered]@{ start = 0; end = $N; pos = $half }); maxConnections = 0; speedLimitKB = 0 }
    )
    ConvertTo-Json -InputObject $items -Depth 6 | Set-Content "$Data\downloads.json" -Encoding UTF8
    [ordered]@{ firstRun = $false; general = @{ monitorClipboard = $false }; downloads = @{ showStartDialog = $false; showCompleteDialog = $false; progressDialog = 'none' }; connection = @{ maxConnections = 5 }; saveTo = @{ tempDir = "$Work\tmp" } } |
        ConvertTo-Json -Depth 6 | Set-Content "$Data\settings.json" -Encoding UTF8

    # Let the old version load and keep the data, as a user's last session would.
    $p = Start-Process $oldExe.FullName -PassThru
    Start-Sleep 15
    $oldAlive = -not $p.HasExited
    Stop-OpenDM
    $list = Get-Content "$Data\downloads.json" -Raw | ConvertFrom-Json
    Step "${label}: $oldVersion ran with the seeded data" ($oldAlive -and @($list).Count -eq 2) @{ items = @($list).Count }

    $t = Measure-Command { Start-Process $NewSetup -ArgumentList '/S' -Wait }
    $s = Snapshot "$label-upgraded"
    # The RC is also numbered 2.0.0, so it is told apart from the published 2.0.0 by its program file.
    $new = $s.entries | Where-Object { $_.location -and (Test-Path (Join-Path $_.location 'opendm.exe')) -and (Get-FileHash (Join-Path $_.location 'opendm.exe') -Algorithm SHA256).Hash.ToLower() -eq $Expected.rcExe.ToLower() } | Select-Object -First 1
    Step "${label}: upgrade installs the release candidate" ($null -ne $new) @{ seconds = [math]::Round($t.TotalSeconds, 1); entries = $s.entries }
    $others = @($s.entries | Where-Object { $_.key -ne $new.key })
    $oldLeft = (Test-Path $oldExe.FullName) -and ((Get-FileHash $oldExe.FullName -Algorithm SHA256).Hash.ToLower() -eq $oldHash)
    Step "${label}: upgrade replaces $oldVersion (no second copy left installed)" (-not $others.Count -and -not $oldLeft) @{ otherEntries = $others; oldExeStillThere = $oldLeft; shortcuts = $s.shortcuts; run = $s.run }
    $exe = Join-Path $new.location ($(if ($new.binary) { $new.binary } else { 'opendm.exe' }))
    $c = Check $exe $label @('--resume', $pid2, '--sha', $sha)
    $st = $c.res.state
    Step "${label}: keeps downloads and settings; the paused download resumes intact" ($c.ok -and @($st.items).Count -eq 2 -and $st.connection.maxConnections -eq 5) @{ state = $st }
}

try {
    # ---- 0. Safety and environment -------------------------------------------------------------
    $os = Get-CimInstance Win32_OperatingSystem
    $R.environment = [ordered]@{ os = $os.Caption; build = $os.BuildNumber; arch = $env:PROCESSOR_ARCHITECTURE; node = (& node --version); webview2 = (Get-ItemProperty 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}' -ErrorAction SilentlyContinue).pv }
    $pre = Snapshot 'before'
    if ($pre.entries.Count -or $pre.dataDir -or (Test-Path $WebData)) {
        throw "This account already has OpenDM installed or an OpenDM data folder. Use a fresh test account."
    }
    Step 'clean test account' $true $R.environment

    # ---- 1. Integrity --------------------------------------------------------------------------
    foreach ($p in @(@{ f = $OldSetup; want = $Expected.old }, @{ f = $Pub200Setup; want = $Expected.published200 }, @{ f = $NewSetup; want = $Expected.new })) {
        $h = (Get-FileHash $p.f -Algorithm SHA256).Hash.ToLower()
        $sig = Get-AuthenticodeSignature $p.f
        Step "sha256 $(Split-Path $p.f -Leaf)" ($h -eq $p.want.ToLower()) @{ sha256 = $h; expected = $p.want; signature = "$($sig.Status)"; signer = "$($sig.SignerCertificate.Subject)" }
    }

    # ---- 2. Clean install of 2.0.0 ---------------------------------------------------------------
    $t = Measure-Command { Start-Process $NewSetup -ArgumentList '/S' -Wait }
    $s = Snapshot 'clean-installed'
    $e = $s.entries | Where-Object { $_.version -eq '2.0.0' } | Select-Object -First 1
    $dir = $e.location
    $files = @('opendm.exe', 'uninstall.exe', 'ffmpeg\ffmpeg.exe', 'extension\manifest.json') | ForEach-Object { @{ f = $_; ok = (Test-Path (Join-Path $dir $_)) } }
    Step 'clean install' ($null -ne $e -and -not ($files | Where-Object { -not $_.ok })) @{ seconds = [math]::Round($t.TotalSeconds, 1); entry = $e; files = $files; shortcuts = $s.shortcuts }
    $exe = Join-Path $dir ($(if ($e.binary) { $e.binary } else { 'opendm.exe' }))
    Step 'installed binary is the release candidate' ((Get-FileHash $exe -Algorithm SHA256).Hash.ToLower() -eq $Expected.rcExe.ToLower()) @{ path = $exe; sha256 = (Get-FileHash $exe -Algorithm SHA256).Hash.ToLower(); version = (Get-Item $exe).VersionInfo.ProductVersion }
    $c = Check $exe 'clean'
    Step 'clean install runs with defaults' ($c.ok -and $c.res.state.items.Count -eq 0) @{ state = $c.res.state }
    $s = Snapshot 'clean-ran'
    Step 'first run created the data folder' $s.dataDir @{ files = $s.dataFiles }

    # ---- 3. Uninstall 2.0.0 --------------------------------------------------------------------
    $gone = Uninstall $e
    $s = Snapshot 'clean-uninstalled'
    Step 'uninstall removes the app' ($gone -and -not (Test-Path $exe) -and -not ($s.shortcuts | Where-Object { $_.target -like "$dir*" })) @{ dirLeft = (Test-Path $dir); shortcuts = $s.shortcuts; entries = $s.entries }
    Step 'uninstall keeps the download list' $s.dataDir @{ files = $s.dataFiles; webData = $s.webData }
    Remove-Item $Data, $WebData -Recurse -Force -ErrorAction SilentlyContinue  # this test account's own data only

    $srv = Start-Process (Join-Path $Pkg 'bench_server.exe') -PassThru -RedirectStandardOutput (Join-Path $Out 'server.out') -WindowStyle Hidden
    for ($i = 0; $i -lt 100 -and -not (Select-String -Path (Join-Path $Out 'server.out') -Pattern 'PORT' -Quiet -ErrorAction SilentlyContinue); $i++) { Start-Sleep -Milliseconds 200 }
    $port = ((Get-Content (Join-Path $Out 'server.out')) -match 'PORT' -replace 'PORT ', '')[0]
    $script:base = "http://127.0.0.1:$port"

    # ---- 4. Upgrades: from the published 1.1.0 (Electron) and the published 2.0.0 (Tauri) --------
    UpgradeFrom $OldSetup '1.1.0' 'from-1.1.0'
    Stop-OpenDM
    foreach ($x in Entries) { [void](Uninstall $x) }
    Remove-Item $Data, $WebData, $Work -Recurse -Force -ErrorAction SilentlyContinue  # this test account's own data only
    UpgradeFrom $Pub200Setup '2.0.0' 'from-2.0.0'

    # ---- 5. Clean up this test account ---------------------------------------------------------
    Stop-OpenDM
    foreach ($x in Entries) { [void](Uninstall $x) }
    Stop-Process -Id $srv.Id -Force -ErrorAction SilentlyContinue
    $s = Snapshot 'after-cleanup'
    Step 'all test installs removed' (-not $s.entries.Count) @{ entries = $s.entries; shortcuts = $s.shortcuts; run = $s.run }
    Remove-Item $Data, $WebData, $Work -Recurse -Force -ErrorAction SilentlyContinue
} catch {
    Step 'run' $false @{ error = "$_"; at = "$($_.InvocationInfo.PositionMessage)" }
} finally {
    $R.finished = (Get-Date).ToString('o')
    $R.ok = -not ($R.steps | Where-Object { -not $_.ok })
    $R | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $Out 'results.json')
    Stop-Transcript | Out-Null
    Write-Host "`nResults: $Out\results.json  (overall: $(if ($R.ok) { 'PASS' } else { 'FAIL' }))"
}
