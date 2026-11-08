# Fresh-machine install test for Windows (FR-CLI-06), plus a signed in-place update through the
# installed service (FR-CLI-05, NFR-REL-02). Used by the on-demand installers workflow; run from
# the repository root after `pnpm install`. It signs with a throwaway key made for this run only.
$ErrorActionPreference = 'Stop'
$Work = Join-Path $env:RUNNER_TEMP ("advence-" + [guid]::NewGuid())
$FeedDir = Join-Path $Work 'feed'
New-Item -ItemType Directory -Force -Path (Join-Path $FeedDir 'server') | Out-Null
$Feed = 'http://127.0.0.1:8899'
$env:ADVENCE_SKIP_PAIR = '1'

function Health { try { (& curl.exe -fsk https://127.0.0.1:4443/v1/health) } catch { '' } }
function WaitVersion($v) {
  for ($i = 0; $i -lt 120; $i++) { if ((Health) -match "`"version`":`"$v`"") { Write-Host "server reports $v"; return } ; Start-Sleep 1 }
  throw "server did not report $v"
}
function Publish($v, $skip) {
  Get-ChildItem (Join-Path $FeedDir 'server') | Remove-Item -Force
  $a = @('scripts/release/bundle-server.mjs', '--version', $v, '--out', (Join-Path $FeedDir 'server'))
  if ($skip) { $a += '--skip-build' }
  node @a; if ($LASTEXITCODE) { throw 'bundle failed' }
  node scripts/release/manifest.mjs --component server --version $v --dir (Join-Path $FeedDir 'server') --out (Join-Path $FeedDir 'server/manifest.json'); if ($LASTEXITCODE) { throw 'manifest failed' }
  node scripts/release/sign.mjs --key-file (Join-Path $Work 'release.key') (Join-Path $FeedDir 'server/manifest.json'); if ($LASTEXITCODE) { throw 'sign failed' }
}

$out = node scripts/release/keygen.mjs --out (Join-Path $Work 'release.key')
$pub = ($out | Select-String 'ADVENCE_RELEASE_PUBKEY\): (.+)$').Matches[0].Groups[1].Value
$env:ADVENCE_RELEASE_PUBKEY = $pub
$env:ADVENCE_FEED_URL = $Feed
Publish '0.9.0' $false
node scripts/release/render-installers.mjs --feed $Feed --keys $pub --out $FeedDir
$http = Start-Process -PassThru -WindowStyle Hidden python -ArgumentList '-m', 'http.server', '8899', '--bind', '127.0.0.1', '--directory', $FeedDir
Start-Sleep 2

Write-Host '== a tampered bundle is refused'
$bundle = (Get-ChildItem (Join-Path $FeedDir 'server') -Filter '*.tar.gz').FullName
Copy-Item $bundle (Join-Path $Work 'good.tar.gz')
Add-Content -Path $bundle -Value 'x' -NoNewline
powershell -ExecutionPolicy Bypass -c "irm $Feed/install.ps1 | iex"
if ($LASTEXITCODE -eq 0) { throw 'tampered install succeeded' }
Copy-Item (Join-Path $Work 'good.tar.gz') $bundle -Force

Write-Host '== fresh install'
powershell -ExecutionPolicy Bypass -c "irm $Feed/install.ps1 | iex"
if ($LASTEXITCODE) { throw 'install failed' }
WaitVersion '0.9.0'
$advence = Join-Path $env:LOCALAPPDATA 'Advence\bin\advence.cmd'
& $advence version

Write-Host '== signed update through the running service'
Publish '0.9.1' $true
$check = & $advence update check
Write-Host $check
if (-not ($check -match 'Update available: 0.9.1')) { throw 'update not found' }
& $advence update apply
if ($LASTEXITCODE) { throw 'update apply failed' }
WaitVersion '0.9.1'
Stop-Process -Id $http.Id -Force -ErrorAction SilentlyContinue
Write-Host 'fresh install and update passed'
