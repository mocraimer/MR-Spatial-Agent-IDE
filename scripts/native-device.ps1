param(
    [Parameter(Mandatory=$true)][ValidateSet('Inspect','Install','Launch','Capture','Reverse','Tap','Key','Text','Diagnose')][string]$Mode,
    [Parameter(Mandatory=$true)][string]$Serial,
    [string]$Adb = 'C:\Program Files\Unity\Hub\Editor\6000.6.0f1\Editor\Data\PlaybackEngines\AndroidPlayer\SDK\platform-tools\adb.exe',
    [int]$X, [int]$Y,
    [ValidateSet('KEYCODE_ENTER','KEYCODE_F1','KEYCODE_BACK')][string]$Key = 'KEYCODE_ENTER',
    [string]$PrivateTextFile
)
$ErrorActionPreference = 'Stop'
$package = 'local.spatial.workspace'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\native'))
$evidence = Join-Path $root ('artifacts\device-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
New-Item -ItemType Directory -Force $evidence | Out-Null
if (!(Test-Path $Adb)) { throw 'Installed Unity Android ADB was not found.' }
$script:index = 0
function Invoke-Adb([string[]]$Words) {
    $script:index++
    $out = Join-Path $evidence ("adb-$script:index.stdout.txt")
    $err = Join-Path $evidence ("adb-$script:index.stderr.txt")
    # Isolate ADB server handles from WSL's inherited pipes. Never log arguments: Text may carry a setup secret.
    $arguments = ($Words | ForEach-Object { '"' + $_.Replace('"','\"') + '"' }) -join ' '
    $p = Start-Process -FilePath $Adb -ArgumentList $arguments -PassThru -RedirectStandardOutput $out -RedirectStandardError $err -WindowStyle Hidden
    $null = $p.Handle
    if (!$p.WaitForExit(90000)) { $p.Kill(); throw "ADB did not finish. Evidence: $evidence" }
    $p.Refresh()
    if ($null -eq $p.ExitCode -or $p.ExitCode -ne 0) { throw "ADB failed with exit $($p.ExitCode). Evidence: $evidence" }
    return [IO.File]::ReadAllText($out)
}
$devices = Invoke-Adb @('devices','-l')
[IO.File]::WriteAllText((Join-Path $evidence 'devices.txt'),$devices)
$line = $devices -split "`n" | Where-Object { $_ -match ('^' + [regex]::Escape($Serial) + '\s+device\s') }
if (!$line -or $line -notmatch 'model:Quest_3') { throw 'Selected Quest 3 is not ADB-authorized. Device permission is BLOCKED; do not bypass it.' }
function Device([string[]]$Words) { return Invoke-Adb (@('-s',$Serial) + $Words) }
function Assert-AppForeground {
    $activity = Device @('shell','dumpsys','activity','activities')
    # Retain only our activity lines, not the owner's other app inventory.
    $ours = ($activity -split "`n" | Where-Object { $_ -match [regex]::Escape($package) }) -join "`n"
    [IO.File]::WriteAllText((Join-Path $evidence 'own-activity.txt'),$ours)
    # Do not retain the full dumpsys listing in exports.
    Get-ChildItem $evidence -Filter 'adb-*.stdout.txt' | Where-Object { $_.Name -eq "adb-$script:index.stdout.txt" } | ForEach-Object { [IO.File]::WriteAllText($_.FullName,$ours) }
    if ($activity -notmatch ('(?m)^.*(?:m?ResumedActivity|topResumedActivity|Resumed:).*' + [regex]::Escape($package))) {
        throw 'Owned app is not resumed. Capture/input BLOCKED; no other application is captured or operated.'
    }
}
function Assert-AppFocus {
    Assert-AppForeground
    $window = Device @('shell','dumpsys','window')
    $focus = ($window -split "`n" | Where-Object { $_ -match 'mCurrentFocus|mFocusedApp' }) -join "`n"
    [IO.File]::WriteAllText((Join-Path $evidence 'own-window-focus.txt'),$focus)
    [IO.File]::WriteAllText((Join-Path $evidence "adb-$script:index.stdout.txt"),$focus)
    if ($focus -notmatch ('(?m)^.*mCurrentFocus.*' + [regex]::Escape($package))) { throw 'App window focus unproven. Capture/input BLOCKED; no other surface is operated.' }
}
switch ($Mode) {
    'Inspect' {
        Device @('shell','pm','list','packages',$package) | Out-Null
        Device @('shell','getprop','ro.build.version.release') | Out-Null
        Device @('shell','getprop','ro.product.model') | Out-Null
    }
    'Diagnose' {
        $appPid = (Device @('shell','pidof',$package)).Trim()
        if ($appPid -notmatch '^\d+$') { throw 'Owned app process is absent; device boot evidence is BLOCKED.' }
        Device @('logcat','-d',("--pid=" + $appPid),'-v','threadtime') | Out-Null
        Device @('shell','dumpsys','package',$package) | Out-Null
        $installed = (Device @('shell','pm','path',$package)).Trim()
        if ($installed -notmatch '^package:(/data/app/[A-Za-z0-9/_.+=~-]+/base\.apk)$') { throw 'Owned installed APK path is ambiguous.' }
        $installedHash = Device @('shell','sha256sum',$Matches[1])
        [IO.File]::WriteAllText((Join-Path $evidence 'installed-apk-sha256.txt'),$installedHash)
        [IO.File]::WriteAllText((Join-Path $evidence 'own-pid.txt'),$appPid)
    }
    'Install' {
        $apk = Join-Path $root 'artifacts\spatial-workspace.apk'
        if (!(Test-Path $apk)) { throw 'APK missing; run native-build.ps1 -Mode Build first.' }
        # Fixed package is inspected before update; -r preserves app data and signing-key checks.
        $aapt = Join-Path (Split-Path (Split-Path $Adb)) 'build-tools\36.0.0\aapt.exe'
        if (!(Test-Path $aapt)) { throw 'Installed SDK aapt identity checker unavailable.' }
        $identity = & $aapt dump badging $apk
        if ($LASTEXITCODE -ne 0 -or ($identity -join "`n") -notmatch "(?m)^package: name='local\.spatial\.workspace'") { throw 'APK identity is not the owned app.' }
        [IO.File]::WriteAllLines((Join-Path $evidence 'apk-identity.txt'),$identity)
        Get-FileHash -Algorithm SHA256 $apk | ConvertTo-Json | Set-Content (Join-Path $evidence 'apk-hash.json')
        $result = Device @('install','-r',$apk)
        if ($result -notmatch 'Success') { throw 'APK install/update did not report Success.' }
        Device @('shell','dumpsys','package',$package) | Out-Null
    }
    'Launch' { Device @('shell','am','start','-n',($package + '/com.unity3d.player.UnityPlayerGameActivity')) | Out-Null }
    'Reverse' {
        # Windows->WSL forwarding must be established without changing firewall/portproxy settings.
        $health = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:47844/v1/health'
        $state = $health.Content | ConvertFrom-Json
        if ($health.StatusCode -ne 200 -or $state.protocolVersion -ne 1 -or $state.state -ne 'listening') { throw 'Windows localhost cannot reach the owned host.' }
        [IO.File]::WriteAllText((Join-Path $evidence 'windows-host-health.json'),$health.Content)
        $setup = (Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:47844/setup').Content | ConvertFrom-Json
        $expected = $setup.fingerprint.Replace(':','').ToLowerInvariant()
        $tcp = New-Object Net.Sockets.TcpClient
        $tcp.Connect('127.0.0.1',47843)
        $verify = [Net.Security.RemoteCertificateValidationCallback]{ param($sender,$cert,$chain,$errors)
            $hash = [Security.Cryptography.SHA256]::Create()
            try { return ([BitConverter]::ToString($hash.ComputeHash($cert.GetRawCertData())).Replace('-','').ToLowerInvariant() -eq $expected) } finally { $hash.Dispose() }
        }
        $tls = New-Object Net.Security.SslStream($tcp.GetStream(),$false,$verify)
        try {
            $tls.ReadTimeout=5000; $tls.WriteTimeout=5000; $tls.AuthenticateAsClient('127.0.0.1')
            $request=[Text.Encoding]::ASCII.GetBytes("GET /v1/health HTTP/1.1`r`nHost: 127.0.0.1:47843`r`nConnection: close`r`n`r`n")
            $tls.Write($request,0,$request.Length)
            $reader=New-Object IO.StreamReader($tls)
            $response=$reader.ReadToEnd()
            if ($response -notmatch '^HTTP/1.1 200' -or $response -notmatch '"state":"listening"') { throw 'Pinned native HTTPS health proof failed.' }
            [IO.File]::WriteAllText((Join-Path $evidence 'windows-native-health.txt'),$response)
        } finally { $tls.Dispose();$tcp.Dispose();$setup=$null;$expected=$null }
        Device @('reverse','tcp:47843','tcp:47843') | Out-Null
        Device @('reverse','--list') | Out-Null
    }
    'Capture' {
        Assert-AppFocus
        $remote = '/data/local/tmp/local.spatial.workspace-capture.png'
        Device @('shell','screencap','-p',$remote) | Out-Null
        Device @('pull',$remote,(Join-Path $evidence 'app-screen.png')) | Out-Null
        Device @('shell','rm',$remote) | Out-Null
    }
    'Tap' { Assert-AppFocus; Device @('shell','input','tap',"$X","$Y") | Out-Null }
    'Key' { Assert-AppFocus; Device @('shell','input','keyevent',$Key) | Out-Null }
    'Text' {
        Assert-AppFocus
        if (!(Test-Path $PrivateTextFile)) { throw 'Private setup text file is required. Never put pairing secrets into command logs.' }
        $text = [IO.File]::ReadAllText($PrivateTextFile).Trim()
        # Setup origin, fingerprint and code are ASCII; shell metacharacters are never accepted.
        if ($text -notmatch '^[A-Za-z0-9:/._ -]+$') { throw 'Setup text contains unsupported shell characters; use the native keyboard.' }
        Device @('shell','input','text',$text.Replace(' ','%s')) | Out-Null
        $text = $null
    }
}
[IO.File]::WriteAllText((Join-Path $evidence 'operation.json'),(@{mode=$Mode;package=$package;serial=$Serial;at=(Get-Date).ToUniversalTime().ToString('o')} | ConvertTo-Json))
Write-Output "Owned-app $Mode finished. Evidence: $evidence"
