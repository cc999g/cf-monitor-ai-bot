#!/usr/bin/env bash
# ============================================================
# CF Monitor AI Bot 一键部署脚本 (Linux / macOS)
# 用法：
#   1) cp .env.example .env 并填写（必填4项，其余可留空自动生成）
#   2) chmod +x deploy.sh && ./deploy.sh
# Windows 用户请用 deploy.ps1
# ============================================================
set -e
echo ""
echo "=== CF Monitor AI Bot 一键部署 ==="

# ---------- 1. 读取 .env ----------
if [ ! -f .env ]; then
  echo "❌ 未找到 .env，请先："
  echo "   1) cp .env.example .env"
  echo "   2) 填入必填项"
  exit 1
fi
set -a
# shellcheck disable=SC1091
source .env
set +a

# ---------- 2. 校验必填项 ----------
for k in CF_API_TOKEN CF_ACCOUNT_ID TG_BOT_TOKEN TG_CHAT_ID; do
  if [ -z "${!k}" ]; then
    echo "❌ .env 缺少必填项：$k"
    exit 1
  fi
done

# ---------- 3. 自动生成缺失密钥 ----------
rand() { tr -dc 'a-zA-Z0-9' < /dev/urandom | head -c "$1"; }
SETUP_KEY="${SETUP_KEY:-setup-$(rand 20)}"
TG_WEBHOOK_SECRET="${TG_WEBHOOK_SECRET:-$(rand 32)}"
TG_ACCESS_CODE="${TG_ACCESS_CODE:-admin-$(rand 8)}"
TG_MEMBER_CODE="${TG_MEMBER_CODE:-member-$(rand 8)}"
KV_NAMESPACE="${KV_NAMESPACE:-cf-bot-access}"

export CLOUDFLARE_API_TOKEN="$CF_API_TOKEN"
export CLOUDFLARE_ACCOUNT_ID="$CF_ACCOUNT_ID"

# ---------- 4. KV 命名空间 ----------
echo ""
echo "[1/4] 检查 KV 命名空间..."
kv_list=$(npx wrangler@4 kv namespace list 2>&1 || true)
kv_id=$(echo "$kv_list" | grep -oE '[a-f0-9]{32}' | head -1)
if echo "$kv_list" | grep -qF "$KV_NAMESPACE" && [ -n "$kv_id" ]; then
  echo "  ✅ 已存在：$KV_NAMESPACE ($kv_id)"
else
  echo "  ⏳ 创建中..."
  kv_create=$(npx wrangler@4 kv namespace create "$KV_NAMESPACE" 2>&1 || true)
  kv_id=$(echo "$kv_create" | grep -oE '[a-f0-9]{32}' | head -1)
  if [ -z "$kv_id" ]; then
    echo "❌ 创建 KV 失败：$kv_create"
    exit 1
  fi
  echo "  ✅ 已创建：$KV_NAMESPACE ($kv_id)"
fi

# ---------- 5. 生成本地部署配置 ----------
echo ""
echo "[2/4] 生成 wrangler.local.toml..."
sed -e "s|<你的KV命名空间ID>|$kv_id|" \
    -e "s|<你的Cloudflare账户ID>|$CF_ACCOUNT_ID|" \
    -e "s|<你的Telegram Chat ID>|$TG_CHAT_ID|" \
    wrangler.toml > wrangler.local.toml
echo "  ✅ 已生成（wrangler.local.toml 已被 .gitignore 排除）"

# ---------- 6. 设置 Secrets ----------
echo ""
echo "[3/4] 设置 Secrets..."
put_secret() {
  local name="$1" val="$2"
  printf '%s' "$val" | npx wrangler@4 secret put "$name" --config wrangler.local.toml >/dev/null 2>&1
  echo "  · $name"
}
put_secret TG_BOT_TOKEN "$TG_BOT_TOKEN"
put_secret CF_API_TOKEN "$CF_API_TOKEN"
put_secret SETUP_KEY "$SETUP_KEY"
put_secret TG_ACCESS_CODE "$TG_ACCESS_CODE"
put_secret TG_MEMBER_CODE "$TG_MEMBER_CODE"
put_secret TG_WEBHOOK_SECRET "$TG_WEBHOOK_SECRET"

# ---------- 7. 部署 ----------
echo ""
echo "[4/4] 部署 Worker..."
npx wrangler@4 deploy --config wrangler.local.toml

# ---------- 8. 打印结果 ----------
echo ""
echo "========== ✅ 部署完成 =========="
echo "已生成/使用的配置（请保存）："
echo "  管理员邀请码 : $TG_ACCESS_CODE"
echo "  成员邀请码   : $TG_MEMBER_CODE"
echo "  SETUP_KEY    : $SETUP_KEY"
echo ""
if [ -n "$WORKER_SUBDOMAIN" ]; then
  echo "最后一步，注册 Webhook："
  echo "  curl \"https://cf-monitor-ai-bot.$WORKER_SUBDOMAIN.workers.dev/setup\" -H \"X-Setup-Key: $SETUP_KEY\""
else
  echo "最后一步，注册 Webhook（把 <子域名> 换成你的，例如 nezsad）："
  echo "  curl \"https://cf-monitor-ai-bot.<子域名>.workers.dev/setup\" -H \"X-Setup-Key: $SETUP_KEY\""
fi
echo ""
echo "在 Telegram 里用管理员码激活后即可使用。"
