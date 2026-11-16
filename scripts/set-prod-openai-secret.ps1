# Sets the PRODUCTION OpenAI key as a Supabase Edge Function secret, without the key ever appearing in a chat, a command line,
# a log or the repository. Run it yourself, in your own PowerShell window, only when the release runbook says so.
#
#   powershell -ExecutionPolicy Bypass -File scripts\set-prod-openai-secret.ps1 -ProjectRef <PROJECT_REF>
#
# Requirements (human): `npx supabase login` done once; a NEW OpenAI project for production (NOT the smoke-test project) with a hard
# monthly budget and a project key restricted to Responses (write) + Models (read).
# It prompts with a hidden Read-Host -AsSecureString, checks the key FORMAT only, writes it to a temporary env file that only your
# account can read, runs `supabase secrets set --env-file`, then overwrites and deletes the temporary file. It sets ONLY
# OPENAI_API_KEY. The enable flags (AI_ASSESSMENT_ENABLED / AI_MATCHING_ENABLED) are separate steps of the runbook.
param(
  [Parameter(Mandatory = $true)][string]$ProjectRef,
  # Guard: the throw-away smoke-test key must never become the production key. Its local file (if still present) is compared, never printed.
  [string]$SmokeEnvFile = (Join-Path $env:USERPROFILE '.uxbarter\openai-smoke.env')
)
$ErrorActionPreference = 'Stop'
if ($ProjectRef -notmatch '^[a-z0-9]{20}$') { Write-Host 'ProjectRef must be the 20-character Supabase project reference.' -ForegroundColor Red; exit 2 }

$secure = Read-Host -Prompt 'Paste the PRODUCTION OpenAI project key (hidden), then press Enter' -AsSecureString
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try { $key = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr).Trim() } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr); $secure.Dispose() }
if ($key -notmatch '^sk-(proj|svcacct)-[A-Za-z0-9_-]{20,}$') { $key = $null; Write-Host 'Not a project-scoped OpenAI key (sk-proj-... / sk-svcacct-...). Nothing was set.' -ForegroundColor Red; exit 2 }

if (Test-Path -LiteralPath $SmokeEnvFile) {
  $old = (Get-Content -LiteralPath $SmokeEnvFile | Where-Object { $_ -match '^OPENAI_API_KEY=' } | Select-Object -First 1)
  if ($old -and $old.Substring('OPENAI_API_KEY='.Length).Trim() -ceq $key) { $key = $null; $old = $null; Write-Host 'This is the SMOKE-TEST key. Create a NEW OpenAI project + key for production. Nothing was set.' -ForegroundColor Red; exit 2 }
  $old = $null
}

$tmp = Join-Path $env:TEMP ("uxb-secret-" + [guid]::NewGuid().ToString('N') + '.env')
try {
  [IO.File]::WriteAllText($tmp, "OPENAI_API_KEY=$key`r`n", (New-Object Text.UTF8Encoding($false)))
  $key = $null
  & icacls.exe $tmp /inheritance:r | Out-Null
  & icacls.exe $tmp /grant:r "$([Security.Principal.WindowsIdentity]::GetCurrent().Name):(R,W)" | Out-Null
  & npx.cmd supabase secrets set --env-file $tmp --remote=$ProjectRef
  if ($LASTEXITCODE -ne 0) { Write-Host 'supabase secrets set failed (are you logged in? `npx supabase login`).' -ForegroundColor Red; exit 3 }
  Write-Host 'OPENAI_API_KEY was set as an Edge Function secret (value not shown). The AI features are still OFF until the enable flags are set.' -ForegroundColor Green
} finally {
  if (Test-Path -LiteralPath $tmp) { [IO.File]::WriteAllText($tmp, ('x' * 200)); Remove-Item -LiteralPath $tmp -Force }
}
