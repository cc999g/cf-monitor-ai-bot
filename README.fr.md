<div align="center">

**🌐 Langue / Language**

[🇨🇳 中文](README.md) · [🇺🇸 English](README.en.md) · [🇯🇵 日本語](README.ja.md) · [🇰🇷 한국어](README.ko.md) · [🇫🇷 Français](README.fr.md) · [🇩🇪 Deutsch](README.de.md) · [🇪🇸 Español](README.es.md) · [🇷🇺 Русский](README.ru.md)

</div>

# CF Monitor AI Bot

Un bot Telegram fonctionnant sur **Cloudflare Workers** : **surveillance de l'utilisation du compte Cloudflare + chat IA multi-modèles**.

> Ce projet est **original** (non dérivé d'un projet open source). Toutes les fonctionnalités et le code ont été écrits de zéro.

---

## ✨ Fonctionnalités

### 🧠 Chat IA
- **Mode chat par défaut** : tapez simplement du texte pour discuter ; les commandes commencent par `/`
- **Système de modèles à trois niveaux** :
  - ☁️ **Modèles Cloudflare gratuits** (5 intégrés en permanence : Qwen3-30B / GPT-OSS-120B / Llama 3.3 70B / Mistral Small 24B / Llama 3.1 8B)
  - 🔑 **API intégrée** (permanente, non supprimable, ex. relais auto-hébergé)
  - 📦 **API temporaires** (ajout via `/setapi`, suppression via `/delapi`, sans jamais affecter les deux premières)
- **Choix libre du modèle** : panneau avec avantages/inconvénients + étiquettes de source (☁️/🔑/📦), préférence par utilisateur
- **Mémoire multi-tours** : 5 préréglages (Léger 1 tour → Max 40 tours) + personnalisé (`/mem tours caractères-par-message`, jusqu'à 100 tours)
- **Nouvelle session** : effacer la mémoire en un tap
- **Repli intelligent** : bascule automatique vers les modèles de secours en cas d'échec ; repli sur CF avec notification si toutes les API temporaires échouent

### 📊 Surveillance d'utilisation (métriques officielles CF)
- Requêtes Workers : utilisées / restantes aujourd'hui (100 000/jour, **réinitialisation 00:00 UTC**)
- Utilisation IA : Neurons utilisés / restants (10 000/jour, cumulés dans KV à chaque appel)

### 🔐 Accès multi-utilisateurs
- **Codes d'invitation à deux niveaux** : code admin / code membre (modifiable à tout moment dans le bot via `/setcode`)
- Super admin (`TG_CHAT_ID`) sans vérification, toujours le privilège le plus élevé
- Opérations admin uniquement : ajouter/supprimer des API, modifier les clés, modifier les codes
- Préférences / mémoire / choix de modèle des membres **isolés par utilisateur**

### ⚙️ Gestion des API personnalisées
- `/setapi url|clé|modèle1,modèle2|nom` pour ajouter (ne remplace jamais l'existant, définit automatiquement comme modèle principal)
- `/setkey nom nouvelle-clé` pour modifier une clé (KV est la source unique de vérité, effet immédiat)
- Validation du format d'URL (doit être http/https)

### 🎛️ Expérience utilisateur
- Clavier rapide persistant, pas besoin de chercher les commandes
- Opérations par panneaux : le changement de modèle rafraîchit le panneau sur place + confirmation toast
- Vérification de signature Webhook (`secret_token`), bloque les requêtes forgées

---

## 🏗️ Architecture

```
Utilisateur Telegram → Webhook (vérif. signature) → Cloudflare Worker
                      ├─ Workers AI (modèles gratuits)
                      ├─ API personnalisée (compatible OpenAI)
                      ├─ CF GraphQL (requête d'utilisation)
                      └─ KV (config / mémoire / utilisation / accès, persistés)
```

---

## 🚀 Déploiement

### ⚡ Option 1 : Déploiement en un clic (recommandé)

Seulement 4 champs obligatoires, tout le reste est généré automatiquement :

**1. Préparation**
- Un compte Cloudflare
- Un Token de Bot Telegram (créé via @BotFather)
- Node.js 18+ sur la machine de déploiement

**2. Remplir la configuration**

```bash
cp .env.example .env
```

Modifiez `.env` — 4 champs obligatoires :

```ini
CF_API_TOKEN=votre Token API Cloudflare
CF_ACCOUNT_ID=votre ID de compte Cloudflare
TG_BOT_TOKEN=votre Token de Bot Telegram
TG_CHAT_ID=votre ID de chat Telegram
```

> Les autres champs (codes d'invitation, SETUP_KEY, secret webhook) peuvent rester vides — le script génère des valeurs aléatoires et les affiche.

**3. Exécuter le script de déploiement**

Windows (PowerShell) :
```powershell
powershell -ExecutionPolicy Bypass -File .\deploy.ps1
```

Linux / macOS :
```bash
chmod +x deploy.sh && ./deploy.sh
```

Le script automatise : création/réutilisation du namespace KV → génération des secrets manquants → configuration wrangler → définition de tous les Secrets → déploiement du Worker.

**4. Enregistrer le webhook**

Après le déploiement, le script affiche une commande curl (avec le SETUP_KEY généré). Copiez-la et exécutez-la :

```bash
curl "https://cf-monitor-ai-bot.<votre-sous-domaine>.workers.dev/setup" -H "X-Setup-Key: <SETUP_KEY>"
```

**5. Commencer à utiliser**
Envoyez le code admin (ou le code membre) au bot dans Telegram pour l'activer.

---

### 🔧 Option 2 : Déploiement manuel

### 1. Préparation
- Un compte Cloudflare
- Un Token de Bot Telegram (créé via @BotFather)
- Environnement Node.js 18+

### 2. Créer un namespace KV
Cloudflare Dashboard → Workers & Pages → KV → créez un namespace, remplissez son ID dans `wrangler.toml`.

### 3. Configurer `wrangler.toml`
Remplacez les `<espaces réservés>` par vos valeurs : ID du namespace KV, ID du compte CF, ID du chat TG.

### 4. Configurer les Secrets

```bash
cd cf-bot-public
npx wrangler@4 secret put TG_BOT_TOKEN        # Token de Bot Telegram
npx wrangler@4 secret put CF_API_TOKEN        # Token API Cloudflare (permission GraphQL requise ; utilisez Edit All Resources)
npx wrangler@4 secret put SETUP_KEY           # Clé de la route admin /setup (longue chaîne aléatoire)
npx wrangler@4 secret put TG_ACCESS_CODE      # Code d'invitation admin
npx wrangler@4 secret put TG_MEMBER_CODE      # Code d'invitation membre
npx wrangler@4 secret put TG_WEBHOOK_SECRET   # Secret de signature webhook (aléatoire)
```

### 5. Déployer

```bash
CLOUDFLARE_API_TOKEN=<votre-token-API-CF> \
CLOUDFLARE_ACCOUNT_ID=<votre-id-compte> \
npx wrangler@4 deploy
```

### 6. Enregistrer le webhook

```bash
curl "https://<votre-domaine-worker>/setup" -H "X-Setup-Key: <SETUP_KEY>"
```

> Les routes admin `/setup` et `/debug` utilisent une **authentification par en-tête** (`X-Setup-Key`) : la clé n'apparaît jamais dans l'URL.

### 7. Utilisation
- Le super admin fonctionne immédiatement (`TG_CHAT_ID`)
- Les autres doivent s'activer avec le code admin ou membre

---

## 📜 Commandes

| Commande | Description | Accès |
|---|---|---|
| `/status` | Vérifier l'utilisation | Tous |
| `/ai question` | Chat IA (ou tapez simplement du texte) | Tous |
| `/mem tours caractères` | Régler la profondeur de mémoire | Tous |
| `/new` | Effacer la mémoire, nouvelle session | Tous |
| `/setapi` | Ajouter une API personnalisée | Admin |
| `/delapi` | Supprimer une API temporaire | Admin |
| `/setkey` | Modifier une clé API | Admin |
| `/setcode` | Définir les codes d'invitation à deux niveaux | Admin |

---

## 🔜 Prévu / Non implémenté

- **Sessions multiples (commutables)** : créer plusieurs sessions comme ChatGPT, basculer entre elles, mémoire indépendante par session. La conception est terminée mais en pause ; développement possible plus tard.
- **`/kick` supprimer un membre** : l'admin retire un utilisateur activé en un clic (révocation), pour prévenir les abus. Pas encore implémenté.
- **Codes d'invitation en clair** : les messages contenant les codes restent dans l'historique Telegram — un compromis de conception ; changez les codes régulièrement avec `/setcode` si besoin.

## ⚠️ Notes

1. **Codes d'invitation en clair** : les messages avec les codes restent dans l'historique du chat ; faites-les tourner périodiquement.
2. **Base de quota** : Workers 100 K requêtes/jour, Workers AI 10 K Neurons/jour, réinitialisation 00:00 UTC ; la mémoire « Max » (40 tours × 3000 car.) augmente nettement les Neurons par appel — surveillez le quota restant en usage intensif (`/status`).
3. **Les noms de modèles d'un relais peuvent ne pas correspondre à la réalité** : les noms des proxies tiers ne routent pas forcément vers le vrai modèle ; testez après ajout. Les modèles intégrés sont déjà testés.
4. **Permissions du jeton API** : `/status` nécessite la permission GraphQL — utilisez un jeton Edit All Resources, sinon erreur d'authentification.
5. **Routes admin avec authentification par en-tête** : `/setup` et `/debug` exigent l'en-tête `X-Setup-Key` ; ouvrir directement dans un navigateur renvoie 403 (utilisez curl).
6. **KV est la source unique de vérité** : la config vit dans KV ; `/setapi` `/setkey` `/setcode` prennent effet immédiatement, aucun redéploiement.
7. **Auto-réparation à la suppression d'une API** : les utilisateurs d'une API temporaire supprimée repassent automatiquement aux modèles gratuits Cloudflare.

## 🐛 Pièges de déploiement courants

1. **Webhook non enregistré** : après déploiement, exécutez `/setup` (avec `X-Setup-Key`), sinon le bot ne reçoit aucun message.
2. **`TG_WEBHOOK_SECRET` modifié sans réenregistrement** : vous obtenez 403 ; relancez simplement `/setup`.
3. **Permissions de jeton insuffisantes** : `/status` renvoie `[{"code":10000,"message":"Authentication error"}]` → remplacez le jeton par Edit All Resources dans le Dashboard.
4. **wrangler KV sans `--remote`** : `wrangler kv key get/put` opère sur l'émulateur local par défaut ; ajoutez `--remote` pour déboguer le cloud.
5. **URL d'API personnalisée sans protocole** : doit commencer par `http://` ou `https://`, sinon rejetée.
6. **Politique d'exécution PowerShell** : si deploy.ps1 est bloqué, utilisez `powershell -ExecutionPolicy Bypass -File .\deploy.ps1`.
7. **Réglages de mémoire hors limite** : `/mem tours caractères` est rejeté quand le total dépasse ~120 K caractères ; réduisez les tours ou les caractères.
8. **Réponses longues tronquées** : modèles CF max_tokens 4096, API personnalisées 2000 — la troncature des très longues réponses est normale.

---

## 🔒 Notes de sécurité
- Tous les secrets vivent dans Cloudflare Secrets, jamais dans le code
- KV est la source unique de vérité pour la config (`cfg:apis`), les modifications prennent effet immédiatement
- Le webhook vérifie `secret_token` ; les routes admin vérifient les en-têtes de requête

## 📄 Licence
MIT

---

*Ce projet a été généré avec l'aide de l'IA.*
