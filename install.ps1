# One-line installer for production-backend (Windows). Works from Command Prompt or PowerShell:
#   powershell -ExecutionPolicy Bypass -c "irm https://raw.githubusercontent.com/ahujakush/skills/main/install.ps1 | iex"
# Uses the skills CLI when Node.js is available (so installs show on skills.sh),
# and falls back to a direct download when it isn't.
$ErrorActionPreference = "Stop"
$Repo = "ahujakush/skills"
$Skill = "production-backend"
$H = [Environment]::GetFolderPath("UserProfile")

$Agents = @("-a", "claude-code")
function P([string[]]$parts) { $r = $H; foreach ($x in $parts) { $r = Join-Path $r $x }; return $r }
if (Test-Path (P ".codex"))  { $Agents += @("-a", "codex") }
if (Test-Path (P ".cursor")) { $Agents += @("-a", "cursor") }
if (Test-Path (P ".gemini")) { $Agents += @("-a", "antigravity") }

function Get-NodeVersion {
  try { $v = (& node -v) 2>$null } catch { return $null }
  if ($v -match '^v(\d+)\.(\d+)') { return @([int]$Matches[1], [int]$Matches[2]) }
  return $null
}

function Install-WithCli($pkg) {
  Write-Host "-> Installing with the skills CLI ($pkg)..."
  & npx -y $pkg add $Repo --skill $Skill -g @Agents -y
  if ($LASTEXITCODE -eq 0) { return $true }
  # A broken npm cache makes npx fail: retry once with a fresh one.
  Write-Host "  The skills CLI failed, retrying with a fresh npm cache..."
  $env:npm_config_cache = Join-Path ([IO.Path]::GetTempPath()) ("npm-" + [guid]::NewGuid())
  & npx -y $pkg add $Repo --skill $Skill -g @Agents -y
  return ($LASTEXITCODE -eq 0)
}

function Install-Direct {
  Write-Host "-> Installing by direct download..."
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ("pb-" + [guid]::NewGuid())
  New-Item -ItemType Directory -Path $tmp | Out-Null
  $zip = Join-Path $tmp "skills.zip"
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  Invoke-WebRequest -UseBasicParsing "https://codeload.github.com/$Repo/zip/refs/heads/main" -OutFile $zip
  Expand-Archive -Path $zip -DestinationPath $tmp -Force
  $src = Join-Path (Join-Path (Join-Path $tmp "skills-main") "skills") $Skill
  $targets = @((P ".claude","skills"))
  if (Test-Path (P ".codex"))  { $targets += (P ".agents","skills") }
  if (Test-Path (P ".cursor")) { $targets += (P ".cursor","skills") }
  if (Test-Path (P ".gemini")) { $targets += (P ".gemini","antigravity","skills") }
  foreach ($t in $targets) {
    New-Item -ItemType Directory -Force -Path $t | Out-Null
    $dest = Join-Path $t $Skill
    if (Test-Path $dest) { Remove-Item -Recurse -Force $dest }
    Copy-Item -Recurse $src $dest
    Write-Host "  OK $dest"
  }
  Remove-Item -Recurse -Force $tmp
}

function Test-Git {
  try { & git --version *> $null; return ($LASTEXITCODE -eq 0) } catch { return $false }
}

$nv = Get-NodeVersion
$ok = $false
try {
  if (-not (Test-Git)) {
    Write-Host "git isn't installed, so skipping the skills CLI."
  } elseif ($nv -and ($nv[0] -gt 22 -or ($nv[0] -eq 22 -and $nv[1] -ge 20))) {
    $ok = Install-WithCli "skills@latest"
  } elseif ($nv -and $nv[0] -ge 18) {
    Write-Host "Node v$($nv[0]).$($nv[1]) found (the latest skills CLI needs 22.20+), using skills@1.5.18."
    $ok = Install-WithCli "skills@1.5.18"
  } else {
    Write-Host "Node.js 18+ not found, so skipping the skills CLI."
  }
} catch { $ok = $false }
if (-not $ok) { Install-Direct }

Write-Host ""
Write-Host "Done! production-backend is installed. Restart Claude Code (or your agent) and ask:"
Write-Host '  "make my backend production ready"'
