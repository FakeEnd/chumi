# One-time setup for Chumi on Windows 10/11 (x64). Run from the repository folder:
#
#   powershell -ExecutionPolicy Bypass -File scripts\setup.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\setup.ps1 -Proxy http://127.0.0.1:7890
#   powershell -ExecutionPolicy Bypass -File scripts\setup.ps1 -ModelBaseUrl https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main
#
# Installs whisper.cpp into build\whisper (the CUDA build when an NVIDIA GPU is present), downloads the speech model
# that suits this computer, installs npm dependencies and builds the web interface. Safe to run again.
# Live microphone and computer-audio capture are not available on Windows yet; see docs\windows.md.
param(
  [string]$Proxy = '',
  [string]$ModelBaseUrl = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main',
  # whisper.cpp publishes its Windows builds with the numbered release tags.
  [string]$WhisperRelease = 'b5454'
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-Location (Split-Path $PSScriptRoot -Parent)
function Step($text) { Write-Host "`n==> $text" -ForegroundColor Cyan }
function Download($url, $out) {
  $args = @('-L', '--fail', '--progress-bar', '-o', $out, $url)
  if ($Proxy) { $args = @('-x', $Proxy) + $args }
  & curl.exe @args
  if ($LASTEXITCODE -ne 0) { throw "Download failed: $url" }
}

Step 'Checking prerequisites'
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js 24 or newer is required: https://nodejs.org' }
# Windows PowerShell drops double quotes inside arguments to programs, so the JavaScript uses single quotes.
$major = [int](node -p "process.versions.node.split('.')[0]")
if ($major -lt 24) { throw "Node.js 24 or newer is required (found $(node -v)). Put Node 24 first on PATH and run this again." }
if (-not (Get-Command curl.exe -ErrorAction SilentlyContinue)) { throw 'curl.exe is required (included with Windows 10 1803 and later).' }

Step 'Installing local speech recognition (whisper.cpp)'
$whisper = Join-Path 'build' 'whisper'
$gpu = $null
if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) { $gpu = (nvidia-smi --query-gpu=name --format=csv,noheader | Select-Object -First 1) }
if (Test-Path (Join-Path $whisper 'whisper-server.exe')) {
  Write-Host "whisper.cpp is already in $whisper"
} else {
  # The CUDA 12 build includes cuBLAS; the smaller CUDA 11.8 build does not and silently falls back to the CPU.
  $asset = if ($gpu) { 'whisper-bin-win-cuda-12.4.0-x64.zip' } else { 'whisper-bin-x64.zip' }
  Write-Host ($(if ($gpu) { "NVIDIA GPU found ($gpu): using the CUDA build (about 680 MB)." } else { 'No NVIDIA GPU found: using the CPU build.' }))
  $zip = Join-Path $env:TEMP $asset
  Download "https://github.com/ggml-org/whisper.cpp/releases/download/$WhisperRelease/$asset" $zip
  $unpacked = Join-Path 'build' 'whisper-unpack'
  if (Test-Path $unpacked) { Remove-Item -Recurse -Force $unpacked }
  New-Item -ItemType Directory -Force $unpacked | Out-Null
  tar -xf $zip -C $unpacked
  $server = Get-ChildItem $unpacked -Recurse -Filter 'whisper-server.exe' | Select-Object -First 1
  if (-not $server) { throw "whisper-server.exe was not found in $asset." }
  Move-Item $server.Directory.FullName $whisper
  Remove-Item -Recurse -Force $unpacked, $zip
}

Step 'Installing JavaScript dependencies'
$npmArgs = @('install', '--no-audit', '--no-fund')
if ($Proxy) { $npmArgs += @('--proxy', $Proxy, '--https-proxy', $Proxy) }
& npm @npmArgs
if ($LASTEXITCODE -ne 0) { throw 'npm install failed.' }

$model = node --input-type=module -e "import('./server/asr/models.ts').then((m) => console.log(m.recommendModel()))"
Step "Downloading the speech model $model (once; other sizes are in Settings > Transcription)"
$models = if ($env:CHUMI_MODELS_DIR) { $env:CHUMI_MODELS_DIR } else { Join-Path $env:LOCALAPPDATA 'Chumi\models' }
New-Item -ItemType Directory -Force $models | Out-Null
$installed = { node --input-type=module -e "import('./server/asr/models.ts').then((m) => process.exit(m.isInstalled('$model') ? 0 : 1))"; $LASTEXITCODE -eq 0 }
if (-not (& $installed)) {
  Download "$ModelBaseUrl/$model" (Join-Path $models "$model.part")
  Move-Item -Force (Join-Path $models "$model.part") (Join-Path $models $model)
  if (-not (& $installed)) { throw "The model download looks incomplete. Delete $models\$model and run this again." }
} else { Write-Host "$model is already in $models" }

Step 'Building the web interface'
npm run build:web
if ($LASTEXITCODE -ne 0) { throw 'Building the web interface failed.' }

Step 'Done'
Write-Host 'Start Chumi:         npm start   then open http://127.0.0.1:4777'
Write-Host 'AI (ChatGPT plan):   codex login   (choose "Sign in with ChatGPT")'
Write-Host 'Live microphone and computer-audio capture are not available on Windows yet (docs\windows.md).'
