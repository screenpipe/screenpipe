# screenpipe — AI that knows everything you've seen, said, or heard
# https://screenpipe.com

param([int]$DurationSeconds = 30)

$ErrorActionPreference = 'Stop'
$root = (Resolve-Path "$PSScriptRoot\..\..\..\..").Path
$probe = 'C:\spdev\release\examples\wgc_cpu_probe.exe'
$fixture = 'C:\spdev\release\examples\windows_privacy_fixture.exe'
$raw = Join-Path $PSScriptRoot 'raw'
New-Item -ItemType Directory -Force -Path $raw | Out-Null

function Measure-Run([string]$scene, [int]$fps, [string]$order, [int]$ordinal) {
    $stem = "${order}-${ordinal}-${scene}-${fps}fps"
    $stdout = Join-Path $raw "$stem.stdout.log"
    $stderr = Join-Path $raw "$stem.stderr.log"
    $process = Start-Process -FilePath $probe -ArgumentList @('--duration', $DurationSeconds, '--fps', $fps, '--interval-ms', 286) -RedirectStandardOutput $stdout -RedirectStandardError $stderr -WindowStyle Hidden -PassThru
    $started = Get-Date
    $dwm = Get-Process dwm -ErrorAction Stop
    $dwmCpuStart = $dwm.CPU
    $samples = @()
    while (-not $process.HasExited) {
        Start-Sleep -Milliseconds 1000
        $process.Refresh()
        $dwm.Refresh()
        $systemCpu = (Get-Counter '\Processor(_Total)\% Processor Time').CounterSamples.CookedValue
        if (-not $process.HasExited) {
            $samples += [ordered]@{
                utc = (Get-Date).ToUniversalTime().ToString('o')
                private_bytes = $process.PrivateMemorySize64
                working_set_bytes = $process.WorkingSet64
                dwm_working_set_bytes = $dwm.WorkingSet64
                system_cpu_percent_whole_vm = $systemCpu
            }
        }
    }
    $elapsed = ((Get-Date) - $started).TotalSeconds
    $dwm.Refresh()
    $line = Get-Content $stdout | Where-Object { $_ -like 'WGC_RATE_JSON=*' } | Select-Object -Last 1
    if (-not $line) { throw "missing WGC_RATE_JSON in $stdout" }
    $probeResult = ($line -replace '^WGC_RATE_JSON=', '') | ConvertFrom-Json
    [ordered]@{
        scene = $scene
        order = $order
        ordinal = $ordinal
        exit_code = $process.ExitCode
        probe = $probeResult
        external = [ordered]@{
            sample_count = $samples.Count
            process_private_bytes_mean = ($samples.private_bytes | Measure-Object -Average).Average
            process_private_bytes_peak = ($samples.private_bytes | Measure-Object -Maximum).Maximum
            process_working_set_bytes_mean = ($samples.working_set_bytes | Measure-Object -Average).Average
            process_working_set_bytes_peak = ($samples.working_set_bytes | Measure-Object -Maximum).Maximum
            dwm_cpu_percent_one_core = 100 * ($dwm.CPU - $dwmCpuStart) / $elapsed
            dwm_working_set_bytes_mean = ($samples.dwm_working_set_bytes | Measure-Object -Average).Average
            system_cpu_percent_whole_vm_mean = ($samples.system_cpu_percent_whole_vm | Measure-Object -Average).Average
        }
        resource_samples = $samples
    }
}

$all = @()
foreach ($scene in @('static', 'moving')) {
    $kind = if ($scene -eq 'moving') { 'churn' } else { 'allowed' }
    # This repository fixture is intentionally visible on the VM-owned console.
    $fixtureProcess = Start-Process -FilePath $fixture -ArgumentList @($kind, 120, 120) -PassThru
    Start-Sleep -Seconds 2
    try {
        $ordinal = 0
        foreach ($order in @('forward', 'reverse')) {
            $rates = if ($order -eq 'forward') { @(1, 2, 4, 8, 12, 24, 30) } else { @(30, 24, 12, 8, 4, 2, 1) }
            foreach ($fps in $rates) {
                $ordinal++
                $result = Measure-Run $scene $fps $order $ordinal
                $all += $result
                $result | ConvertTo-Json -Depth 8 | Set-Content -Encoding utf8 (Join-Path $raw "$order-$ordinal-$scene-${fps}fps.json")
            }
        }
    } finally {
        Stop-Process -Id $fixtureProcess.Id -Force -ErrorAction SilentlyContinue
    }
}

$all | ConvertTo-Json -Depth 8 | Set-Content -Encoding utf8 (Join-Path $PSScriptRoot 'matrix-raw.json')
$all | ForEach-Object {
    [pscustomobject]@{
        scene = $_.scene; order = $_.order; fps = $_.probe.requested_fps
        callback_hz = $_.probe.callback_rate_hz; copy_hz = $_.probe.copy_rate_hz
        delivery_hz = $_.probe.delivery_rate_hz; completed = $_.probe.completed_requests
        failed = $_.probe.failed_requests; latency_p50_ms = $_.probe.latency_ms_p50
        latency_p95_ms = $_.probe.latency_ms_p95; process_cpu_percent_one_core = $_.probe.process_cpu_percent_one_core
        dwm_cpu_percent_one_core = $_.external.dwm_cpu_percent_one_core
        system_cpu_percent_whole_vm = $_.external.system_cpu_percent_whole_vm_mean
        private_bytes_peak = $_.external.process_private_bytes_peak
        working_set_bytes_peak = $_.external.process_working_set_bytes_peak
        native_status = $_.probe.native_interval_status; native_ticks = $_.probe.native_interval_ticks
    }
} | Export-Csv -NoTypeInformation -Encoding utf8 (Join-Path $PSScriptRoot 'matrix-summary.csv')
