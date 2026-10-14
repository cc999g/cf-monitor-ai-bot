# ============================================================
# CF Monitor AI Bot 一键部署脚本 (Windows PowerShell)
# 用法：
#   1) 复制 .env.example 为 .env 并填写（必填4项，其余可留空自动生成）
#   2) 运行：powershell -ExecutionPolicy Bypass -File .\deploy.ps1
# 脚本会：自动创建/复用 KV → 生成缺失密钥 → 配置 wrangler → 设置 Secrets → 部署
# ============================================================
$ErrorActionPreference = 'Stop'
Write-Host "`n=== CF Monitor AI Bot 一键部署 ===`n" -ForegroundColor Cyan

# ---------- 1. 读取 .env ----------
if (!(Test-Path .env)) {
    Write-Host "❌ 未找到 .env，请先：`n   1) 复制 .env.example 为 .env`n   2) 填入必填项`n" -ForegroundColor Red
    exit 1
}
$cfg = @{}
Get-Content .env | ForEach-Object {
    if ($_ -match '^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$') {
        $v = $matches[2].Trim().Trim('"', "'")
        $cfg[$matches[1]] = $v
    }
}

# ---------- 2. 校验必填项 ----------
$required = @('CF_API_TOKEN', 'CF_ACCOUNT_ID', 'TG_BOT_TOKEN', 'TG_CHAT_ID')
$missing = @($required | Where-Object { !$cfg[$_] })
if ($missing.Count -gt 0) {
    Write-Host "❌ .env 缺少必填项：$($missing -join ', ')" -ForegroundColor Red
    exit 1
}

# ---------- 3. 自动生成缺失的密钥 ----------
function New-Rand($n) {
    $chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
    -join (1..$n | ForEach-Object { $chars[(Get-Random -Maximum $chars.Length)] })
}
$auto = @{
    SETUP_KEY        = if ($cfg['SETUP_KEY']) { $cfg['SETUP_KEY'] } else { 'setup-' + (New-Rand 20) }
    TG_WEBHOOK_SECRET = if ($cfg['TG_WEBHOOK_SECRET']) { $cfg['TG_WEBHOOK_SECRET'] } else { New-Rand 32 }
    TG_ACCESS_CODE   = if ($cfg['TG_ACCESS_CODE']) { $cfg['TG_ACCESS_CODE'] } else { 'admin-' + (New-Rand 8) }
    TG_MEMBER_CODE   = if ($cfg['TG_MEMBER_CODE']) { $cfg['TG_MEMBER_CODE'] } else { 'member-' + (New-Rand 8) }
}
foreach ($k in $auto.Keys) { $cfg[$k] = $auto[$k] }

# ---------- 4. KV 命名空间（自动创建/复用） ----------
$kvName = if ($cfg['KV_NAMESPACE']) { $cfg['KV_NAMESPACE'] } else { 'cf-bot-access' }
$env:CLOUDFLARE_API_TOKEN = $cfg['CF_API_TOKEN']
$env:CLOUDFLARE_ACCOUNT_ID = $cfg['CF_ACCOUNT_ID']

Write-Host "`n[1/4] 检查 KV 命名空间..." -ForegroundColor Yellow
$kvOut = (& npx wrangler@4 kv namespace list 2>&1) -join "`n"
$kvId = ([regex]::Match($kvOut, '[a-f0-9]{32}')).Value
$exists = $kvOut -match [regex]::Escape($kvName)
if ($exists -and $kvId) {
    Write-Host "  ✅ 已存在：$kvName ($kvId)" -ForegroundColor Green
} else {
    Write-Host "  ⏳ 创建中..." -ForegroundColor Yellow
    $createOut = (& npx wrangler@4 kv namespace create $kvName 2>&1) -join "`n"
    $kvId = ([regex]::Match($createOut, '[a-f0-9]{32}')).Value
    if (!$kvId) {
        Write-Host "❌ 创建 KV 失败，输出：$createOut`n请手动在 Dashboard 创建后把 ID 填入 wrangler.toml" -ForegroundColor Red
        exit 1
    }
    Write-Host "  ✅ 已创建：$kvName ($kvId)" -ForegroundColor Green
}

# ---------- 5. 生成本地部署配置（不污染仓库模板） ----------
Write-Host "`n[2/4] 生成 wrangler.local.toml..." -ForegroundColor Yellow
$tmpl = Get-Content wrangler.toml -Raw
$tmpl = $tmpl -replace '<你的KV命名空间ID>', $kvId
$tmpl = $tmpl -replace '<你的Cloudflare账户ID>', $cfg['CF_ACCOUNT_ID']
$tmpl = $tmpl -replace '<你的Telegram Chat ID>', $cfg['TG_CHAT_ID']
Set-Content -Path wrangler.local.toml -Value $tmpl -Encoding UTF8
Write-Host "  ✅ 已生成（wrangler.local.toml 已被 .gitignore 排除，不会上传）" -ForegroundColor Green

# ---------- 6. 设置 Secrets ----------
Write-Host "`n[3/4] 设置 Secrets..." -ForegroundColor Yellow
$secrets = @{
    'TG_BOT_TOKEN'      = $cfg['TG_BOT_TOKEN']
    'CF_API_TOKEN'      = $cfg['CF_API_TOKEN']
    'SETUP_KEY'         = $cfg['SETUP_KEY']
    'TG_ACCESS_CODE'    = $cfg['TG_ACCESS_CODE']
    'TG_MEMBER_CODE'    = $cfg['TG_MEMBER_CODE']
    'TG_WEBHOOK_SECRET' = $cfg['TG_WEBHOOK_SECRET']
}
foreach ($k in $secrets.Keys) {
    Write-Host "  · $k" -ForegroundColor Gray
    $null = (& cmd /c "echo|set /p=`"$($secrets[$k])`" | npx wrangler@4 secret put $k --config wrangler.local.toml" 2>&1)
}

# ---------- 7. 部署 ----------
Write-Host "`n[4/4] 部署 Worker..." -ForegroundColor Yellow
$dep = (& npx wrangler@4 deploy --config wrangler.local.toml 2>&1)
$dep | ForEach-Object { Write-Host "  $_" -ForegroundColor Gray }

# ---------- 8. 打印结果 ----------
Write-Host "`n========== ✅ 部署完成 ==========" -ForegroundColor Green
Write-Host "已生成/使用的配置（请保存）："
Write-Host "  管理员邀请码 : $($cfg['TG_ACCESS_CODE'])"
Write-Host "  成员邀请码   : $($cfg['TG_MEMBER_CODE'])"
Write-Host "  SETUP_KEY    : $($cfg['SETUP_KEY'])"
if ($cfg['WORKER_SUBDOMAIN']) {
    Write-Host "`n最后一步，注册 Webhook（复制到 CMD 运行）："
    Write-Host "  curl `"https://cf-monitor-ai-bot.$($cfg['WORKER_SUBDOMAIN']).workers.dev/setup`" -H `"X-Setup-Key: $($cfg['SETUP_KEY'])`"" -ForegroundColor Cyan
} else {
    Write-Host "`n最后一步，注册 Webhook（把 <子域名> 换成你的，例如 nezsad）："
    Write-Host "  curl `"https://cf-monitor-ai-bot.<子域名>.workers.dev/setup`" -H `"X-Setup-Key: $($cfg['SETUP_KEY'])`"" -ForegroundColor Cyan
}
Write-Host "`n在 Telegram 里用管理员码激活后即可使用。`n" -ForegroundColor Gray
