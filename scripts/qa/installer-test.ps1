<#
OpenDM installer test: clean install, uninstall, and the upgrade from the published 2.0.0 (Tauri)
to the new release. (Direct upgrades from the Electron 1.1.0 are no longer supported or tested:
those users uninstall 1.1.0 first.)

Run ONLY in a dedicated Windows test account: it installs and uninstalls OpenDM for the current
user and deletes this account's %APPDATA%\OpenDM between steps. It refuses to start if this account
already has OpenDM installed or an OpenDM data folder.

  powershell -NoProfile -ExecutionPolicy Bypass -File installer-test.ps1 -Pkg C:\Users\Public\OpenDM-installer-test

Pkg folder: the new installer (expected.json "newSetup"), OpenDM-Setup-2.0.0-published.exe,
bench_server.exe, expected.json {version, newSetup, new, newExe, published200},
qa\cdp.mjs, qa\installer-check.mjs. Results go to <Pkg>\results\<user>-<time>\.
#>
param([Parameter(Mandatory)][string]$Pkg)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Expected = Get-Content (Join-Path $Pkg 'expected.json') -Raw | ConvertFrom-Json
$Version = $Expected.version
$NewSetup = Join-Path $Pkg $Expected.newSetup
$Pub200Setup = Join-Path $Pkg 'OpenDM-Setup-2.0.0-published.exe'
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
function Sha($f) { (Get-FileHash $f -Algorithm SHA256).Hash.ToLower() }
function Entries {
    $keys = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*'
    @(Get-ItemProperty $keys -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match '^OpenDM' } |
        ForEach-Object { [ordered]@{ key = $_.PSChildName; name = $_.DisplayName; version = $_.DisplayVersion; publisher = $_.Publisher; location = ($_.InstallLocation -replace '"', ''); uninstall = $_.UninstallString; quiet = $_.QuietUninstallString; binary = $_.MainBinaryName; hive = ($_.PSPath -replace '^.*::', '' -replace '\\.*$', '') } })
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
    # @(): PowerShell returns a one-item list as the bare item, whose .Count is its field count.
    $s = [ordered]@{ entries = @(Entries); shortcuts = @(Shortcuts); run = @(RunKeys); dataDir = (Test-Path $Data); dataFiles = @(if (Test-Path $Data) { Get-ChildItem $Data -File | ForEach-Object Name }); webData = (Test-Path $WebData) }
    $s | ConvertTo-Json -Depth 6 | Set-Content (Join-Path $Out "snapshot-$label.json")
    $s
}
function AppProcs { @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path -match '\\(opendm|OpenDM)[^\\]*\\[^\\]+\.exe$' -and $_.Path -like "$env:LOCALAPPDATA*" }) }
function Stop-OpenDM { AppProcs | Stop-Process -Force -ErrorAction SilentlyContinue }
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
# The installed program, its Installed Apps entry and its shortcuts, for the new version.
function CheckInstalled($s, $label) {
    $e = @($s.entries | Where-Object { $_.version -eq $Version })
    $entry = $e | Select-Object -First 1
    $dir = $entry.location
    if (-not $dir) { Step "${label}: Installed Apps entry for $Version" $false @{ entries = $s.entries }; return $null }
    $exe = Join-Path $dir ($(if ($entry.binary) { $entry.binary } else { 'opendm.exe' }))
    Step "${label}: one Installed Apps entry, version $Version, publisher 'OpenDM contributors'" ($s.entries.Count -eq 1 -and $entry.publisher -eq 'OpenDM contributors') @{ entries = $s.entries }
    $files = @('opendm.exe', 'uninstall.exe', 'ffmpeg\ffmpeg.exe', 'extension\manifest.json', 'extension\background.js') | ForEach-Object { [ordered]@{ f = $_; ok = (Test-Path (Join-Path $dir $_)) } }
    Step "${label}: required files" (-not ($files | Where-Object { -not $_.ok })) @{ dir = $dir; files = $files }
    $vi = (Get-Item $exe).VersionInfo
    $h = Sha $exe
    Step "${label}: installed opendm.exe is the packaged release binary" ($h -eq $Expected.newExe.ToLower()) @{ path = $exe; sha256 = $h; expected = $Expected.newExe }
    Step "${label}: opendm.exe version metadata is $Version" ($vi.ProductVersion -like "$Version*" -and $vi.FileVersion -like "$Version*" -and $vi.ProductName -eq 'OpenDM') @{ product = $vi.ProductVersion; file = $vi.FileVersion; name = $vi.ProductName; description = $vi.FileDescription }
    $menu = @($s.shortcuts | Where-Object { $_.path -like "$([Environment]::GetFolderPath('Programs'))*" })
    $desk = @($s.shortcuts | Where-Object { $_.path -like "$([Environment]::GetFolderPath('Desktop'))*" })
    Step "${label}: one Start menu and one desktop shortcut, both to the installed exe" ($menu.Count -eq 1 -and $desk.Count -eq 1 -and $s.shortcuts.Count -eq 2 -and -not ($s.shortcuts | Where-Object { $_.target -ne $exe })) @{ shortcuts = $s.shortcuts }
    @{ entry = $entry; dir = $dir; exe = $exe }
}
# Starts the app the way a user would, from each shortcut, and checks the installed exe runs.
function CheckShortcuts($s, $exe, $label) {
    foreach ($l in $s.shortcuts) {
        Stop-OpenDM
        Start-Process $l.path
        $up = Wait-Gone { -not (AppProcs | Where-Object { $_.Path -eq $exe }) } 30  # true once it is running
        Start-Sleep 3
        $still = [bool](AppProcs | Where-Object { $_.Path -eq $exe })
        Step "${label}: shortcut starts the app ($(Split-Path $l.path -Leaf) in $(Split-Path (Split-Path $l.path) -Leaf))" ($up -and $still) @{ shortcut = $l.path }
        Stop-OpenDM
    }
}
# Uninstalls while the app is running (as a user might), then checks nothing is left behind.
function CheckUninstall($inst, $label) {
    $p = Start-Process $inst.exe -PassThru
    Start-Sleep 8
    $wasRunning = -not $p.HasExited
    $gone = Uninstall $inst.entry
    $procsGone = Wait-Gone { AppProcs } 30
    $s = Snapshot "$label-uninstalled"
    Step "${label}: uninstall removes the program, entry and shortcuts" ($gone -and -not (Test-Path $inst.exe) -and -not $s.entries.Count -and -not $s.shortcuts.Count) @{ dirLeft = (Test-Path $inst.dir); exeLeft = (Test-Path $inst.exe); shortcuts = $s.shortcuts; entries = $s.entries; run = $s.run }
    Step "${label}: no OpenDM process left running after uninstall" ($wasRunning -and $procsGone) @{ appWasRunning = $wasRunning; left = @(AppProcs | ForEach-Object Path) }
    $s
}

# ---- Local test server (bench_server.exe): every failure is reported, never read as an empty value ----
function Start-TestServer {
    $so = Join-Path $Out 'server.out'; $se = Join-Path $Out 'server.err'
    $script:srv = Start-Process (Join-Path $Pkg 'bench_server.exe') -PassThru -RedirectStandardOutput $so -RedirectStandardError $se -WindowStyle Hidden
    $port = $null
    for ($i = 0; $i -lt 150 -and -not $port; $i++) {
        if ($srv.HasExited) { throw "bench_server.exe exited at start (code $($srv.ExitCode)). stderr: $(Get-Content $se -Raw -ErrorAction SilentlyContinue)" }
        # It prints "PORT <n>" once listening. (The old script read a one-line file with -match, which
        # returns $true, not the line, so the "port" became "T" and every request failed.)
        $m = Select-String -Path $so -Pattern '^PORT (\d+)\s*$' -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($m) { $port = [int]$m.Matches[0].Groups[1].Value } else { Start-Sleep -Milliseconds 200 }
    }
    if (-not $port) { throw "bench_server.exe printed no port within 30 s. stdout: $(Get-Content $so -Raw -ErrorAction SilentlyContinue) stderr: $(Get-Content $se -Raw -ErrorAction SilentlyContinue)" }
    $script:base = "http://127.0.0.1:$port"
    $h = ServerHash 16
    Step 'test server answers' $true @{ base = $base; pid = $srv.Id; hash16 = $h }
}
# curl.exe with a timeout; throws with curl's exit code, the HTTP status and stderr on any failure.
function Http($what, [string[]]$curlArgs) {
    if ($srv.HasExited) { throw "bench_server.exe has exited (code $($srv.ExitCode)) before: $what" }
    $err = Join-Path $Out 'curl.err'
    $o = & curl.exe -sS --connect-timeout 10 --max-time 300 --stderr $err -w '%{http_code}' @curlArgs
    $rc = $LASTEXITCODE
    $text = "$o"
    $status = if ($text.Length -ge 3) { $text.Substring($text.Length - 3) } else { '' }
    if ($rc -ne 0 -or $status -notmatch '^2\d\d$') {
        throw "$what failed: curl exit $rc, HTTP status '$status', server running: $(-not $srv.HasExited), curl stderr: $(Get-Content $err -Raw -ErrorAction SilentlyContinue)"
    }
    $text.Substring(0, $text.Length - 3)
}
function ServerHash($n) {
    $h = (Http "GET $base/hash/$n" @("$base/hash/$n")).Trim()
    if ($h -notmatch '^[0-9a-f]{64}$') { throw "GET $base/hash/$n returned '$h', not a SHA-256" }
    $h
}
function Fetch($path, $file, $range = $null, $wantBytes) {
    $a = @('-o', $file); if ($range) { $a += @('-r', $range) }
    [void](Http "GET $base$path" ($a + "$base$path"))
    $len = (Get-Item $file).Length
    if ($len -ne $wantBytes) { throw "GET $base$path saved $len bytes, expected $wantBytes" }
}

function UpgradeFrom200 {
    $label = 'from-2.0.0'
    Start-Process $Pub200Setup -ArgumentList '/S' -Wait
    Start-Sleep 5
    Stop-OpenDM  # some installers start the app after a silent install
    $s = Snapshot "$label-old-installed"
    $old = $s.entries | Where-Object { $_.version -eq '2.0.0' } | Select-Object -First 1
    if (-not $old -or -not $old.location) { Step "${label}: install the published 2.0.0" $false @{ entries = $s.entries }; return }
    $oldExe = Join-Path $old.location ($(if ($old.binary) { $old.binary } else { 'opendm.exe' }))
    $oldHash = if (Test-Path $oldExe) { Sha $oldExe } else { $null }
    Step "${label}: install the published 2.0.0" ($oldHash -and $oldHash -ne $Expected.newExe.ToLower()) @{ entry = $old; exe = $oldExe; sha256 = $oldHash; version = (Get-Item $oldExe).VersionInfo.ProductVersion; shortcuts = $s.shortcuts }

    # A user's data: a finished download (a History entry), a half-finished one, changed settings.
    $N = 64MB; $half = 24MB
    New-Item -ItemType Directory -Force "$Work\out", "$Work\tmp", $Data | Out-Null
    Fetch '/file/1048576' "$Work\out\done.bin" $null 1048576
    $pid2 = 'upgradeTestPaused01'
    $temp = "$Work\tmp\${pid2}_big.bin"
    Fetch "/file/$N" $temp "0-$($half - 1)" $half
    $sha = ServerHash $N
    $now = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
    $items = @(
        [ordered]@{ id = 'upgradeTestDone01'; url = "$base/file/1048576"; fileName = 'done.bin'; saveDir = "$Work\out"; category = 'general'; status = 'complete'; size = 1048576; downloaded = 1048576; resumable = $true; added = $now - 60000; completedAt = $now - 50000; savedPath = "$Work\out\done.bin"; maxConnections = 0; speedLimitKB = 0 },
        [ordered]@{ id = $pid2; url = "$base/file/$N"; fileName = 'big.bin'; saveDir = "$Work\out"; category = 'general'; status = 'paused'; size = $N; downloaded = $half; resumable = $true; added = $now; tempPath = $temp; segments = @([ordered]@{ start = 0; end = $N; pos = $half }); maxConnections = 0; speedLimitKB = 0 }
    )
    # UTF-8 without a byte-order mark, as OpenDM writes them (Set-Content -Encoding UTF8 adds one in PowerShell 5).
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [IO.File]::WriteAllText("$Data\downloads.json", (ConvertTo-Json -InputObject $items -Depth 6), $utf8)
    [IO.File]::WriteAllText("$Data\settings.json", ([ordered]@{ firstRun = $false; general = @{ monitorClipboard = $false }; downloads = @{ showStartDialog = $false; showCompleteDialog = $false; progressDialog = 'none' }; connection = @{ maxConnections = 5 }; saveTo = @{ tempDir = "$Work\tmp" } } | ConvertTo-Json -Depth 6), $utf8)

    # Let 2.0.0 load and keep the data, as a user's last session would.
    $p = Start-Process $oldExe -PassThru
    Start-Sleep 15
    $oldAlive = -not $p.HasExited
    Stop-OpenDM
    $list = Get-Content "$Data\downloads.json" -Raw | ConvertFrom-Json
    Step "${label}: 2.0.0 ran with the seeded data" ($oldAlive -and @($list).Count -eq 2) @{ items = @($list).Count }

    $t = Measure-Command { Start-Process $NewSetup -ArgumentList '/S' -Wait }
    Start-Sleep 3
    Stop-OpenDM
    $s = Snapshot "$label-upgraded"
    $inst = CheckInstalled $s $label
    if (-not $inst) { return }
    Step "${label}: upgraded in place (same entry and folder, no second copy)" ($inst.entry.key -eq $old.key -and $inst.dir -eq $old.location -and $s.entries.Count -eq 1) @{ seconds = [math]::Round($t.TotalSeconds, 1); old = $old; new = $inst.entry }
    Step "${label}: no duplicate startup entries" ($s.run.Count -le 1) @{ run = $s.run }
    $c = Check $inst.exe $label @('--resume', $pid2, '--sha', $sha)
    $st = $c.res.state
    $done = @($st.items) | Where-Object { $_.id -eq 'upgradeTestDone01' }
    Step "${label}: app reports $Version" ($st.version -eq $Version) @{ version = $st.version }
    Step "${label}: keeps downloads, History and settings; the paused download resumes intact" ($c.ok -and @($st.items).Count -eq 2 -and $done.status -eq 'complete' -and $st.connection.maxConnections -eq 5) @{ state = $st }
    CheckShortcuts $s $inst.exe $label

    $s = CheckUninstall $inst $label
    $list = if (Test-Path "$Data\downloads.json") { @(Get-Content "$Data\downloads.json" -Raw | ConvertFrom-Json) } else { @() }
    Step "${label}: uninstall keeps the user's downloads and settings" ($list.Count -eq 2 -and (Test-Path "$Data\settings.json")) @{ files = $s.dataFiles; items = $list.Count }
}

try {
    # ---- 0. Safety and environment -------------------------------------------------------------
    $os = Get-CimInstance Win32_OperatingSystem
    $admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    $R.environment = [ordered]@{ os = $os.Caption; build = $os.BuildNumber; arch = $env:PROCESSOR_ARCHITECTURE; elevated = $admin; node = (& node --version); webview2 = (Get-ItemProperty 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}' -ErrorAction SilentlyContinue).pv }
    $pre = Snapshot 'before'
    $found = @(
        $pre.entries | ForEach-Object { "installed: $($_.name) $($_.version)" }
        AppProcs | ForEach-Object { "running: $($_.Path)" }
        if ($pre.dataDir) { "data folder: $Data" }
        if (Test-Path $WebData) { "WebView data: $WebData" }
        if (Test-Path $Work) { "previous test files: $Work" }
    )
    if ($found.Count) {
        throw "Not a clean test account. Remove these (in this test account only), then run again: $($found -join '; ')"
    }
    Step 'clean test account' $true $R.environment

    # ---- 1. Integrity --------------------------------------------------------------------------
    foreach ($p in @(@{ f = $Pub200Setup; want = $Expected.published200 }, @{ f = $NewSetup; want = $Expected.new })) {
        $h = Sha $p.f
        $sig = Get-AuthenticodeSignature $p.f
        Step "sha256 $(Split-Path $p.f -Leaf)" ($h -eq $p.want.ToLower()) @{ sha256 = $h; expected = $p.want }
        # Unsigned is expected for this beta; a present-but-broken signature is a failure.
        Step "signature $(Split-Path $p.f -Leaf)" ("$($sig.Status)" -in 'Valid', 'NotSigned') @{ signature = "$($sig.Status)"; signer = "$($sig.SignerCertificate.Subject)" }
    }
    $iv = (Get-Item $NewSetup).VersionInfo
    Step "installer version metadata is $Version" ($iv.ProductVersion -like "$Version*") @{ product = $iv.ProductVersion; file = $iv.FileVersion; name = $iv.ProductName }

    # ---- 2. Clean install ----------------------------------------------------------------------
    $t = Measure-Command { Start-Process $NewSetup -ArgumentList '/S' -Wait }
    Start-Sleep 3
    Stop-OpenDM
    $s = Snapshot 'clean-installed'
    Step 'clean install' ($s.entries.Count -eq 1) @{ seconds = [math]::Round($t.TotalSeconds, 1); entries = $s.entries }
    $inst = CheckInstalled $s 'clean'
    if (-not $inst) { throw 'clean install produced no usable entry' }
    $c = Check $inst.exe 'clean'
    Step 'clean: app reports the new version' ($c.res.state.version -eq $Version) @{ version = $c.res.state.version }
    Step 'clean: runs with default settings and an empty list' ($c.ok -and @($c.res.state.items).Count -eq 0 -and $c.res.state.connection.maxConnections -eq 8) @{ state = $c.res.state }
    $s2 = Snapshot 'clean-ran'
    Step 'clean: first run created the data folder' ($s2.dataDir -and $s2.dataFiles -contains 'settings.json') @{ files = $s2.dataFiles }
    CheckShortcuts $s $inst.exe 'clean'

    # ---- 3. Uninstall --------------------------------------------------------------------------
    $s = CheckUninstall $inst 'clean'
    Step 'clean: uninstall keeps the data folder' $s.dataDir @{ files = $s.dataFiles; webData = $s.webData }
    Remove-Item $Data, $WebData -Recurse -Force -ErrorAction SilentlyContinue  # this test account's own data only

    # ---- 4. Upgrade from the published 2.0.0 ---------------------------------------------------
    Start-TestServer
    UpgradeFrom200

    # ---- 5. Clean up this test account ---------------------------------------------------------
    Stop-OpenDM
    foreach ($x in Entries) { [void](Uninstall $x) }
    $s = Snapshot 'after-cleanup'
    Step 'all test installs removed' (-not $s.entries.Count -and -not $s.shortcuts.Count) @{ entries = $s.entries; shortcuts = $s.shortcuts; run = $s.run }
    Remove-Item $Data, $WebData, $Work -Recurse -Force -ErrorAction SilentlyContinue  # this test account's own data only
} catch {
    Step 'run' $false @{ error = "$_"; at = "$($_.InvocationInfo.PositionMessage)" }
} finally {
    if ($script:srv -and -not $srv.HasExited) { Stop-Process -Id $srv.Id -Force -ErrorAction SilentlyContinue }
    $R.finished = (Get-Date).ToString('o')
    $R.ok = -not ($R.steps | Where-Object { -not $_.ok })
    $R | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $Out 'results.json')
    Stop-Transcript | Out-Null
    Write-Host "`nResults: $Out\results.json  (overall: $(if ($R.ok) { 'PASS' } else { 'FAIL' }))"
}
