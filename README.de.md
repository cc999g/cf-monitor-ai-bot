<div align="center">

**🌐 Sprache / Language**

[🇨🇳 中文](README.md) · [🇺🇸 English](README.en.md) · [🇯🇵 日本語](README.ja.md) · [🇰🇷 한국어](README.ko.md) · [🇫🇷 Français](README.fr.md) · [🇩🇪 Deutsch](README.de.md) · [🇪🇸 Español](README.es.md) · [🇷🇺 Русский](README.ru.md)

</div>

# CF Monitor AI Bot

Ein Telegram-Bot auf **Cloudflare Workers**: **Cloudflare-Kontonutzungs-Überwachung + KI-Chat mit mehreren Modellen**.

> Dies ist ein **Originalprojekt** (nicht von einem Open-Source-Projekt abgeleitet). Alle Funktionen und der Code wurden von Grund auf neu geschrieben.

---

## ✨ Funktionen

### 🧠 KI-Chat
- **Standard-Chatmodus**: einfach Text eingeben, um zu chatten; Befehle beginnen mit `/`
- **Drei-Ebenen-Modellsystem**:
  - ☁️ **Cloudflare-Kostenlosmodelle** (5 dauerhaft integriert: Qwen3-30B / GPT-OSS-120B / Llama 3.3 70B / Mistral Small 24B / Llama 3.1 8B)
  - 🔑 **Integrierte API** (dauerhaft, nicht löschbar, z. B. selbst gehostetes Relay)
  - 📦 **Temporäre APIs** (hinzufügen via `/setapi`, löschen via `/delapi`, beeinflusst nie die ersten beiden)
- **Freie Modellwahl**: Panel mit Vor-/Nachteilen + Herkunfts-Tags (☁️/🔑/📦), pro Benutzer unabhängig
- **Mehrrunden-Speicher**: 5 Stufen (Leicht 1 Runde → Max 40 Runden) + benutzerdefiniert (`/mem Runden Zeichen-pro-Nachricht`, bis zu 100 Runden)
- **Neue Sitzung**: Speicher mit einem Tipp löschen
- **Intelligenter Fallback**: automatischer Wechsel zu Ersatzmodellen bei Fehlern; Fallback auf CF mit Hinweis, wenn alle temporären APIs fehlschlagen

### 📊 Nutzungsüberwachung (offizielle CF-Metriken)
- Workers-Anfragen: heute genutzt / verbleibend (100.000/Tag, **Reset 00:00 UTC**)
- KI-Nutzung: Neurons genutzt / verbleibend (10.000/Tag, pro Aufruf in KV kumuliert)

### 🔐 Mehrbenutzerzugriff
- **Zwei-Stufen-Einladungscodes**: Admin-Code / Mitglied-Code (jederzeit im Bot änderbar via `/setcode`)
- Super-Admin (`TG_CHAT_ID`) ohne Verifizierung, immer höchste Berechtigung
- Nur-Admin-Operationen: APIs hinzufügen/löschen, Keys ändern, Codes ändern
- Mitglieder-Präferenzen / Speicher / Modellwahl **pro Benutzer isoliert**

### ⚙️ Verwaltung benutzerdefinierter APIs
- `/setapi url|key|modell1,modell2|name` zum Hinzufügen (überschreibt nie Bestehendes, setzt automatisch als Hauptmodell)
- `/setkey name neuer-key` zum Ändern eines Keys (KV ist die einzige Wahrheitsquelle, sofort wirksam)
- URL-Formatprüfung (muss http/https sein)

### 🎛️ UX
- Permanente Schnelltastatur, kein Suchen nach Befehlen
- Panel-Bedienung: Modellwechsel aktualisiert das Panel direkt + Toast-Bestätigung
- Webhook-Signaturprüfung (`secret_token`), blockiert gefälschte Anfragen

---

## 🏗️ Architektur

```
Telegram-Benutzer → Webhook (Signaturprüfung) → Cloudflare Worker
                      ├─ Workers AI (Kostenlosmodelle)
                      ├─ Benutzerdefinierte API (OpenAI-kompatibel)
                      ├─ CF GraphQL (Nutzungsabfrage)
                      └─ KV (Konfig / Speicher / Nutzung / Zugriff, persistiert)
```

---

## 🚀 Bereitstellung

### ⚡ Option 1: Ein-Klick-Bereitstellung (empfohlen)

Nur 4 Pflichtfelder, alles andere wird automatisch generiert:

**1. Vorbereitung**
- Ein Cloudflare-Konto
- Ein Telegram-Bot-Token (über @BotFather erstellen)
- Node.js 18+ auf dem Bereitstellungsrechner

**2. Konfiguration ausfüllen**

```bash
cp .env.example .env
```

`.env` bearbeiten — 4 Pflichtfelder:

```ini
CF_API_TOKEN=Ihr Cloudflare-API-Token
CF_ACCOUNT_ID=Ihre Cloudflare-Konto-ID
TG_BOT_TOKEN=Ihr Telegram-Bot-Token
TG_CHAT_ID=Ihre Telegram-Chat-ID
```

> Andere Felder (Einladungscodes, SETUP_KEY, Webhook-Secret) können leer bleiben — das Skript generiert Zufallswerte und gibt sie aus.

**3. Bereitstellungsskript ausführen**

Windows (PowerShell):
```powershell
powershell -ExecutionPolicy Bypass -File .\deploy.ps1
```

Linux / macOS:
```bash
chmod +x deploy.sh && ./deploy.sh
```

Das Skript automatisiert: KV-Namespace erstellen/wiederverwenden → fehlende Secrets generieren → wrangler konfigurieren → alle Secrets setzen → Worker bereitstellen.

**4. Webhook registrieren**

Nach der Bereitstellung gibt das Skript einen curl-Befehl aus (mit generiertem SETUP_KEY). Kopieren und ausführen:

```bash
curl "https://cf-monitor-ai-bot.<Ihre-Subdomain>.workers.dev/setup" -H "X-Setup-Key: <SETUP_KEY>"
```

**5. Nutzung starten**
Senden Sie dem Bot in Telegram den Admin-Code (oder Mitglied-Code) zur Aktivierung.

---

### 🔧 Option 2: Manuelle Bereitstellung

### 1. Vorbereitung
- Ein Cloudflare-Konto
- Ein Telegram-Bot-Token (über @BotFather erstellen)
- Node.js 18+ Umgebung

### 2. KV-Namespace erstellen
Cloudflare Dashboard → Workers & Pages → KV → Namespace erstellen, ID in `wrangler.toml` eintragen.

### 3. `wrangler.toml` konfigurieren
Ersetzen Sie die `<Platzhalter>` durch Ihre Werte: KV-Namespace-ID, CF-Konto-ID, TG-Chat-ID.

### 4. Secrets konfigurieren

```bash
cd cf-bot-public
npx wrangler@4 secret put TG_BOT_TOKEN        # Telegram-Bot-Token
npx wrangler@4 secret put CF_API_TOKEN        # Cloudflare-API-Token (GraphQL-Nutzungsberechtigung erforderlich; Edit All Resources verwenden)
npx wrangler@4 secret put SETUP_KEY           # Schlüssel für die Admin-Route /setup (lange Zufallszeichenfolge)
npx wrangler@4 secret put TG_ACCESS_CODE      # Admin-Einladungscode
npx wrangler@4 secret put TG_MEMBER_CODE      # Mitglied-Einladungscode
npx wrangler@4 secret put TG_WEBHOOK_SECRET   # Webhook-Signatur-Secret (zufällig)
```

### 5. Bereitstellen

```bash
CLOUDFLARE_API_TOKEN=<Ihr-CF-API-Token> \
CLOUDFLARE_ACCOUNT_ID=<Ihre-Konto-ID> \
npx wrangler@4 deploy
```

### 6. Webhook registrieren

```bash
curl "https://<Ihre-Worker-Domain>/setup" -H "X-Setup-Key: <SETUP_KEY>"
```

> Die Admin-Routen `/setup` und `/debug` verwenden **Header-Authentifizierung** (`X-Setup-Key`) — der Schlüssel erscheint nie in der URL.

### 7. Nutzung
- Der Super-Admin funktioniert sofort (`TG_CHAT_ID`)
- Andere müssen sich mit Admin- oder Mitglied-Code aktivieren

---

## 📜 Befehle

| Befehl | Beschreibung | Zugriff |
|---|---|---|
| `/status` | Nutzung prüfen | Alle |
| `/ai Frage` | KI-Chat (oder einfach Text eingeben) | Alle |
| `/mem Runden Zeichen` | Speichertiefe einstellen | Alle |
| `/new` | Speicher löschen, neue Sitzung | Alle |
| `/setapi` | Benutzerdefinierte API hinzufügen | Admin |
| `/delapi` | Temporäre API löschen | Admin |
| `/setkey` | API-Key ändern | Admin |
| `/setcode` | Zwei-Stufen-Einladungscodes setzen | Admin |

---

## 🔒 Sicherheitshinweise
- Alle Secrets liegen in Cloudflare Secrets, nie im Code
- KV ist die einzige Wahrheitsquelle für Konfig (`cfg:apis`), Änderungen sofort wirksam
- Webhook prüft `secret_token`; Admin-Routen prüfen Anfrage-Header

## 📄 Lizenz
MIT
