# Runs as SYSTEM on every boot of a desktop created by VM GUI (set as windows-startup-script-ps1 metadata).
# Output is logged to the VM's serial port 1.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$metadata = 'http://metadata.google.internal/computeMetadata/v1/instance'
$headers = @{ 'Metadata-Flavor' = 'Google' }

# Remote Desktop login, using the credentials the app stored in instance metadata
$username = Invoke-RestMethod -Headers $headers -Uri "$metadata/attributes/rdp-username"
$password = ConvertTo-SecureString (Invoke-RestMethod -Headers $headers -Uri "$metadata/attributes/rdp-password") -AsPlainText -Force
if (Get-LocalUser -Name $username -ErrorAction SilentlyContinue) {
  Set-LocalUser -Name $username -Password $password
} else {
  New-LocalUser -Name $username -Password $password -PasswordNeverExpires -AccountNeverExpires | Out-Null
  Add-LocalGroupMember -SID 'S-1-5-32-544' -Member $username # Administrators
}

# Desktop niceties: UK time, and no Server Manager popping up at sign-in
Set-TimeZone -Id 'GMT Standard Time'
Get-ScheduledTask -TaskName 'ServerManager' -ErrorAction SilentlyContinue | Disable-ScheduledTask | Out-Null

# Google Chrome
if (-not (Test-Path "$env:ProgramFiles\Google\Chrome\Application\chrome.exe")) {
  try {
    $msi = Join-Path $env:TEMP 'chrome.msi'
    Invoke-WebRequest -UseBasicParsing -Uri 'https://dl.google.com/dl/chrome/install/googlechromestandaloneenterprise64.msi' -OutFile $msi
    Start-Process msiexec.exe -ArgumentList "/i `"$msi`" /qn /norestart" -Wait
    Remove-Item $msi
  } catch {
    Write-Output "Chrome install failed: $_"
  }
}

# Tell the app this boot has finished setting up
$now = (Get-Date).ToUniversalTime().ToString('o')
Invoke-RestMethod -Method Put -Headers $headers -Uri "$metadata/guest-attributes/cloud-desktops/ready" -Body $now | Out-Null
Write-Output "VM GUI ready at $now"
