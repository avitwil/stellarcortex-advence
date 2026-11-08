# StellarCortex Advence server installer for Windows 11 (FR-CLI-06, D-24).
#   powershell -ExecutionPolicy Bypass -c "irm https://<your feed>/install.ps1 | iex"
# It installs, as the current user and without administrator rights:
#   - the Node.js runtime from nodejs.org, checked against nodejs.org's SHA-256 list
#   - the server bundle from the update feed, checked against the release key pinned below
#   - a scheduled task that starts the server when you sign in, and restarts it if it stops
#   - the `advence` command (added to your user PATH)
# then sets up Podman (Podman machine on WSL2) and the Bot computer image, and shows the pairing
# QR code for your first device. Running it again upgrades in place.
# Environment: ADVENCE_SKIP_COMPUTER=1, ADVENCE_SKIP_SERVICE=1, ADVENCE_SKIP_PAIR=1, ADVENCE_PORT.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Feed = '@FEED_URL@'
$ReleaseKeys = '@RELEASE_KEYS@'

function Fail($msg) { Write-Host "advence install: $msg" -ForegroundColor Red; exit 1 }
if ($Feed.StartsWith('@')) { Fail 'this installer was not prepared by the release build (no feed URL)' }
if ($ReleaseKeys.StartsWith('@') -or -not $ReleaseKeys) { Fail 'this installer has no pinned release key' }
if (-not ($Feed -match '^https://' -or $Feed -match '^http://(127\.0\.0\.1|localhost)')) { Fail 'the feed must use https' }

$Arch = switch ($env:PROCESSOR_ARCHITECTURE) { 'AMD64' { 'x64' } 'ARM64' { 'arm64' } default { Fail "unsupported CPU $($env:PROCESSOR_ARCHITECTURE)" } }
$Root = Join-Path $env:LOCALAPPDATA 'Advence\server'
$Bin = Join-Path $env:LOCALAPPDATA 'Advence\bin'
$Tmp = Join-Path ([IO.Path]::GetTempPath()) ("advence-" + [guid]::NewGuid())
New-Item -ItemType Directory -Force -Path $Tmp, (Join-Path $Root 'versions'), $Bin | Out-Null
function Fetch($url, $out) { Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $out }
$TaskName = 'StellarCortex Advence server'

try {
  Write-Host "StellarCortex Advence: installing into $Root"
  # 1. Manifest. Not trusted yet: it only names the Node.js release, which is checked against
  #    nodejs.org. Its signature is checked with that Node.js in step 3.
  Fetch "$Feed/server/manifest.json" (Join-Path $Tmp 'manifest.json')
  Fetch "$Feed/server/manifest.json.sig" (Join-Path $Tmp 'manifest.json.sig')
  $raw = Get-Content -Raw (Join-Path $Tmp 'manifest.json')
  if ($raw -notmatch '"runtime":\s*"(v\d+\.\d+\.\d+)"') { Fail 'the release manifest names no Node.js runtime' }
  $NodeVersion = $Matches[1]

  # 2. Node.js runtime.
  $NodeDir = Join-Path $Root 'node'
  $Node = Join-Path $NodeDir 'node.exe'
  if (-not (Test-Path $Node) -or ((& $Node -v) -ne $NodeVersion)) {
    $name = "node-$NodeVersion-win-$Arch"
    Write-Host "Downloading Node.js $NodeVersion"
    Fetch "https://nodejs.org/dist/$NodeVersion/$name.zip" (Join-Path $Tmp "$name.zip")
    Fetch "https://nodejs.org/dist/$NodeVersion/SHASUMS256.txt" (Join-Path $Tmp 'SHASUMS256.txt')
    $want = (Get-Content (Join-Path $Tmp 'SHASUMS256.txt') | Where-Object { $_ -match "\s$([regex]::Escape("$name.zip"))$" } | ForEach-Object { ($_ -split '\s+')[0] }) | Select-Object -First 1
    $got = (Get-FileHash -Algorithm SHA256 (Join-Path $Tmp "$name.zip")).Hash.ToLower()
    if (-not $want -or $want -ne $got) { Fail "Node.js download does not match nodejs.org's checksum" }
    Expand-Archive -Path (Join-Path $Tmp "$name.zip") -DestinationPath $Tmp -Force
    if (Test-Path $NodeDir) { Remove-Item -Recurse -Force $NodeDir }
    Move-Item (Join-Path $Tmp $name) $NodeDir
  }

  # 3. Verify the manifest signature against the pinned key, then the bundle's SHA-256 and size.
  $verify = @'
const fs = require('node:fs'), crypto = require('node:crypto');
const [, , dir, keys, platform, arch, feed, mode] = process.argv;
const manifest = fs.readFileSync(`${dir}/manifest.json`);
const sig = Buffer.from(fs.readFileSync(`${dir}/manifest.json.sig`, 'utf8').trim(), 'base64url');
const msg = Buffer.concat([Buffer.from('stellarcortex-advence release v1\n'), manifest]);
const spki = (k) => crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(k, 'base64url')]), format: 'der', type: 'spki' });
const ok = keys.split(',').filter(Boolean).some((k) => { try { return crypto.verify(null, msg, spki(k), sig); } catch { return false; } });
if (!ok) { console.error('the release manifest signature is not valid for the pinned key'); process.exit(3); }
const m = JSON.parse(manifest);
if (m.product !== 'stellarcortex-advence' || m.component !== 'server') { console.error('not a server release'); process.exit(3); }
const f = m.files.find((x) => x.platform === platform && x.arch === arch);
if (!f || !/^[A-Za-z0-9._-]+$/.test(f.name)) { console.error(`no ${platform}-${arch} bundle in ${m.version}`); process.exit(3); }
if (mode === 'check') {
  const data = fs.readFileSync(`${dir}/bundle.tar.gz`);
  if (data.length !== f.size || crypto.createHash('sha256').update(data).digest('hex') !== f.sha256) { console.error('the server bundle does not match the signed manifest'); process.exit(3); }
  process.stdout.write(m.version);
} else process.stdout.write(`${feed}/server/${encodeURIComponent(f.name)}`);
'@
  $verifyJs = Join-Path $Tmp 'verify.cjs'
  Set-Content -Path $verifyJs -Value $verify -Encoding UTF8
  $url = & $Node $verifyJs $Tmp $ReleaseKeys 'win32' $Arch $Feed 'url'
  if ($LASTEXITCODE -ne 0) { Fail 'verification failed; nothing was installed' }
  Write-Host 'Downloading the server bundle'
  Fetch $url (Join-Path $Tmp 'bundle.tar.gz')
  $Version = & $Node $verifyJs $Tmp $ReleaseKeys 'win32' $Arch $Feed 'check'
  if ($LASTEXITCODE -ne 0) { Fail 'verification failed; nothing was installed' }
  Write-Host "Verified release $Version"

  # 4. Extract next to any version already installed (tar.exe ships with Windows 10 and 11).
  $staging = Join-Path $Root 'versions\.staging'
  if (Test-Path $staging) { Remove-Item -Recurse -Force $staging }
  New-Item -ItemType Directory -Force -Path $staging | Out-Null
  & tar.exe -xzf (Join-Path $Tmp 'bundle.tar.gz') -C $staging
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path (Join-Path $staging 'server\dist\main.js'))) { Fail 'the bundle could not be extracted' }
  if (-not $env:ADVENCE_SKIP_SERVICE) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -like "*$Root*launcher.mjs*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  }
  $target = Join-Path $Root "versions\$Version"
  if (Test-Path $target) { Remove-Item -Recurse -Force $target }
  Move-Item $staging $target
  Set-Content -Path (Join-Path $Root 'current') -Value $Version -NoNewline -Encoding ASCII
  Copy-Item (Join-Path $target 'launcher.mjs') (Join-Path $Root 'launcher.mjs') -Force
  Remove-Item (Join-Path $Root 'pending.json') -ErrorAction SilentlyContinue

  # 5. The `advence` command.
  $shim = "@echo off`r`nset /p V=<`"$Root\current`"`r`nset ADVENCE_INSTALL_ROOT=$Root`r`n`"$Node`" `"$Root\versions\%V%\server\dist\main.js`" %*`r`n"
  Set-Content -Path (Join-Path $Bin 'advence.cmd') -Value $shim -Encoding ASCII
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not ($userPath -split ';' | Where-Object { $_ -eq $Bin })) {
    [Environment]::SetEnvironmentVariable('Path', ($(if ($userPath) { "$userPath;" } else { '' }) + $Bin), 'User')
  }
  $env:Path = "$Bin;$env:Path"

  # 6. Service: a per-user scheduled task (rootless Podman machines are per user too).
  $port = if ($env:ADVENCE_PORT) { $env:ADVENCE_PORT } else { '4443' }
  if (-not $env:ADVENCE_SKIP_SERVICE) {
    $cmd = Join-Path $Root 'run-server.cmd'
    $portLine = if ($env:ADVENCE_PORT) { "set ADVENCE_PORT=$($env:ADVENCE_PORT)`r`n" } else { '' }
    Set-Content -Path $cmd -Encoding ASCII -Value "@echo off`r`n$portLine`"$Node`" `"$Root\launcher.mjs`"`r`n"
    # conhost --headless keeps the console window hidden (Windows 11).
    $action = New-ScheduledTaskAction -Execute 'conhost.exe' -Argument "--headless `"$cmd`""
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description 'StellarCortex Advence server' -Force | Out-Null
    Start-ScheduledTask -TaskName $TaskName
    Write-Host 'Waiting for the server to start'
    $ok = $false
    for ($i = 0; $i -lt 60 -and -not $ok; $i++) {
      try {
        $r = & curl.exe -fsk "https://127.0.0.1:$port/v1/health"
        if ($LASTEXITCODE -eq 0) { $ok = $true } else { Start-Sleep 1 }
      } catch { Start-Sleep 1 }
    }
    if (-not $ok) { Fail 'the server did not start' }
    Write-Host "Server $Version is running. Windows may ask to allow it through the firewall so your devices can reach it."
  }

  # 7. Bot computers: Podman machine and the image (FR-PC-07).
  if (-not $env:ADVENCE_SKIP_COMPUTER) {
    & (Join-Path $Bin 'advence.cmd') computer setup --yes
    if ($LASTEXITCODE -ne 0) { Write-Host "Bot computers are not ready yet; run 'advence computer setup' later." }
  }

  # 8. First device.
  if (-not $env:ADVENCE_SKIP_PAIR -and [Environment]::UserInteractive) { & (Join-Path $Bin 'advence.cmd') pair }
  else { Write-Host 'Pair your first device with: advence pair' }
  Write-Host 'Done.'
} finally {
  Remove-Item -Recurse -Force $Tmp -ErrorAction SilentlyContinue
}
