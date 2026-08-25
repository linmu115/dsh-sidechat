param(
  [string]$DshCommand = "",
  [string]$CoreTarball = "",
  [string]$SidechatTarball = "",
  [int]$Port = 0,
  [string]$PlaywrightGrep = "",
  [ValidateSet("compatible", "missing", "incompatible")][string]$CoreMode = "compatible",
  [switch]$KeepHome
)

$ErrorActionPreference = "Stop"
function Write-Utf8NoBom([string]$Path, [string]$Text) {
  [IO.File]::WriteAllText($Path, $Text, [Text.UTF8Encoding]::new($false))
}
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $DshCommand) {
  if ($env:DSH_CMD) { $DshCommand = $env:DSH_CMD }
  else {
    $resolvedDsh = Get-Command dsh.cmd, dsh -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($resolvedDsh) { $DshCommand = $resolvedDsh.Source }
  }
}
if ($CoreMode -ne "missing" -and -not $CoreTarball) {
  $coreRepo = Join-Path (Split-Path -Parent $repoRoot) "dsh-annotation-core"
  if (Test-Path -LiteralPath $coreRepo -PathType Container) {
    $CoreTarball = Get-ChildItem -LiteralPath $coreRepo -Filter "dsh-annotation-core-*.tgz" |
      Select-Object -First 1 -ExpandProperty FullName
  }
}
if ($CoreMode -ne "missing" -and -not $CoreTarball) {
  $corePackageJson = (& node -p "require.resolve('dsh-annotation-core/package.json')" | Select-Object -Last 1).Trim()
  if ($LASTEXITCODE -ne 0 -or -not $corePackageJson) { throw "Installed dsh-annotation-core package not found" }
  $corePackageRoot = Split-Path -Parent $corePackageJson
  $coreVersion = (Get-Content -Raw -LiteralPath $corePackageJson | ConvertFrom-Json).version
  $corePackTempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
  $corePackRoot = Join-Path $corePackTempRoot ("dsh-sidechat-core-pack-" + [Guid]::NewGuid().ToString("N"))
  $corePackPackage = Join-Path $corePackRoot "package"
  New-Item -ItemType Directory -Path $corePackPackage | Out-Null
  try {
    foreach ($file in @("package.json", "LICENSE", "README.md", "README_EN.md", "cordis.patch.yml")) {
      Copy-Item -LiteralPath (Join-Path $corePackageRoot $file) -Destination $corePackPackage
    }
    Copy-Item -LiteralPath (Join-Path $corePackageRoot "lib") -Destination $corePackPackage -Recurse
    $CoreTarball = Join-Path $repoRoot "dsh-annotation-core-$coreVersion.tgz"
    & tar.exe -czf $CoreTarball -C $corePackRoot package
    if ($LASTEXITCODE -ne 0) { throw "Packing installed dsh-annotation-core failed" }
  } finally {
    $resolvedCorePackRoot = [IO.Path]::GetFullPath($corePackRoot)
    if ($resolvedCorePackRoot.StartsWith($corePackTempRoot, [StringComparison]::OrdinalIgnoreCase)) {
      Remove-Item -LiteralPath $resolvedCorePackRoot -Recurse -Force
    }
  }
}
if (-not $SidechatTarball) {
  $SidechatTarball = Get-ChildItem -LiteralPath $repoRoot -Filter "*dsh-sidechat-*.tgz" |
    Select-Object -First 1 -ExpandProperty FullName
}
if (-not (Test-Path -LiteralPath $DshCommand -PathType Leaf)) { throw "DSH command not found: $DshCommand" }
if ($CoreMode -ne "missing" -and -not (Test-Path -LiteralPath $CoreTarball -PathType Leaf)) { throw "Core tarball not found: $CoreTarball" }
if (-not (Test-Path -LiteralPath $SidechatTarball -PathType Leaf)) { throw "Sidechat tarball not found: $SidechatTarball" }

$tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$scratch = Join-Path $tempBase ("dsh-sidechat-e2e-" + [Guid]::NewGuid().ToString("N"))
$scratch = [IO.Path]::GetFullPath($scratch)
if (-not $scratch.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase)) { throw "Unsafe scratch path: $scratch" }
New-Item -ItemType Directory -Path $scratch | Out-Null
$marker = Join-Path $scratch ".dsh-sidechat-e2e"
New-Item -ItemType File -Path $marker | Out-Null

$oldHome = $env:DSH_HOME
$oldUrl = $env:DSH_E2E_URL
$oldWorkspace = $env:DSH_E2E_WORKSPACE
$oldSeed = $env:DSH_E2E_SEED_SESSION
$oldCoreMode = $env:DSH_E2E_CORE_MODE
$server = $null
try {
  $env:DSH_HOME = Join-Path $scratch "home"
  $profile = Join-Path $env:DSH_HOME "profiles\web"
  $workspace = Join-Path $scratch "workspace"
  New-Item -ItemType Directory -Path $profile, $workspace -Force | Out-Null
  $manifest = @{
    name = "dsh-profile-web"
    private = $true
    dependencies = @{}
    dsh = @{ profile = @{ bundles = @("@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app") } }
  } | ConvertTo-Json -Depth 8
  Write-Utf8NoBom (Join-Path $profile "package.json") $manifest
  Write-Utf8NoBom (Join-Path $profile "cordis.patch.yml") "[]`n"
  Write-Utf8NoBom (Join-Path $profile "pnpm-workspace.yaml") @"
packages:
  - .
nodeLinker: hoisted
autoInstallPeers: false
allowBuilds:
  node-pty: true
  protobufjs: true
minimumReleaseAgeExclude:
  - dsh-annotation-core
  - dsh-better-sidebar
  - '@evylynn/dsh-sidechat'
"@

  if ($CoreMode -ne "missing") {
    & $DshCommand plugin --profile web add ("file:" + [IO.Path]::GetFullPath($CoreTarball))
    if ($LASTEXITCODE -ne 0) { throw "Installing dsh-annotation-core failed" }
    if ($CoreMode -eq "incompatible") {
      $installedClient = Join-Path $profile "node_modules\dsh-annotation-core\lib\client.js"
      if (-not (Test-Path -LiteralPath $installedClient -PathType Leaf)) { throw "Installed core client bundle not found: $installedClient" }
      $clientCode = [IO.File]::ReadAllText($installedClient)
      if (($clientCode.Split("0.1.0").Length - 1) -ne 1) { throw "Expected exactly one core client version marker" }
      # pnpm may hard-link the installed file to its content-addressed store.
      # Replace the directory entry with a new file instead of editing that
      # inode in place, so the disposable fault lane cannot mutate the store.
      $variantClient = "$installedClient.incompatible.tmp"
      Write-Utf8NoBom $variantClient ($clientCode.Replace("0.1.0", "0.2.0-incompatible-e2e"))
      [IO.File]::Move($variantClient, $installedClient, $true)
    }
  }
  $betterSidebarVersion = if ($env:BS_VERSION) { $env:BS_VERSION } else { "0.16.0" }
  & $DshCommand plugin --profile web add "dsh-better-sidebar@$betterSidebarVersion"
  if ($LASTEXITCODE -ne 0) { throw "Installing dsh-better-sidebar failed" }
  & $DshCommand plugin --profile web add ("file:" + [IO.Path]::GetFullPath($SidechatTarball))
  if ($LASTEXITCODE -ne 0) { throw "Installing dsh-sidechat failed" }

  $seedSession = (& node (Join-Path $PSScriptRoot "seed-session.mjs") $env:DSH_HOME $workspace | Select-Object -Last 1).Trim()
  if (-not $seedSession) { throw "Seeding the disposable session failed" }
  Write-Host "Disposable session seeded: $seedSession"

  if ($Port -eq 0) {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $listener.Start(); $Port = ([Net.IPEndPoint]$listener.LocalEndpoint).Port; $listener.Stop()
  }
  $stdout = Join-Path $scratch "web.stdout.log"
  $stderr = Join-Path $scratch "web.stderr.log"
  $server = Start-Process -FilePath $DshCommand -ArgumentList @("web", "--port", "$Port", "--no-open") -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru -WindowStyle Hidden
  $url = "http://127.0.0.1:$Port"
  $ready = $false
  Add-Type -AssemblyName System.Net.Http
  $readyHandler = [Net.Http.HttpClientHandler]::new()
  $readyHandler.UseProxy = $false
  $readyClient = [Net.Http.HttpClient]::new($readyHandler)
  $readyClient.Timeout = [TimeSpan]::FromSeconds(2)
  try {
    for ($attempt = 0; $attempt -lt 120; $attempt += 1) {
      if ($server.HasExited) { throw "Disposable DSH exited early. See $stdout and $stderr" }
      try {
        $response = $readyClient.GetAsync($url).GetAwaiter().GetResult()
        if ([int]$response.StatusCode -eq 200) { $ready = $true; break }
      } catch {}
      Start-Sleep -Milliseconds 500
    }
  } finally {
    $readyClient.Dispose()
    $readyHandler.Dispose()
  }
  if (-not $ready) { throw "Disposable DSH did not become ready at $url" }
  Write-Host "Disposable DSH ready: $url"

  try {
    $body = @{ type = "client-request"; rpcId = "e2e-workspace"; method = "workspace.create"; payload = @{ path = $workspace } } | ConvertTo-Json -Depth 4
    Invoke-RestMethod -Uri "$url/api/workspace.create" -Method Post -ContentType "application/json" -Body $body -TimeoutSec 5 | Out-Null
  } catch { Write-Warning "workspace.create was not confirmed: $_" }
  Write-Host "Starting Playwright mount lanes"

  $env:DSH_E2E_URL = $url
  $env:DSH_E2E_WORKSPACE = $workspace
  $env:DSH_E2E_SEED_SESSION = $seedSession
  $env:DSH_E2E_CORE_MODE = $CoreMode
  if ($PlaywrightGrep) { & pnpm exec playwright test --grep $PlaywrightGrep }
  else { & pnpm exec playwright test }
  if ($LASTEXITCODE -ne 0) { throw "Playwright mount lanes failed" }
} finally {
  if ($server -and -not $server.HasExited) {
    & taskkill.exe /PID $server.Id /T /F 2>$null | Out-Null
    $server.WaitForExit(5000) | Out-Null
  }
  $env:DSH_HOME = $oldHome
  $env:DSH_E2E_URL = $oldUrl
  $env:DSH_E2E_WORKSPACE = $oldWorkspace
  $env:DSH_E2E_SEED_SESSION = $oldSeed
  $env:DSH_E2E_CORE_MODE = $oldCoreMode
  if (-not $KeepHome) {
    $resolved = [IO.Path]::GetFullPath($scratch)
    if ($resolved.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $marker)) {
      for ($cleanupAttempt = 0; $cleanupAttempt -lt 5; $cleanupAttempt += 1) {
        try { Remove-Item -LiteralPath $resolved -Recurse -Force; break }
        catch {
          if ($cleanupAttempt -eq 4) { throw }
          Start-Sleep -Milliseconds 250
        }
      }
    } else { Write-Warning "Refusing to remove unverified scratch path: $resolved" }
  } else { Write-Host "Disposable home kept at $scratch" }
}
