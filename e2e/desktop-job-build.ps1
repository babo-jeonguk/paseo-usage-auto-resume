param([Parameter(Mandatory=$true)][string]$Output)
$ErrorActionPreference = 'Stop'

# Invoke the compiler directly. Windows PowerShell's CodeDOM cannot compile from every Unicode temp path.
$compiler = Join-Path ([Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()) 'csc.exe'
& $compiler /nologo /target:exe "/out:$Output" (Join-Path $PSScriptRoot 'desktop-job.cs')
exit $LASTEXITCODE
