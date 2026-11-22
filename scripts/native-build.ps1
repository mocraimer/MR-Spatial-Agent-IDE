param(
    [ValidateSet('Compile','Configure','Build','EditMode','PlayMode')][string]$Mode = 'Build',
    [string]$Unity = 'C:\Program Files\Unity\Hub\Editor\6000.6.0f1\Editor\Unity.exe'
)
$ErrorActionPreference = 'Stop'
$project = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\native'))
$artifacts = Join-Path $project 'artifacts'
New-Item -ItemType Directory -Force -Path $artifacts | Out-Null
if (!(Test-Path $Unity)) { throw "Unity editor not found at $Unity" }
$log = Join-Path $artifacts ($Mode.ToLowerInvariant() + '.log')
$args = @('-batchmode','-nographics','-projectPath',$project,'-logFile',$log)
if ($Mode -in @('EditMode','PlayMode')) {
    $results = Join-Path $artifacts ($Mode.ToLowerInvariant() + '-results.xml')
    if (Test-Path $results) { Remove-Item $results }
    $args += @('-runTests','-testPlatform',$Mode,'-testResults',$results)
} else {
    $method = @{Compile='CompileCheck';Configure='Configure';Build='BuildAndroid'}[$Mode]
    $args += @('-quit','-buildTarget','Android','-executeMethod',('Spatial.Native.Editor.QuestBuild.' + $method))
}
# Start-Process quotes arguments explicitly; Windows PowerShell does not preserve spaces in an argument array.
$arguments = ($args | ForEach-Object { '"' + $_.Replace('"','\"') + '"' }) -join ' '
$process = Start-Process -FilePath $Unity -ArgumentList $arguments -Wait -PassThru
if ($process.ExitCode -ne 0) { throw "Unity $Mode failed with exit $($process.ExitCode). See $log" }
if ($Mode -in @('EditMode','PlayMode')) {
    if (!(Test-Path $results)) { throw 'Unity did not produce test evidence.' }
    [xml]$report = Get-Content -Raw $results
    if ($report.'test-run'.result -ne 'Passed' -or [int]$report.'test-run'.total -lt 1) { throw "Native tests failed or no tests ran. See $results" }
}
if ($Mode -eq 'Build') {
    $apk = Join-Path $artifacts 'spatial-workspace.apk'
    if (!(Test-Path $apk)) { throw 'Successful build did not produce APK.' }
    Get-FileHash -Algorithm SHA256 $apk | Format-List
}
Write-Output "Native $Mode passed. Log: $log"
