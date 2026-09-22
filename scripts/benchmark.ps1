<#
.SYNOPSIS
  End-to-end ingest benchmark (Windows / PowerShell).

.EXAMPLE
  .\scripts\benchmark.ps1 -File .\tmp\huge.csv

  Registers (or reuses) a benchmark merchant, uploads the file, polls until the
  ingest finishes, and prints the numbers section 7 of the brief asks for.
  Re-authenticates automatically: a 2 GB ingest outlives the 15-minute access
  token.

  Deliberately ASCII-only. Windows PowerShell 5.1 reads .ps1 files as ANSI
  unless they carry a UTF-8 BOM, so a stray em dash breaks the parser.
#>
param(
  [string]$File = ".\tmp\huge.csv",
  [string]$Api = "http://localhost:3000",
  [string]$Email = "benchmark@example.test",
  [string]$Password = "benchmark-password-1234",
  [string]$WorkerContainer = "wobot-csv-ingestion-worker-1"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $File)) { throw "No such file: $File" }

function Get-Token {
  $body = @{
    accountType  = "merchant"
    email        = $Email
    password     = $Password
    merchantName = "Benchmark Retail"
  } | ConvertTo-Json -Compress

  try {
    $r = Invoke-RestMethod -Method Post -Uri "$Api/v1/auth/register" `
           -ContentType "application/json" -Body $body
    return $r.accessToken
  } catch {
    $login = @{ email = $Email; password = $Password } | ConvertTo-Json -Compress
    $r = Invoke-RestMethod -Method Post -Uri "$Api/v1/auth/login" `
           -ContentType "application/json" -Body $login
    return $r.accessToken
  }
}

$token = Get-Token
$sizeBytes = (Get-Item $File).Length

Write-Host ""
Write-Host ("file        : {0}" -f (Resolve-Path $File))
Write-Host ("size        : {0:N2} GB ({1:N0} bytes)" -f ($sizeBytes / 1GB), $sizeBytes)
Write-Host ("api         : {0}" -f $Api)
Write-Host ""

# curl.exe, not Invoke-RestMethod: PowerShell buffers a multipart body in
# memory, which is exactly what we must not do with a 2 GB file.
$uploadStart = Get-Date
$raw = curl.exe -s -X POST "$Api/v1/imports" `
        -H "authorization: Bearer $token" `
        -F "file=@$File"
$uploadEnd = Get-Date

$upload = $raw | ConvertFrom-Json
if (-not $upload.imports) { Write-Host $raw; throw "Upload failed" }

$id = $upload.imports[0].id
Write-Host ("import id   : {0}" -f $id)
Write-Host ("upload+hash : {0:N1}s  (the request returns 202 here)" -f ($uploadEnd - $uploadStart).TotalSeconds)
Write-Host ""

$peakMiB = 0
$ingestStart = Get-Date
$body = $null

while ($true) {
  try {
    $body = Invoke-RestMethod -Uri "$Api/v1/imports/$id" -Headers @{ authorization = "Bearer $token" }
  } catch {
    # Access token expired mid-ingest. Get another and carry on.
    $token = Get-Token
    continue
  }

  $mem = docker stats --no-stream --format "{{.MemUsage}}" $WorkerContainer 2>$null
  if ($mem) {
    $value = ($mem -split "/")[0].Trim()
    if ($value -match "GiB") { $mib = [double]($value -replace "GiB", "") * 1024 }
    else { $mib = [double]($value -replace "MiB", "") }
    if ($mib -gt $peakMiB) { $peakMiB = $mib }
  }

  if ($body.status -eq "completed" -or $body.status -eq "failed" -or $body.status -eq "cancelled") {
    break
  }

  Write-Host ("  {0}  {1:P1}  rows={2:N0}" -f $body.status, $body.progress.fraction, $body.progress.rowsRead)
  Start-Sleep -Seconds 10
}

$elapsed = ((Get-Date) - $ingestStart).TotalSeconds
$rows = $body.progress.rowsRead
$r = $body.result

Write-Host ""
Write-Host ("status      : {0}" -f $body.status)
Write-Host ("rows read   : {0:N0}" -f $rows)
Write-Host ("applied     : {0:N0}" -f $r.rowsApplied)
Write-Host ("superseded  : {0:N0}" -f $r.rowsSuperseded)
Write-Host ("rejected    : {0:N0}" -f $r.rowsRejected)
Write-Host ("invariant   : {0}" -f ($rows -eq ($r.rowsApplied + $r.rowsSuperseded + $r.rowsRejected)))
Write-Host ("wall clock  : {0:N1}s ({1:N1} min)" -f $elapsed, ($elapsed / 60))
Write-Host ("throughput  : {0:N0} rows/sec" -f ($rows / $elapsed))
Write-Host ("              {0:N2} MB/sec" -f ($sizeBytes / 1MB / $elapsed))
if ($peakMiB -gt 0) {
  Write-Host ("peak worker : {0:N0} MiB (container limit 512 MiB)" -f $peakMiB)
}
Write-Host ""
Write-Host "Hardware: fill this in - CPU model, core count, RAM, disk type."
