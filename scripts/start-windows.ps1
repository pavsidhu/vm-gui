# Installs anything missing (Node.js, Google Cloud CLI), signs in to Google Cloud,
# then starts VM GUI. Run via start-windows.bat.
# Remote Desktop Connection (mstsc) is built into Windows, so it doesn't need installing.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Set-Location (Split-Path $PSScriptRoot)

$tmp = Join-Path $env:TEMP 'vm-gui-setup'
New-Item -ItemType Directory -Force $tmp | Out-Null

function Step($message) { Write-Host "`n$message" -ForegroundColor Cyan }

# Reload PATH so newly installed tools are found without reopening the window
function Update-Path {
  $env:Path = @(
    [Environment]::GetEnvironmentVariable('Path', 'Machine'),
    [Environment]::GetEnvironmentVariable('Path', 'User'),
    "$env:LOCALAPPDATA\Google\Cloud SDK\google-cloud-sdk\bin",
    "${env:ProgramFiles(x86)}\Google\Cloud SDK\google-cloud-sdk\bin",
    "$env:ProgramFiles\Google\Cloud SDK\google-cloud-sdk\bin"
  ) -join ';'
}

function Test-Command($name) { [bool](Get-Command $name -ErrorAction SilentlyContinue) }

function Test-Node {
  try { [int]((& node -p process.versions.node).Split('.')[0]) -ge 18 } catch { $false }
}

Update-Path

# Node.js 18+
if (-not (Test-Node)) {
  Step 'Installing Node.js (Windows will ask for permission)...'
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
  $base = 'https://nodejs.org/dist/latest-v24.x'
  $msi = [regex]::Match((Invoke-RestMethod "$base/SHASUMS256.txt"), "node-v[\d.]+-$arch\.msi").Value
  Invoke-WebRequest -UseBasicParsing "$base/$msi" -OutFile "$tmp\node.msi"
  $install = Start-Process msiexec.exe -ArgumentList "/i `"$tmp\node.msi`" /qn /norestart" -Verb RunAs -Wait -PassThru
  if ($install.ExitCode -notin 0, 3010) { throw "Node.js installer failed (exit code $($install.ExitCode))" }
  Update-Path
}

# Google Cloud CLI. Unzips Google's ready-to-run archive (Python included) rather than running the
# regular installer, which spends 10+ minutes on Windows setting up and compiling ~30,000 files.
if (-not (Test-Command gcloud)) {
  Step 'Installing the Google Cloud CLI...'
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm' } else { 'x86_64' }
  $zip = "$tmp\gcloud.zip"
  Invoke-WebRequest -UseBasicParsing "https://dl.google.com/dl/cloudsdk/channels/rapid/downloads/google-cloud-cli-windows-$arch-bundled-python.zip" -OutFile $zip

  $root = "$env:LOCALAPPDATA\Google\Cloud SDK"
  New-Item -ItemType Directory -Force $root | Out-Null
  if (Test-Command tar.exe) {
    & tar.exe -xf $zip -C $root
    if ($LASTEXITCODE -ne 0) { throw 'Unzipping the Google Cloud CLI failed.' }
  } else {
    Expand-Archive $zip -DestinationPath $root -Force
  }
  Remove-Item $zip

  # Add gcloud to PATH for new windows too
  $bin = "$root\google-cloud-sdk\bin"
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (($userPath -split ';') -notcontains $bin) {
    [Environment]::SetEnvironmentVariable('Path', "$userPath;$bin".TrimStart(';'), 'User')
  }
  Update-Path
  if (-not (Test-Command gcloud)) { throw 'The Google Cloud CLI installed but gcloud could not be found. Run start-windows.bat again.' }
}

# Google Cloud sign-in
$ErrorActionPreference = 'Continue'
$accounts = (& gcloud auth list --format=json 2>$null) -join "`n" | ConvertFrom-Json
$ErrorActionPreference = 'Stop'
if (-not ($accounts | Where-Object { $_.status -eq 'ACTIVE' })) {
  Step 'Sign in to Google Cloud in your browser. If no browser window appears, check the taskbar, or Ctrl+click the link below (or copy it into a browser on this computer).'
  & gcloud auth login --brief
  if ($LASTEXITCODE -ne 0) { throw 'Google Cloud sign-in failed.' }
}

Step 'Starting VM GUI...'
& node server.js
exit $LASTEXITCODE
