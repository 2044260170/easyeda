# ⚠️ 用 Node.js fetch() 检测 bridge，Invoke-RestMethod 不可靠
$BRIDGE_PORT = $null
foreach ($port in 49620..49629) {
  $r = node -e "fetch('http://127.0.0.1:$port/health').then(r=>r.json()).then(j=>console.log(j.service)).catch(()=>{})" 2>$null
  if ($r -eq 'easyeda-bridge') { $BRIDGE_PORT = $port; break }
}
if (-not $BRIDGE_PORT) {
  Set-Location "$env:USERPROFILE\.claude\skills\easyeda-api-skill"
  Start-Process node -ArgumentList 'scripts/bridge-server.mjs' -NoNewWindow
  Start-Sleep 3
  foreach ($port in 49620..49629) {
    $r = node -e "fetch('http://127.0.0.1:$port/health').then(r=>r.json()).then(j=>console.log(j.service)).catch(()=>{})" 2>$null
    if ($r -eq 'easyeda-bridge') { $BRIDGE_PORT = $port; break }
  }
}
Write-Output "BRIDGE_PORT=$BRIDGE_PORT"
