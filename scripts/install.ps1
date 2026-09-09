# Установщик fb2read для Windows.
#
#   irm https://w2713.github.io/fb2read/install.ps1 | iex
#
# Скачивает готовый бинарник, сверяет контрольную сумму и кладёт в папку
# пользователя, добавляя её в PATH. Ничего ставить заранее не нужно.
#
# Переменные окружения:
#   FB2READ_VERSION      какую версию ставить (по умолчанию последнюю)
#   FB2READ_INSTALL_DIR  куда класть

$ErrorActionPreference = 'Stop'

$repo = if ($env:FB2READ_REPO) { $env:FB2READ_REPO } else { 'w2713/fb2read' }
$version = if ($env:FB2READ_VERSION) { $env:FB2READ_VERSION } else { 'latest' }
$installDir = if ($env:FB2READ_INSTALL_DIR) {
    $env:FB2READ_INSTALL_DIR
} else {
    Join-Path $env:LOCALAPPDATA 'Programs\fb2read'
}

function Fail($message) {
    Write-Host "fb2read: $message" -ForegroundColor Red
    exit 1
}

# Готовые сборки есть под x64 и arm64; на остальном остаётся npm.
$arch = switch ($env:PROCESSOR_ARCHITECTURE) {
    'AMD64' { 'x64' }
    'ARM64' { 'arm64' }
    default { Fail "процессор $($env:PROCESSOR_ARCHITECTURE) пока не поддерживается; попробуйте npm install -g fb2read" }
}

$archive = "fb2read-windows-$arch.zip"
$base = if ($env:FB2READ_BASE_URL) {
    $env:FB2READ_BASE_URL
} elseif ($version -eq 'latest') {
    "https://github.com/$repo/releases/latest/download"
} else {
    "https://github.com/$repo/releases/download/$version"
}

$work = Join-Path ([System.IO.Path]::GetTempPath()) ("fb2read-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $work -Force | Out-Null

try {
    Write-Host "скачиваю $archive"
    $zip = Join-Path $work $archive
    try {
        Invoke-WebRequest -Uri "$base/$archive" -OutFile $zip -UseBasicParsing
    } catch {
        Fail "не удалось скачать $base/$archive"
    }

    # Проверяем, что скачалось именно то, что выложили.
    $sums = Join-Path $work 'SHA256SUMS'
    try {
        Invoke-WebRequest -Uri "$base/SHA256SUMS" -OutFile $sums -UseBasicParsing
    } catch {
        $sums = $null
        Write-Host 'не нашёл SHA256SUMS — ставлю без проверки'
    }

    if ($sums) {
        $actual = (Get-FileHash -Path $zip -Algorithm SHA256).Hash.ToLower()
        $line = Get-Content $sums | Where-Object { $_ -match "\s$([regex]::Escape($archive))$" }
        if (-not $line) { Fail "в SHA256SUMS нет записи про $archive" }
        $expected = ($line -split '\s+')[0].ToLower()
        if ($actual -ne $expected) {
            Fail 'контрольная сумма не сошлась — файл повреждён или подменён, ставить не буду'
        }
        Write-Host 'контрольная сумма сошлась'
    }

    Expand-Archive -Path $zip -DestinationPath $work -Force
    $binary = Join-Path $work 'fb2read.exe'
    if (-not (Test-Path $binary)) { Fail 'в архиве нет программы' }

    New-Item -ItemType Directory -Path $installDir -Force | Out-Null
    $target = Join-Path $installDir 'fb2read.exe'
    Copy-Item -Path $binary -Destination $target -Force

    $shown = & $target --version
    Write-Host "установлено: $shown -> $target"
} finally {
    Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}

# PATH правим только пользовательский: права администратора не нужны.
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -notlike "*$installDir*") {
    $updated = if ($userPath) { "$userPath;$installDir" } else { $installDir }
    [Environment]::SetEnvironmentVariable('Path', $updated, 'User')
    Write-Host ''
    Write-Host "$installDir добавлен в PATH. Откройте терминал заново."
}

Write-Host ''
Write-Host 'Совет: в Windows Terminal читалка выглядит лучше, чем в старой консоли:'
Write-Host 'там есть курсив, широкие символы и колесо мыши.'
