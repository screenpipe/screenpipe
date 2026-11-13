# screenpipe — AI that knows everything you've seen, said, or heard
# https://screenpipe.com

$ErrorActionPreference = 'Stop'
$evidence = 'C:\screenpipe-worker\results\capture-fps-20261112-c6c2'
$cyan = Start-Process 'C:\spdev\release\examples\windows_privacy_fixture.exe' -ArgumentList @('allowed', 20, 300) -PassThru
$magenta = Start-Process 'C:\spdev\release\examples\windows_privacy_fixture.exe' -ArgumentList @('churn', 480, 300) -PassThru
$recorder = Start-Process ffmpeg -ArgumentList @('-y', '-f', 'gdigrab', '-framerate', '15', '-i', 'desktop', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', (Join-Path $evidence 'e2e-app-demo.mp4')) -WindowStyle Hidden -PassThru
try {
    $env:SCREENPIPE_E2E_SEED = 'onboarding,no-audio,cloud-authenticated'
    $env:SCREENPIPE_E2E_DATA_DIR = Join-Path $evidence 'e2e-app-data'
    $env:SCREENPIPE_E2E_PERSIST_APP_LOGS = 'true'
    $env:SCREENPIPE_E2E_QUIET_APP_LOGS = 'true'
    $env:SCREENPIPE_PORT = '3048'
    $env:SCREENPIPE_FOCUS_PORT = '11448'
    $env:SCREENPIPE_E2E_WEBDRIVER_PORT = '4448'
    $env:SCREENPIPE_E2E_APP_PATH = 'C:\spdev\debug-dev\screenpipe-app.exe'
    bun run wdio run e2e/wdio.conf.ts --spec e2e/specs/screenshot-frame-rate-windows.spec.ts 2>&1 |
        Tee-Object (Join-Path $evidence 'e2e-app-proof.log')
    $exitCode = $LASTEXITCODE
} finally {
    Stop-Process -Id $cyan.Id -Force -ErrorAction SilentlyContinue
    Stop-Process -Id $magenta.Id -Force -ErrorAction SilentlyContinue
    Stop-Process -Id $recorder.Id -Force -ErrorAction SilentlyContinue
}
"exit_code=$exitCode" | Set-Content -Encoding ascii (Join-Path $evidence 'e2e-app-proof.exit.txt')
exit $exitCode
