# screenpipe — AI that knows everything you've seen, said, or heard
# https://screenpipe.com

$ErrorActionPreference = 'Stop'
$evidence = 'C:\screenpipe-worker\results\capture-fps-20261112-c6c2'
$cyan = Start-Process 'C:\spdev\release\examples\windows_privacy_fixture.exe' -ArgumentList @('allowed', 20, 300) -PassThru
$magenta = Start-Process 'C:\spdev\release\examples\windows_privacy_fixture.exe' -ArgumentList @('blocked', 480, 300) -PassThru
$video = Join-Path $evidence 'normal-app-demo.mp4'
$recorder = Start-Process ffmpeg -ArgumentList @('-y', '-f', 'gdigrab', '-framerate', '15', '-i', 'desktop', '-t', '150', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', $video) -WindowStyle Hidden -PassThru
$env:SCREENPIPE_DATA_DIR = Join-Path $evidence 'app-data'
$env:SCREENPIPE_PORT = '3048'
$env:SCREENPIPE_DISABLE_TELEMETRY = '1'
$app = Start-Process 'C:\spdev\debug-dev\screenpipe-app.exe' -PassThru
[ordered]@{ app = $app.Id; cyan = $cyan.Id; magenta = $magenta.Id; ffmpeg = $recorder.Id } |
    ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $evidence 'normal-app-pids.json')

$health = $null
foreach ($attempt in 1..60) {
    Start-Sleep -Seconds 1
    try {
        $health = Invoke-RestMethod 'http://127.0.0.1:3048/health' -TimeoutSec 2
        break
    } catch {}
}
if ($null -eq $health) { throw 'normal app health endpoint did not become ready' }
$health | ConvertTo-Json -Depth 8 | Set-Content -Encoding utf8 (Join-Path $evidence 'normal-app-health-start.json')
Get-Process -Id $app.Id | Select-Object Id, Path, StartTime
