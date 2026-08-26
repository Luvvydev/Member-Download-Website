param(
  [Parameter(Mandatory = $true)]
  [ValidateScript({ Test-Path $_ -PathType Leaf })]
  [string]$File
)

$ErrorActionPreference = "Stop"
$StorageObject = "gs://chess-ee6b0.firebasestorage.app/member-downloads/current-download.js"
$ResolvedFile = (Resolve-Path $File).Path

if (-not (Get-Command gcloud -ErrorAction SilentlyContinue)) {
  throw "Google Cloud CLI is required. Install it, run 'gcloud auth login', then run this command again."
}

Write-Host "Uploading: $ResolvedFile"
Write-Host "Replacing: $StorageObject"
gcloud storage cp $ResolvedFile $StorageObject

if ($LASTEXITCODE -ne 0) {
  throw "The Firebase Storage upload failed."
}

Write-Host "Member download replaced successfully."

