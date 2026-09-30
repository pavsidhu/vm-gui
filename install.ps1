# Downloads (or updates) VM GUI into your home folder, then starts it:
#   irm https://raw.githubusercontent.com/pavsidhu/vm-gui/main/install.ps1 | iex
& {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

  try {
    Invoke-WebRequest -UseBasicParsing 'http://localhost:4870/' -TimeoutSec 2 | Out-Null
    Write-Host 'VM GUI is already running.'
    Start-Process 'http://localhost:4870'
    return
  } catch {}

  $dir = Join-Path $HOME 'vm-gui'
  if ((Test-Path $dir) -and -not (Test-Path (Join-Path $dir 'start-windows.bat'))) {
    throw "$dir already exists and isn't VM GUI. Move it somewhere else and run this again."
  }

  Write-Host 'Downloading VM GUI...'
  $tmp = Join-Path $env:TEMP "vm-gui-download-$(Get-Random)"
  New-Item -ItemType Directory -Force $tmp | Out-Null
  Invoke-WebRequest -UseBasicParsing 'https://github.com/pavsidhu/vm-gui/archive/refs/heads/main.zip' -OutFile "$tmp\vm-gui.zip"
  Expand-Archive "$tmp\vm-gui.zip" -DestinationPath $tmp

  if (Test-Path $dir) {
    try { Remove-Item $dir -Recurse -Force }
    catch { throw "Couldn't replace $dir because something is using it. Close any VM GUI windows, then run this again." }
  }
  Copy-Item "$tmp\vm-gui-main" $dir -Recurse
  Remove-Item $tmp -Recurse -Force

  & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $dir 'scripts\start-windows.ps1')
}
