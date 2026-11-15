# Interactive, local-only setup of the OpenAI key used by scripts/ai-smoke-test.mjs.
#
#   powershell -ExecutionPolicy Bypass -File scripts\setup-openai-smoke-key.ps1
#
# - prompts with Read-Host -AsSecureString (hidden input): paste the key into THIS window, never into a chat
# - validates the FORMAT only (project-scoped key: sk-proj-... or sk-svcacct-...) without ever printing it
# - writes it to  %USERPROFILE%\.uxbarter\openai-smoke.env  (replacing any previous file), outside every git repository
# - restricts the file to the current Windows account (inheritance removed, one explicit grant)
# - prints only a masked confirmation. The key is never printed, logged, committed or sent anywhere by this script.
param(
  [string]$Path = (Join-Path $env:USERPROFILE '.uxbarter\openai-smoke.env'),
  # TEST ONLY: read the key from this environment variable name instead of prompting (used by the script's own self-test).
  [string]$FromEnvVarForSelfTest = ''
)
$ErrorActionPreference = 'Stop'

function Get-PlainKey {
  if ($FromEnvVarForSelfTest) { return [Environment]::GetEnvironmentVariable($FromEnvVarForSelfTest) }
  $secure = Read-Host -Prompt 'Paste the OpenAI API key (input is hidden), then press Enter' -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr); $secure.Dispose() }
}

$key = Get-PlainKey
if ($null -ne $key) { $key = $key.Trim().Trim('"').Trim("'") }
if ([string]::IsNullOrEmpty($key)) { Write-Host 'No key entered. Nothing was written.' -ForegroundColor Red; exit 2 }
if ($key -notmatch '^sk-(proj|svcacct)-[A-Za-z0-9_-]{20,}$') {
  $key = $null
  Write-Host 'The value does not look like a project-scoped OpenAI key (expected sk-proj-... or sk-svcacct-...). Nothing was written. Nothing was echoed.' -ForegroundColor Red
  exit 2
}
$type = if ($key.StartsWith('sk-proj-')) { 'project key (sk-proj-)' } else { 'service-account key (sk-svcacct-)' }
$length = $key.Length

$dir = Split-Path -Parent $Path
New-Item -ItemType Directory -Force -Path $dir | Out-Null
if (Test-Path -LiteralPath $Path) { Remove-Item -LiteralPath $Path -Force }   # replace any previous (possibly invalid) file
[IO.File]::WriteAllText($Path, "OPENAI_API_KEY=$key`r`n", (New-Object Text.UTF8Encoding($false)))
$key = $null

# only the current account may read/write; drop inherited permissions
$me = [Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls.exe $Path /inheritance:r | Out-Null
& icacls.exe $Path /grant:r "${me}:(R,W)" | Out-Null
$acl = (Get-Acl -LiteralPath $Path).Access
$others = @($acl | Where-Object { $_.IdentityReference.Value -ne $me })
if ($others.Count -gt 0) { Write-Host 'WARNING: other accounts still have access to the file:' ($others.IdentityReference.Value -join ', ') -ForegroundColor Yellow }

Write-Host ''
Write-Host "Key saved: $Path" -ForegroundColor Green
Write-Host "  type: $type, $length characters (format valid; the key itself is not shown)"
Write-Host "  access: $($acl.Count) entry/entries, owner-only: $($others.Count -eq 0)"
Write-Host 'You can close this window. Tell the agent the key is configured.'
