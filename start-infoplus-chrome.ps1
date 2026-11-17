param([switch]$Check)

$ErrorActionPreference = 'Stop'
$profile = if ($env:INFOPLUS_CHROME_PROFILE) { $env:INFOPLUS_CHROME_PROFILE } else { Join-Path $PSScriptRoot 'chrome-profile' }
$profile = [IO.Path]::GetFullPath($profile)
$port = 9222
$endpoint = "http://127.0.0.1:$port"

if ((Test-Path -LiteralPath $profile) -and
    ((Get-Item -LiteralPath $profile -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw "The Chrome profile must be a local directory: $profile"
}

function Get-DebugListeners {
    Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
}

function Confirm-DedicatedChrome($listeners) {
    $ipv4 = @($listeners | Where-Object LocalAddress -eq '127.0.0.1')
    $owners = @($listeners.OwningProcess | Sort-Object -Unique)
    if ($ipv4.Count -eq 0 -or $owners.Count -ne 1 -or
        @($listeners | Where-Object { $_.LocalAddress -notin '127.0.0.1', '::1' }).Count) {
        throw "Port $port is occupied by a listener other than the dedicated local Chrome."
    }
    $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$($owners[0])"
    $escapedProfile = [regex]::Escape($profile)
    $profileFlag = '(?:^|\s)--user-data-dir=(?:"' + $escapedProfile + '"|' + $escapedProfile + ')(?=\s|$)'
    if ($owner.Name -ne 'chrome.exe' -or $owner.CommandLine -notmatch $profileFlag -or
        $owner.CommandLine -notmatch "(?:^|\s)--remote-debugging-port=$port(?=\s|$)") {
        throw "Port $port is occupied. Release it before starting the dedicated Chrome."
    }
    $debug = Invoke-RestMethod -Uri "$endpoint/json/version" -TimeoutSec 2
    if ($debug.webSocketDebuggerUrl -notlike "ws://127.0.0.1:$port/devtools/browser/*") {
        throw 'Dedicated Chrome did not return a local browser debugging endpoint.'
    }
}

$listeners = @(Get-DebugListeners)
if ($listeners.Count) {
    Confirm-DedicatedChrome $listeners
    if (-not $Check) { Write-Host "Dedicated Chrome is ready at $endpoint" }
    exit 0
}
if ($Check) { exit 2 }

$chrome = @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA) |
    Where-Object { $_ } |
    ForEach-Object { Join-Path $_ 'Google\Chrome\Application\chrome.exe' } |
    Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
    Select-Object -First 1
if (-not $chrome) { throw 'Google Chrome was not found.' }

$chromeArgs = @(
    '--remote-debugging-address=127.0.0.1'
    "--remote-debugging-port=$port"
    ('--user-data-dir="' + $profile + '"')
    '--no-first-run'
    'https://one.zju.edu.cn/infoplus/ide/project/ZD_YGCGJSCS'
)
Start-Process -FilePath $chrome -ArgumentList $chromeArgs -WindowStyle Normal

$deadline = (Get-Date).AddSeconds(15)
do {
    Start-Sleep -Milliseconds 250
    $listeners = @(Get-DebugListeners)
} until ($listeners.Count -or (Get-Date) -ge $deadline)
if (-not $listeners.Count) { throw "Dedicated Chrome did not open port $port." }
Confirm-DedicatedChrome $listeners
Write-Host "Dedicated Chrome is ready at $endpoint"
