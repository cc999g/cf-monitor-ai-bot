<div align="center">

**🌐 言語 / Language**

[🇨🇳 中文](README.md) · [🇺🇸 English](README.en.md) · [🇯🇵 日本語](README.ja.md) · [🇰🇷 한국어](README.ko.md) · [🇫🇷 Français](README.fr.md) · [🇩🇪 Deutsch](README.de.md) · [🇪🇸 Español](README.es.md) · [🇷🇺 Русский](README.ru.md)

</div>

# CF Monitor AI Bot

**Cloudflare Workers** 上で動作する Telegram ボット：**Cloudflare アカウント利用量モニタリング + マルチモデル AI チャット**。

> 本プロジェクトは**オリジナル**です（オープンソースプロジェクトからの改変ではありません）。機能・コードともゼロから開発しました。

---

## ✨ 機能

### 🧠 AI チャット
- **デフォルトチャットモード**：文字を入力するだけで会話開始、`/` で始まるものだけがコマンド
- **3 層モデル体系**：
  - ☁️ **Cloudflare 無料モデル**（5 つ常設：Qwen3-30B / GPT-OSS-120B / Llama 3.3 70B / Mistral Small 24B / Llama 3.1 8B）
  - 🔑 **内蔵 API**（恒久・削除不可、例：自前リレー）
  - 📦 **一時 API**（`/setapi` で任意追加、`/delapi` で削除、前の 2 層に影響なし）
- **モデル自由選択**：パネルに長所短所 + 出所タグ（☁️/🔑/📦）、ユーザーごとに独立
- **マルチターン記憶**：5 段階プリセット（浅 1 ターン → 最深 40 ターン）+ カスタム（`/mem ターン数 1メッセージ文字数`、最大 100 ターン）
- **新規セッション**：ワンタップで記憶クリア
- **スマートフォールバック**：失敗時は自動で予備モデルへ切替。一時 API が全て失敗したら CF にフォールバックし通知

### 📊 利用量モニタリング（CF 公式口径）
- Workers リクエスト：今日の使用 / 残り（100,000/日、**00:00 UTC リセット**）
- AI 利用量：Neurons 使用 / 残り（10,000/日、呼び出しごとに KV へ累積）

### 🔐 マルチユーザー権限
- **2 段階招待コード**：管理者コード / メンバーコード（bot 内で `/setcode` により随時変更可）
- スーパー管理者（`TG_CHAT_ID`）は認証不要、常に最高権限
- 管理操作（API 追加/削除、Key 変更、コード変更）は管理者のみ
- メンバーの設定・記憶・モデル選択は**ユーザーごとに独立**

### ⚙️ カスタム API 管理
- `/setapi url|key|model1,model2|name` で追加（既存を上書きせず、自動でメインモデルに設定）
- `/setkey 名前 新キー` でキー変更（KV が唯一の正、即時反映）
- URL 形式バリデーション（http/https 必須）

### 🎛️ UX
- 常駐クイックキーボード、コマンドを探す必要なし
- パネル方式：モデル切替はパネルをその場で更新 + toast 確認
- Webhook 署名検証（`secret_token`）、偽装リクエストを遮断

---

## 🏗️ アーキテクチャ

```
Telegram ユーザー → Webhook（署名検証）→ Cloudflare Worker
                      ├─ Workers AI（無料モデル）
                      ├─ カスタム API（OpenAI 互換）
                      ├─ CF GraphQL（利用量照会）
                      └─ KV（設定 / 記憶 / 利用量 / 権限を永続化）
```

---

## 🚀 デプロイ方法

### ⚡ 方法 1：ワンクリックデプロイ（推奨）

必須入力は 4 項目のみ、他は自動生成されます。

**1. 準備**
- Cloudflare アカウント
- Telegram Bot Token（@BotFather で作成）
- Node.js 18+（デプロイするマシン）

**2. 設定を記入**

```bash
cp .env.example .env
```

`.env` を編集（必須 4 項目）：

```ini
CF_API_TOKEN=あなたの Cloudflare API トークン
CF_ACCOUNT_ID=あなたの Cloudflare アカウント ID
TG_BOT_TOKEN=あなたの Telegram Bot トークン
TG_CHAT_ID=あなたの Telegram Chat ID
```

> 他の項目（招待コード、SETUP_KEY、Webhook シークレット）は空のままで OK。スクリプトがランダム生成して表示します。

**3. デプロイスクリプト実行**

Windows（PowerShell）：
```powershell
powershell -ExecutionPolicy Bypass -File .\deploy.ps1
```

Linux / macOS：
```bash
chmod +x deploy.sh && ./deploy.sh
```

スクリプトが自動実行：KV ネームスペース作成/再利用 → 不足キー生成 → wrangler 設定 → 全 Secrets 設定 → Worker デプロイ。

**4. Webhook 登録**

デプロイ完了後にスクリプトが curl コマンド（生成済み SETUP_KEY 付き）を出力。コピーして実行：

```bash
curl "https://cf-monitor-ai-bot.<あなたのサブドメイン>.workers.dev/setup" -H "X-Setup-Key: <SETUP_KEY>"
```

**5. 利用開始**
Telegram でボットに管理者コード（またはメンバーコード）を送信してアクティベート。

---

### 🔧 方法 2：手動デプロイ

### 1. 準備
- Cloudflare アカウント
- Telegram Bot Token（@BotFather で作成）
- Node.js 18+ 環境

### 2. KV ネームスペース作成
Cloudflare Dashboard → Workers & Pages → KV → ネームスペース作成、ID を `wrangler.toml` に記入。

### 3. `wrangler.toml` 設定
`<プレースホルダー>` を自分の値に置換：KV ネームスペース ID、CF アカウント ID、TG Chat ID。

### 4. Secrets 設定

```bash
cd cf-bot-public
npx wrangler@4 secret put TG_BOT_TOKEN        # Telegram Bot Token
npx wrangler@4 secret put CF_API_TOKEN        # Cloudflare API Token（GraphQL 利用量権限必須。Edit All Resources 推奨）
npx wrangler@4 secret put SETUP_KEY           # /setup 管理ルートのキー（長いランダム文字列）
npx wrangler@4 secret put TG_ACCESS_CODE      # 管理者招待コード
npx wrangler@4 secret put TG_MEMBER_CODE      # メンバー招待コード
npx wrangler@4 secret put TG_WEBHOOK_SECRET   # Webhook 署名シークレット（ランダム）
```

### 5. デプロイ

```bash
CLOUDFLARE_API_TOKEN=<あなたのCF APIトークン> \
CLOUDFLARE_ACCOUNT_ID=<あなたのアカウントID> \
npx wrangler@4 deploy
```

### 6. Webhook 登録

```bash
curl "https://<あなたのWorkerドメイン>/setup" -H "X-Setup-Key: <SETUP_KEY>"
```

> 管理ルート `/setup`・`/debug` は**リクエストヘッダー認証**（`X-Setup-Key`）を使用。キーが URL に露出しません。

### 7. 利用開始
- スーパー管理者は即利用可（`TG_CHAT_ID`）
- 他ユーザーは管理者コードまたはメンバーコードでアクティベート

---

## 📜 コマンド一覧

| コマンド | 説明 | 権限 |
|---|---|---|
| `/status` | 利用量照会 | 全員 |
| `/ai 質問` | AI チャット（または直接テキスト入力） | 全員 |
| `/mem ターン数 文字数` | 記憶深度設定 | 全員 |
| `/new` | 記憶クリア、新規セッション | 全員 |
| `/setapi` | カスタム API 追加 | 管理者 |
| `/delapi` | 一時 API 削除 | 管理者 |
| `/setkey` | API キー変更 | 管理者 |
| `/setcode` | 2 段階招待コード設定 | 管理者 |

---

## 🔒 セキュリティ
- すべてのシークレットは Cloudflare Secrets に保管、コードに含めない
- KV が設定の唯一の正（`cfg:apis`）、変更は即時反映
- Webhook は `secret_token` を検証、管理ルートはリクエストヘッダーを検証

## 📄 ライセンス
MIT
