[CmdletBinding()]
param(
  [ValidateSet('tiny', 'base')][string]$Model = 'tiny'
)

$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$dataRoot = if ($env:HEXIGRID_DATA_DIR) { [IO.Path]::GetFullPath($env:HEXIGRID_DATA_DIR) } else { Join-Path $projectRoot 'data' }
$root = Join-Path $dataRoot 'transcription'
$engine = Join-Path $root 'engine'
$models = Join-Path $root 'models'
$downloads = Join-Path $root 'downloads'
New-Item -ItemType Directory -Path $engine,$models,$downloads -Force | Out-Null

$engineArchive = Join-Path $downloads 'whisper-bin-x64-b5130.zip'
$engineUrl = 'https://github.com/ggml-org/whisper.cpp/releases/download/b5130/whisper-bin-x64.zip'
$engineSha256 = 'f9ec6c52a2e949b62ab51fa21d0d497958f9e41c3010c157c4e42932d5316f3c'
$modelUrl = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-$Model.bin"
$modelSha256 = if ($Model -eq 'tiny') { 'be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21' } else { '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe' }
$modelFile = Join-Path $models "ggml-$Model.bin"

function Get-VerifiedDownload([string]$Uri, [string]$Destination, [string]$Sha256) {
  if (-not (Test-Path -LiteralPath $Destination -PathType Leaf) -or (Get-FileHash -LiteralPath $Destination -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Sha256) {
    $temporary = "$Destination.partial"
    Remove-Item -LiteralPath $temporary -Force -ErrorAction SilentlyContinue
    Invoke-WebRequest -Uri $Uri -OutFile $temporary -UseBasicParsing
    $actual = (Get-FileHash -LiteralPath $temporary -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $Sha256) { Remove-Item -LiteralPath $temporary -Force; throw "Downloaded file failed SHA-256 verification." }
    Move-Item -LiteralPath $temporary -Destination $Destination -Force
  }
}

Get-VerifiedDownload -Uri $engineUrl -Destination $engineArchive -Sha256 $engineSha256
if (-not (Test-Path -LiteralPath (Join-Path $engine 'whisper-cli.exe') -PathType Leaf)) {
  $staging = Join-Path $downloads 'engine-staging'
  Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue
  Expand-Archive -LiteralPath $engineArchive -DestinationPath $staging -Force
  $cli = Get-ChildItem -LiteralPath $staging -Filter 'whisper-cli.exe' -Recurse -File | Select-Object -First 1
  if (-not $cli) { throw 'The verified whisper.cpp package did not contain whisper-cli.exe.' }
  Copy-Item -Path (Join-Path (Split-Path -Parent $cli.FullName) '*') -Destination $engine -Recurse -Force
  Remove-Item -LiteralPath $staging -Recurse -Force
}
Get-VerifiedDownload -Uri $modelUrl -Destination $modelFile -Sha256 $modelSha256

$ffmpeg = @(
  $env:HEXIGRID_FFMPEG,
  (Join-Path $engine 'ffmpeg.exe'),
  (Get-Command ffmpeg.exe -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty Source),
  'C:\ffmpeg\ffmpeg-7.1.1-full_build\bin\ffmpeg.exe'
) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -PathType Leaf) } | Select-Object -First 1
if (-not $ffmpeg) { throw 'FFmpeg is required. Install it locally, then run this installer again.' }

& (Join-Path $engine 'whisper-cli.exe') --version | Out-Null
Write-Output "Local transcription is ready with the $Model model. Audio stays on this computer."
