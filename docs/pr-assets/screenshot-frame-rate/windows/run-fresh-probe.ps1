# screenpipe — AI that knows everything you've seen, said, or heard
# https://screenpipe.com

$ErrorActionPreference = 'Stop'
$evidence = 'C:\screenpipe-worker\results\capture-fps-recovery-c6c2'
$probe = 'C:\spdev\release\examples\wgc_cpu_probe.exe'
$fixture = Start-Process 'C:\spdev\release\examples\windows_privacy_fixture.exe' `
    -ArgumentList @('churn', 300, 220) -PassThru

try {
    $results = foreach ($fps in @(1, 2, 4, 8, 24, 30)) {
        $log = Join-Path $evidence "fresh-$($fps)fps.log"
        $lines = & $probe --duration 10 --interval-ms 286 --timeout-ms 200 --fps $fps --fresh 2>&1 |
            Tee-Object $log
        if ($LASTEXITCODE -ne 0) {
            throw "fresh probe failed at $fps fps with exit $LASTEXITCODE"
        }
        $line = $lines | Where-Object { $_ -like 'WGC_RATE_JSON=*' } | Select-Object -Last 1
        ($line -replace '^WGC_RATE_JSON=', '') | ConvertFrom-Json
    }
    $results | ConvertTo-Json -Depth 8 | Set-Content -Encoding utf8 `
        (Join-Path $evidence 'fresh-probe.json')
} finally {
    Stop-Process -Id $fixture.Id -Force -ErrorAction SilentlyContinue
}
