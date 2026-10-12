# Minimal static file server for Lingo Reader (no Node/Python needed).
#   powershell -ExecutionPolicy Bypass -File serve.ps1            -> http://localhost:8080 (this PC only)
#   powershell -ExecutionPolicy Bypass -File serve.ps1 -Lan       -> also reachable from your phone on the same Wi-Fi
#                                                                    (run as Administrator once, or see README)
param([int]$Port = 8080, [switch]$Lan)

$root = $PSScriptRoot
$types = @{
  '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'; '.css' = 'text/css; charset=utf-8'
  '.json' = 'application/json'; '.webmanifest' = 'application/manifest+json'; '.svg' = 'image/svg+xml'
  '.png' = 'image/png'; '.ico' = 'image/x-icon'; '.txt' = 'text/plain; charset=utf-8'
}

$listener = New-Object System.Net.HttpListener
$prefix = if ($Lan) { "http://+:$Port/" } else { "http://localhost:$Port/" }
$listener.Prefixes.Add($prefix)
try { $listener.Start() } catch {
  Write-Host "Could not listen on $prefix : $($_.Exception.Message)"
  if ($Lan) { Write-Host "For -Lan, run once as Administrator:  netsh http add urlacl url=http://+:$Port/ user=Everyone" }
  exit 1
}

Write-Host "Lingo Reader running at http://localhost:$Port/  (Ctrl+C to stop)"
if ($Lan) {
  Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
    ForEach-Object { Write-Host "  On your phone: http://$($_.IPAddress):$Port/" }
}

# ---- /api/transcript?v=<videoId>&lang=<code>[&track=<n>] ----
# Browsers can't read YouTube captions (CORS), so the server fetches them:
# the caption track list comes from YouTube's player API (Android client),
# then the chosen track is downloaded as WebVTT.
$ytClient = @{ clientName = 'ANDROID'; clientVersion = '20.10.38'; androidSdkVersion = 30; hl = 'en' }
$ytAgent = 'com.google.android.youtube/20.10.38 (Linux; U; Android 11) gzip'

function Get-Transcript([string]$videoId, [string]$lang, [string]$track) {
  if ($videoId -notmatch '^[A-Za-z0-9_-]{11}$') { return @{ ok = $false; error = 'bad-id' } }
  $body = @{ context = @{ client = $ytClient }; videoId = $videoId } | ConvertTo-Json -Depth 5
  try {
    $player = Invoke-RestMethod -Method Post -Uri 'https://www.youtube.com/youtubei/v1/player?prettyPrint=false' `
      -ContentType 'application/json' -Body $body -UserAgent $ytAgent -TimeoutSec 15
  } catch { return @{ ok = $false; error = 'network' } }
  $title = $player.videoDetails.title
  $all = @($player.captions.playerCaptionsTracklistRenderer.captionTracks)
  $tracks = @(for ($i = 0; $i -lt $all.Count; $i++) {
    $t = $all[$i]
    $name = if ($t.name.simpleText) { $t.name.simpleText } else { ($t.name.runs | ForEach-Object { $_.text }) -join '' }
    @{ index = $i; lang = $t.languageCode; kind = $(if ($t.kind -eq 'asr') { 'auto' } else { 'manual' }); name = $name }
  })
  if (-not $tracks.Count) {
    return @{ ok = $false; error = 'no-captions'; title = $title; status = $player.playabilityStatus.status }
  }
  # Pick: requested index, else a manual track in the language, else an auto-generated one.
  $pick = $null
  if ($track -match '^\d+$' -and [int]$track -lt $tracks.Count) { $pick = $tracks[[int]$track] }
  if (-not $pick) {
    $inLang = @($tracks | Where-Object { $_.lang -eq $lang -or $_.lang -like "$lang-*" })
    $pick = ($inLang | Where-Object { $_.kind -eq 'manual' } | Select-Object -First 1)
    if (-not $pick) { $pick = $inLang | Select-Object -First 1 }
  }
  if (-not $pick) { return @{ ok = $false; error = 'no-track'; title = $title; tracks = $tracks } }
  $url = ($all[$pick.index].baseUrl -replace '&fmt=[^&]*', '') + '&fmt=vtt'
  try {
    $resp = Invoke-WebRequest -UseBasicParsing -Uri $url -UserAgent $ytAgent -TimeoutSec 15
    $vtt = [Text.Encoding]::UTF8.GetString($resp.RawContentStream.ToArray())
  } catch { return @{ ok = $false; error = 'network'; title = $title; tracks = $tracks } }
  if ($vtt -notmatch '-->') { return @{ ok = $false; error = 'empty'; title = $title; tracks = $tracks } }
  return @{ ok = $true; title = $title; track = $pick; tracks = $tracks; vtt = $vtt }
}

while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  $res = $ctx.Response
  try {
    $rel = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath.TrimStart('/'))
    if ($rel -eq 'api/transcript') {
      $q = $ctx.Request.QueryString
      $result = Get-Transcript $q['v'] $q['lang'] $q['track']
      $res.ContentType = 'application/json; charset=utf-8'
      $res.Headers.Add('Cache-Control', 'no-store')
      $bytes = [Text.Encoding]::UTF8.GetBytes(($result | ConvertTo-Json -Depth 5 -Compress))
      $res.ContentLength64 = $bytes.Length
      $res.OutputStream.Write($bytes, 0, $bytes.Length)
      continue
    }
    if ($rel -eq '') { $rel = 'index.html' }
    $path = [IO.Path]::GetFullPath((Join-Path $root $rel))
    if (-not $path.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path $path -PathType Leaf)) {
      $res.StatusCode = 404
      $bytes = [Text.Encoding]::UTF8.GetBytes('Not found')
    } else {
      $ext = [IO.Path]::GetExtension($path).ToLower()
      $res.ContentType = if ($types.ContainsKey($ext)) { $types[$ext] } else { 'application/octet-stream' }
      $res.Headers.Add('Cache-Control', 'no-cache')
      $bytes = [IO.File]::ReadAllBytes($path)
    }
    $res.ContentLength64 = $bytes.Length
    $res.OutputStream.Write($bytes, 0, $bytes.Length)
  } catch {
    $res.StatusCode = 500
  } finally {
    $res.Close()
  }
}
