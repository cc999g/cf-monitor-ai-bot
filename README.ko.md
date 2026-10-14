<div align="center">

**🌐 언어 / Language**

[🇨🇳 中文](README.md) · [🇺🇸 English](README.en.md) · [🇯🇵 日本語](README.ja.md) · [🇰🇷 한국어](README.ko.md) · [🇫🇷 Français](README.fr.md) · [🇩🇪 Deutsch](README.de.md) · [🇪🇸 Español](README.es.md) · [🇷🇺 Русский](README.ru.md)

</div>

# CF Monitor AI Bot

**Cloudflare Workers**에서 실행되는 Telegram 봇: **Cloudflare 계정 사용량 모니터링 + 멀티 모델 AI 채팅**.

> 본 프로젝트는 **오리지널 프로젝트**입니다(오픈소스 프로젝트에서 파생된 것이 아님). 모든 기능과 코드는 처음부터 작성되었습니다.

---

## ✨ 기능

### 🧠 AI 채팅
- **기본 채팅 모드**: 텍스트를 입력하기만 하면 대화 시작, `/`로 시작하는 것만 명령어
- **3단계 모델 체계**:
  - ☁️ **Cloudflare 무료 모델** (5개 영구 내장: Qwen3-30B / GPT-OSS-120B / Llama 3.3 70B / Mistral Small 24B / Llama 3.1 8B)
  - 🔑 **내장 API** (영구 유지, 삭제 불가, 예: 자체 릴레이)
  - 📦 **임시 API** (`/setapi`로 자유 추가, `/delapi`로 삭제, 앞의 두 계층에 영향 없음)
- **모델 자유 선택**: 패널에 장단점 + 출처 태그(☁️/🔑/📦), 사용자별 독립
- **멀티턴 메모리**: 5단계 프리셋(얕음 1턴 → 최대 40턴) + 커스텀(`/mem 턴 수 메시지당 글자수`, 최대 100턴)
- **새 세션**: 한 번의 탭으로 메모리 초기화
- **스마트 폴백**: 실패 시 예비 모델로 자동 전환; 임시 API가 모두 실패하면 CF로 폴백하고 알림

### 📊 사용량 모니터링 (CF 공식 기준)
- Workers 요청: 오늘 사용량 / 잔여 (100,000/일, **00:00 UTC 리셋**)
- AI 사용량: Neurons 사용 / 잔여 (10,000/일, 호출마다 KV에 누적)

### 🔐 다중 사용자 권한
- **2단계 초대 코드**: 관리자 코드 / 멤버 코드 (bot 내 `/setcode`로 수시 변경)
- 슈퍼 관리자(`TG_CHAT_ID`)는 인증 불필요, 항상 최고 권한
- 관리 작업(API 추가/삭제, Key 변경, 코드 변경)은 관리자만
- 멤버의 설정/메모리/모델 선택은 **사용자별 독립**

### ⚙️ 커스텀 API 관리
- `/setapi url|key|model1,model2|name`로 추가 (기존 항목을 덮어쓰지 않음, 자동으로 메인 모델 설정)
- `/setkey 이름 새키`로 키 변경 (KV가 단일 권위, 즉시 적용)
- URL 형식 검증 (http/https 필수)

### 🎛️ UX
- 상시 빠른 키보드, 명령어를 찾을 필요 없음
- 패널 방식: 모델 전환 시 패널을 그 자리에서 갱신 + toast 확인
- Webhook 서명 검증(`secret_token`), 위조 요청 차단

---

## 🏗️ 아키텍처

```
Telegram 사용자 → Webhook(서명 검증) → Cloudflare Worker
                      ├─ Workers AI (무료 모델)
                      ├─ 커스텀 API (OpenAI 호환)
                      ├─ CF GraphQL (사용량 조회)
                      └─ KV (설정 / 메모리 / 사용량 / 권한 영구 저장)
```

---

## 🚀 배포 방법

### ⚡ 방법 1: 원클릭 배포 (권장)

필수 입력 4개만 채우면 나머지는 자동 생성됩니다.

**1. 준비**
- Cloudflare 계정
- Telegram Bot Token (@BotFather에서 생성)
- Node.js 18+ (배포 머신)

**2. 설정 입력**

```bash
cp .env.example .env
```

`.env` 편집 — 필수 4항목:

```ini
CF_API_TOKEN=당신의 Cloudflare API 토큰
CF_ACCOUNT_ID=당신의 Cloudflare 계정 ID
TG_BOT_TOKEN=당신의 Telegram Bot 토큰
TG_CHAT_ID=당신의 Telegram Chat ID
```

> 나머지 항목(초대 코드, SETUP_KEY, Webhook 시크릿)은 비워도 됩니다. 스크립트가 랜덤 생성 후 출력합니다.

**3. 배포 스크립트 실행**

Windows (PowerShell):
```powershell
powershell -ExecutionPolicy Bypass -File .\deploy.ps1
```

Linux / macOS:
```bash
chmod +x deploy.sh && ./deploy.sh
```

스크립트가 자동으로: KV 네임스페이스 생성/재사용 → 누락 키 생성 → wrangler 설정 → 모든 Secrets 설정 → Worker 배포.

**4. Webhook 등록**

배포 후 스크립트가 curl 명령(생성된 SETUP_KEY 포함)을 출력합니다. 복사해서 실행:

```bash
curl "https://cf-monitor-ai-bot.<당신의-서브도메인>.workers.dev/setup" -H "X-Setup-Key: <SETUP_KEY>"
```

**5. 사용 시작**
Telegram에서 봇에게 관리자 코드(또는 멤버 코드)를 보내 활성화.

---

### 🔧 방법 2: 수동 배포

### 1. 준비
- Cloudflare 계정
- Telegram Bot Token (@BotFather에서 생성)
- Node.js 18+ 환경

### 2. KV 네임스페이스 생성
Cloudflare Dashboard → Workers & Pages → KV → 네임스페이스 생성, ID를 `wrangler.toml`에 입력.

### 3. `wrangler.toml` 설정
`<플레이스홀더>`를 자신의 값으로 교체: KV 네임스페이스 ID, CF 계정 ID, TG Chat ID.

### 4. Secrets 설정

```bash
cd cf-bot-public
npx wrangler@4 secret put TG_BOT_TOKEN        # Telegram Bot Token
npx wrangler@4 secret put CF_API_TOKEN        # Cloudflare API Token (GraphQL 사용량 권한 필요, Edit All Resources 권장)
npx wrangler@4 secret put SETUP_KEY           # /setup 관리 라우트 키 (긴 랜덤 문자열)
npx wrangler@4 secret put TG_ACCESS_CODE      # 관리자 초대 코드
npx wrangler@4 secret put TG_MEMBER_CODE      # 멤버 초대 코드
npx wrangler@4 secret put TG_WEBHOOK_SECRET   # Webhook 서명 시크릿 (랜덤)
```

### 5. 배포

```bash
CLOUDFLARE_API_TOKEN=<당신의-CF-API-토큰> \
CLOUDFLARE_ACCOUNT_ID=<당신의-계정-ID> \
npx wrangler@4 deploy
```

### 6. Webhook 등록

```bash
curl "https://<당신의-Worker-도메인>/setup" -H "X-Setup-Key: <SETUP_KEY>"
```

> 관리 라우트 `/setup`·`/debug`는 **헤더 인증**(`X-Setup-Key`)을 사용, 키가 URL에 노출되지 않습니다.

### 7. 사용
- 슈퍼 관리자는 즉시 사용 가능(`TG_CHAT_ID`)
- 다른 사용자는 관리자 코드 또는 멤버 코드로 활성화

---

## 📜 명령어 목록

| 명령어 | 설명 | 권한 |
|---|---|---|
| `/status` | 사용량 조회 | 전체 |
| `/ai 질문` | AI 채팅 (또는 텍스트 직접 입력) | 전체 |
| `/mem 턴수 글자수` | 메모리 깊이 설정 | 전체 |
| `/new` | 메모리 초기화, 새 세션 | 전체 |
| `/lang` | 언어 전환 (8개 언어) | 전체 |
| `/setapi` | 커스텀 API 추가 | 관리자 |
| `/delapi` | 임시 API 삭제 | 관리자 |
| `/setkey` | API 키 변경 | 관리자 |
| `/setcode` | 2단계 초대 코드 설정 | 관리자 |

---

## 🔜 예정 / 미구현 기능

- **멀티 세션(전환 가능)**: ChatGPT처럼 여러 세션을 만들고 전환하며, 각 세션별 독립 메모리. 설계는 완료됐지만 보류 중. 필요하면 나중에 개발 가능.
- **`/kick` 멤버 제거**: 관리자가 원탭으로 활성화된 사용자를 제거(활성화 취소), 남용 방지용. 아직 미구현.
- **초대 코드 평문**: 초대 코드가 포함된 메시지는 Telegram 채팅 기록에 남습니다 — 설계상 트레이드오프. 우려되면 `/setcode`로 정기적으로 변경.

## ⚠️ 주의사항

1. **초대 코드 평문**: 초대 코드가 포함된 메시지는 채팅 기록에 남습니다. 정기적으로 변경하세요.
2. **쿼터 기준**: Workers 10만 요청/일, Workers AI 1만 Neurons/일, 00:00 UTC 리셋. '최대' 메모리(40턴×3000자)는 호출당 Neurons 소비가 크게 증가. 고빈도 사용 시 잔여 쿼터 확인(`/status`).
3. **릴레이 API 모델명이 실제와 다를 수 있음**: 서드파티 프록시의 모델명이 실제 라우팅 모델과 다를 수 있습니다. 추가 후 실측하세요. 내장 모델은 실측 완료.
4. **API Token 권한**: `/status`는 GraphQL 권한 필요. Edit All Resources 수준 토큰을 사용하지 않으면 Authentication error 발생.
5. **관리 라우트는 헤더 인증**: `/setup`·`/debug`는 `X-Setup-Key` 헤더 필수. 브라우저로 직접 열면 403 (curl 사용).
6. **KV가 단일 권위**: 설정은 KV에 저장. `/setapi` `/setkey` `/setcode`는 즉시 반영, 재배포 불필요.
7. **API 삭제 시 자동 복구**: 삭제된 임시 API를 사용 중인 사용자는 자동으로 Cloudflare 무료 모델로 전환.

## 🐛 배포 시 자주 실수하는 부분

1. **Webhook 등록 잊음**: 배포 후 반드시 `/setup` 실행(`X-Setup-Key` 포함). 안 하면 bot이 메시지를 받지 못합니다.
2. **`TG_WEBHOOK_SECRET` 변경 후 재등록 안 함**: 403 발생. `/setup`을 다시 실행하면 됩니다.
3. **API Token 권한 부족**: `/status`가 `[{"code":10000,"message":"Authentication error"}]` → Dashboard에서 Edit All Resources 토큰으로 교체.
4. **wrangler KV에 `--remote` 없음**: `wrangler kv key get/put`은 기본적으로 로컬 에뮬레이터를 조작. 클라우드를 디버깅할 때 `--remote` 추가.
5. **커스텀 API URL에 프로토콜 없음**: `http://` 또는 `https://`로 시작해야 함. 아니면 거부됨.
6. **PowerShell 실행 정책**: deploy.ps1이 직접 실행되지 않으면 `powershell -ExecutionPolicy Bypass -File .\deploy.ps1` 사용.
7. **메모리 설정 상한 초과**: `/mem 턴수 글자수`는 합계 약 12만 자를 초과하면 거부. 턴수나 글자수를 줄이세요.
8. **긴 답변은 잘림**: CF 모델 max_tokens 4096, 커스텀 API 2000. 매우 긴 답변의 잘림은 정상입니다.

---

## 🔒 보안
- 모든 시크릿은 Cloudflare Secrets에 저장, 코드에 미포함
- KV가 설정의 단일 권위(`cfg:apis`), 변경 즉시 반영
- Webhook은 `secret_token` 검증, 관리 라우트는 요청 헤더 검증

## 📄 라이선스
MIT

---

*이 프로젝트는 AI의 도움으로 생성되었습니다.*
