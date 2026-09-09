# fb2read installer for Windows.
#
#   irm https://w2713.github.io/fb2read/install.ps1 | iex
#
# Downloads a ready-made binary, verifies its checksum and puts it into the
# user's folder, adding that folder to PATH. Nothing needs to be installed
# beforehand.
#
# Environment:
#   FB2READ_VERSION      which version to install (default: latest)
#   FB2READ_INSTALL_DIR  where to put it
#
# ВНИМАНИЕ, ПРО ЯЗЫК. Сообщения этого скрипта — на английском, и это не
# небрежность. Windows PowerShell 5.1 при `irm ... | iex` декодирует
# скачанный текст как латиницу, потому что сервер не объявляет кодировку.
# Русские слова превращались бы в «ÑÐºÐ°ÑÐ¸Ð²Ð°Ñ» — то есть в мусор.
# Латиница читается верно в любом случае, поэтому она здесь и осталась.
# Комментарии на русском можно: их пользователь не видит.

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
    default { Fail "unsupported processor $($env:PROCESSOR_ARCHITECTURE); try: npm install -g fb2read" }
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
    Write-Host "downloading $archive"
    $zip = Join-Path $work $archive
    try {
        Invoke-WebRequest -Uri "$base/$archive" -OutFile $zip -UseBasicParsing
    } catch {
        # Чаще всего сюда попадают не из-за сети, а потому что релиза ещё
        # нет. Общее «не удалось скачать» тут ничего не объясняет.
        Write-Host ''
        Write-Host "Could not download $base/$archive" -ForegroundColor Red
        Write-Host ''
        Write-Host 'The most likely reason: no release has been published yet.'
        Write-Host "Check https://github.com/$repo/releases"
        Write-Host ''
        Write-Host 'Meanwhile you can install from npm (needs Node.js 20+):'
        Write-Host '  npm install -g fb2read'
        exit 1
    }

    # Проверяем, что скачалось именно то, что выложили.
    $sums = Join-Path $work 'SHA256SUMS'
    try {
        Invoke-WebRequest -Uri "$base/SHA256SUMS" -OutFile $sums -UseBasicParsing
    } catch {
        $sums = $null
        Write-Host 'no SHA256SUMS found, installing without verification'
    }

    if ($sums) {
        $actual = (Get-FileHash -Path $zip -Algorithm SHA256).Hash.ToLower()
        $line = Get-Content $sums | Where-Object { $_ -match "\s$([regex]::Escape($archive))$" }
        if (-not $line) { Fail "no entry for $archive in SHA256SUMS" }
        $expected = ($line -split '\s+')[0].ToLower()
        if ($actual -ne $expected) {
            Fail 'checksum mismatch: the file is damaged or tampered with, not installing'
        }
        Write-Host 'checksum verified'
    }

    Expand-Archive -Path $zip -DestinationPath $work -Force
    $binary = Join-Path $work 'fb2read.exe'
    if (-not (Test-Path $binary)) { Fail 'the archive contains no program' }

    New-Item -ItemType Directory -Path $installDir -Force | Out-Null
    $target = Join-Path $installDir 'fb2read.exe'
    Copy-Item -Path $binary -Destination $target -Force

    $shown = & $target --version
    Write-Host "installed: $shown -> $target"
} finally {
    Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}

# PATH правим только пользовательский: права администратора не нужны.
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($userPath -notlike "*$installDir*") {
    $updated = if ($userPath) { "$userPath;$installDir" } else { $installDir }
    [Environment]::SetEnvironmentVariable('Path', $updated, 'User')
    Write-Host ''
    Write-Host "$installDir added to PATH. Open a new terminal to use it."
}

Write-Host ''
Write-Host 'Tip: Windows Terminal shows the reader better than the old console:'
Write-Host 'it has italics, wide characters and mouse wheel support.'
