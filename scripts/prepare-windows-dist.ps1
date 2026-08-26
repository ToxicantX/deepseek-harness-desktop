param(
    [Parameter(Mandatory = $true)]
    [string]$DistPath,
    [int]$MaxAttempts = 5
)

$ErrorActionPreference = 'Stop'
$distFullPath = [System.IO.Path]::GetFullPath($DistPath).TrimEnd('\')

if (-not (Test-Path -LiteralPath $distFullPath)) {
    exit 0
}

$distPrefix = "$distFullPath\"
$runningFromDist = Get-CimInstance Win32_Process | Where-Object {
    $_.ExecutablePath -and $_.ExecutablePath.StartsWith(
        $distPrefix,
        [System.StringComparison]::OrdinalIgnoreCase
    )
}

if ($runningFromDist) {
    Write-Warning "The previous build output is currently running and will not be stopped automatically."
    foreach ($process in $runningFromDist) {
        Write-Host "  $($process.Name) (PID $($process.ProcessId)): $($process.ExecutablePath)"
    }
    exit 2
}

for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
    try {
        Remove-Item -LiteralPath $distFullPath -Recurse -Force -ErrorAction Stop
        Write-Host "Removed previous build output: $distFullPath"
        exit 0
    }
    catch {
        if ($attempt -eq $MaxAttempts) {
            throw "Could not remove previous build output after $MaxAttempts attempts: $($_.Exception.Message)"
        }

        Write-Warning "Could not remove previous build output (attempt $attempt/$MaxAttempts). Retrying..."
        Start-Sleep -Seconds $attempt
    }
}
