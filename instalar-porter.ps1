# Instalador de Porter para Windows
# Uso: clic derecho -> "Ejecutar con PowerShell"
#   o: powershell -ExecutionPolicy Bypass -File .\instalar-porter.ps1
param(
  [string]$Zip = "",
  [switch]$SinFirma
)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $Zip) {
  $Zip = Get-ChildItem -Path $here -Filter 'Porter-*-win.zip' | Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName
}
if (-not $Zip -or -not (Test-Path $Zip)) { Write-Host "No encuentro Porter-x.x.x-win.zip junto a este script." -ForegroundColor Red; pause; exit 1 }

$dest = Join-Path $env:LOCALAPPDATA 'Programs\Porter'
Write-Host "Instalando Porter en $dest ..." -ForegroundColor Cyan

# 1) Quitar la marca de "descargado de Internet": es lo que activa el aviso de SmartScreen
Unblock-File -Path $Zip

# 2) Cerrar Porter si está abierto y descomprimir
Get-Process Porter -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 500
if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
Expand-Archive -Path $Zip -DestinationPath $dest -Force
Get-ChildItem $dest -Recurse -File | Unblock-File
$exe = Join-Path $dest 'Porter.exe'

# 3) Firma con un certificado propio, de confianza solo en este PC
if (-not $SinFirma) {
  $subject = 'CN=Porter - Fireaced'
  $cert = Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert | Where-Object { $_.Subject -eq $subject -and $_.NotAfter -gt (Get-Date) } | Select-Object -First 1
  if (-not $cert) {
    Write-Host "Creando tu certificado de firma (solo la primera vez)..." -ForegroundColor Cyan
    $cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject $subject -CertStoreLocation Cert:\CurrentUser\My -KeyExportPolicy NonExportable -KeyAlgorithm RSA -KeyLength 3072 -HashAlgorithm SHA256 -NotAfter (Get-Date).AddYears(10)
    $cer = Join-Path $env:TEMP 'porter-firma.cer'
    Export-Certificate -Cert $cert -FilePath $cer | Out-Null
    Write-Host "Windows te pedirá confirmar que confías en el certificado: pulsa 'Sí'." -ForegroundColor Yellow
    Import-Certificate -FilePath $cer -CertStoreLocation Cert:\CurrentUser\Root | Out-Null
    Import-Certificate -FilePath $cer -CertStoreLocation Cert:\CurrentUser\TrustedPublisher | Out-Null
    Remove-Item $cer -Force
  }
  $sig = $null
  try { $sig = Set-AuthenticodeSignature -FilePath $exe -Certificate $cert -HashAlgorithm SHA256 -TimestampServer 'http://timestamp.digicert.com' }
  catch { $sig = Set-AuthenticodeSignature -FilePath $exe -Certificate $cert -HashAlgorithm SHA256 }
  Write-Host ("Firma: " + (Get-AuthenticodeSignature $exe).Status) -ForegroundColor Green
}

# 4) Accesos directos en el menú Inicio y el escritorio
$ws = New-Object -ComObject WScript.Shell
foreach ($dir in @([Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('Desktop'))) {
  $lnk = $ws.CreateShortcut((Join-Path $dir 'Porter.lnk'))
  $lnk.TargetPath = $exe
  $lnk.WorkingDirectory = $dest
  $lnk.IconLocation = "$exe,0"
  $lnk.Description = 'Porter - Lector de manga y cómics'
  $lnk.Save()
}

Write-Host "Listo. Porter está en el menú Inicio y en el escritorio." -ForegroundColor Green
Write-Host "Tus datos (biblioteca, progreso e historial) no se tocan al actualizar."
Start-Process $exe
