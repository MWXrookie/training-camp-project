$ErrorActionPreference = "Stop"
$env:PORT = "4174"
Write-Host "Starting Recall AI teacher test app on http://localhost:4174/"
Write-Host "Access code: recall"
Write-Host "Press Ctrl+C to stop."
node .\server.mjs
