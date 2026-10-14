<div align="center">

**🌐 Idioma / Language**

[🇨🇳 中文](README.md) · [🇺🇸 English](README.en.md) · [🇯🇵 日本語](README.ja.md) · [🇰🇷 한국어](README.ko.md) · [🇫🇷 Français](README.fr.md) · [🇩🇪 Deutsch](README.de.md) · [🇪🇸 Español](README.es.md) · [🇷🇺 Русский](README.ru.md)

</div>

# CF Monitor AI Bot

Un bot de Telegram que se ejecuta en **Cloudflare Workers**: **monitoreo de uso de la cuenta de Cloudflare + chat de IA multimodelo**.

> Este es un proyecto **original** (no derivado de un proyecto de código abierto). Todas las funciones y el código fueron escritos desde cero.

---

## ✨ Funciones

### 🧠 Chat de IA
- **Modo de chat predeterminado**: simplemente escribe texto para chatear; los comandos comienzan con `/`
- **Sistema de modelos de tres niveles**:
  - ☁️ **Modelos gratuitos de Cloudflare** (5 integrados permanentemente: Qwen3-30B / GPT-OSS-120B / Llama 3.3 70B / Mistral Small 24B / Llama 3.1 8B)
  - 🔑 **API integrada** (permanente, no eliminable, p. ej. relevo autoalojado)
  - 📦 **APIs temporales** (agregar con `/setapi`, eliminar con `/delapi`, nunca afecta a los dos primeros)
- **Elección libre de modelo**: panel con pros/contras + etiquetas de origen (☁️/🔑/📦), preferencia por usuario
- **Memoria multiturno**: 5 ajustes (Ligero 1 turno → Máximo 40 turnos) + personalizado (`/mem turnos caracteres-por-mensaje`, hasta 100 turnos)
- **Nueva sesión**: borrar memoria con un toque
- **Respaldo inteligente**: cambio automático a modelos de respaldo en caso de error; respaldo a CF con aviso si todas las APIs temporales fallan

### 📊 Monitoreo de uso (métricas oficiales de CF)
- Solicitudes de Workers: usadas / restantes hoy (100.000/día, **restablece 00:00 UTC**)
- Uso de IA: Neurons usados / restantes (10.000/día, acumulados en KV por llamada)

### 🔐 Acceso multiusuario
- **Códigos de invitación de dos niveles**: código de administrador / código de miembro (cambiable en cualquier momento en el bot con `/setcode`)
- Super administrador (`TG_CHAT_ID`) sin verificación, siempre máximo privilegio
- Operaciones solo de administrador: agregar/eliminar APIs, cambiar claves, cambiar códigos
- Preferencias / memoria / elección de modelo de los miembros **aisladas por usuario**

### ⚙️ Gestión de APIs personalizadas
- `/setapi url|clave|modelo1,modelo2|nombre` para agregar (nunca sobrescribe lo existente, establece automáticamente como modelo principal)
- `/setkey nombre nueva-clave` para cambiar una clave (KV es la única fuente de verdad, efecto inmediato)
- Validación de formato de URL (debe ser http/https)

### 🎛️ Experiencia de usuario
- Teclado rápido persistente, sin buscar comandos
- Operaciones tipo panel: el cambio de modelo actualiza el panel en el lugar + confirmación toast
- Verificación de firma de Webhook (`secret_token`), bloquea solicitudes falsificadas

---

## 🏗️ Arquitectura

```
Usuario de Telegram → Webhook (verificación de firma) → Cloudflare Worker
                      ├─ Workers AI (modelos gratuitos)
                      ├─ API personalizada (compatible con OpenAI)
                      ├─ CF GraphQL (consulta de uso)
                      └─ KV (config / memoria / uso / acceso, persistido)
```

---

## 🚀 Implementación

### ⚡ Opción 1: Implementación con un clic (recomendada)

Solo 4 campos obligatorios, todo lo demás se genera automáticamente:

**1. Preparación**
- Una cuenta de Cloudflare
- Un Token de Bot de Telegram (crear con @BotFather)
- Node.js 18+ en la máquina de implementación

**2. Completar la configuración**

```bash
cp .env.example .env
```

Edita `.env` — 4 campos obligatorios:

```ini
CF_API_TOKEN=tu Token de API de Cloudflare
CF_ACCOUNT_ID=tu ID de cuenta de Cloudflare
TG_BOT_TOKEN=tu Token de Bot de Telegram
TG_CHAT_ID=tu ID de chat de Telegram
```

> Los demás campos (códigos de invitación, SETUP_KEY, secreto de webhook) pueden quedar vacíos: el script genera valores aleatorios y los muestra.

**3. Ejecutar el script de implementación**

Windows (PowerShell):
```powershell
powershell -ExecutionPolicy Bypass -File .\deploy.ps1
```

Linux / macOS:
```bash
chmod +x deploy.sh && ./deploy.sh
```

El script automatiza: crear/reutilizar el namespace de KV → generar secretos faltantes → configurar wrangler → establecer todos los Secrets → implementar el Worker.

**4. Registrar el webhook**

Tras la implementación, el script imprime un comando curl (con el SETUP_KEY generado). Cópialo y ejecútalo:

```bash
curl "https://cf-monitor-ai-bot.<tu-subdominio>.workers.dev/setup" -H "X-Setup-Key: <SETUP_KEY>"
```

**5. Empezar a usar**
Envía el código de administrador (o el código de miembro) al bot en Telegram para activarlo.

---

### 🔧 Opción 2: Implementación manual

### 1. Preparación
- Una cuenta de Cloudflare
- Un Token de Bot de Telegram (crear con @BotFather)
- Entorno Node.js 18+

### 2. Crear un namespace KV
Cloudflare Dashboard → Workers & Pages → KV → crear un namespace, rellenar su ID en `wrangler.toml`.

### 3. Configurar `wrangler.toml`
Reemplaza los `<marcadores de posición>` con tus valores: ID del namespace KV, ID de la cuenta CF, ID de chat de TG.

### 4. Configurar los Secrets

```bash
cd cf-bot-public
npx wrangler@4 secret put TG_BOT_TOKEN        # Token de Bot de Telegram
npx wrangler@4 secret put CF_API_TOKEN        # Token de API de Cloudflare (requiere permiso GraphQL; usa Edit All Resources)
npx wrangler@4 secret put SETUP_KEY           # Clave de la ruta admin /setup (cadena aleatoria larga)
npx wrangler@4 secret put TG_ACCESS_CODE      # Código de invitación de administrador
npx wrangler@4 secret put TG_MEMBER_CODE      # Código de invitación de miembro
npx wrangler@4 secret put TG_WEBHOOK_SECRET   # Secreto de firma de webhook (aleatorio)
```

### 5. Implementar

```bash
CLOUDFLARE_API_TOKEN=<tu-token-API-CF> \
CLOUDFLARE_ACCOUNT_ID=<tu-ID-de-cuenta> \
npx wrangler@4 deploy
```

### 6. Registrar el webhook

```bash
curl "https://<tu-dominio-worker>/setup" -H "X-Setup-Key: <SETUP_KEY>"
```

> Las rutas de administración `/setup` y `/debug` usan **autenticación por cabecera** (`X-Setup-Key`): la clave nunca aparece en la URL.

### 7. Uso
- El super administrador funciona de inmediato (`TG_CHAT_ID`)
- Los demás deben activarse con el código de administrador o de miembro

---

## 📜 Comandos

| Comando | Descripción | Acceso |
|---|---|---|
| `/status` | Consultar uso | Todos |
| `/ai pregunta` | Chat de IA (o simplemente escribe texto) | Todos |
| `/mem turnos caracteres` | Configurar profundidad de memoria | Todos |
| `/new` | Borrar memoria, nueva sesión | Todos |
| `/setapi` | Agregar API personalizada | Admin |
| `/delapi` | Eliminar API temporal | Admin |
| `/setkey` | Cambiar clave de API | Admin |
| `/setcode` | Establecer códigos de invitación de dos niveles | Admin |

---

## 🔜 Planificado / No implementado

- **Sesiones múltiples (conmutables)** : crear varias sesiones como ChatGPT y cambiar entre ellas, memoria independiente por sesión. El diseño está terminado pero en pausa; se puede desarrollar después si es necesario.
- **`/kick` eliminar miembro** : el administrador elimina a un usuario activado con un toque (revocación de activación), para prevenir abusos. Aún no implementado.
- **Códigos de invitación en texto plano** : los mensajes con códigos quedan en el historial de Telegram — una compensación de diseño; cambie los códigos periódicamente con `/setcode` si le preocupa.

## ⚠️ Notas

1. **Códigos de invitación en texto plano** : los mensajes con códigos quedan en el historial del chat; rótelos periódicamente.
2. **Base de cuota** : Workers 100 K solicitudes/día, Workers AI 10 K Neurons/día, restablece 00:00 UTC; la memoria «Máximo» (40 turnos × 3000 car.) aumenta notablemente los Neurons por llamada — vigile la cuota restante en uso intensivo (`/status`).
3. **Los nombres de modelo de un relé pueden no coincidir con la realidad** : los nombres de proxies de terceros no siempre enrutan al modelo real; pruebe después de añadir. Los modelos integrados ya están probados.
4. **Permisos del token API** : `/status` necesita permiso GraphQL — use un token Edit All Resources, si no, error de autenticación.
5. **Rutas de administración con autenticación por cabecera** : `/setup` y `/debug` exigen la cabecera `X-Setup-Key`; abrirlas directamente en un navegador devuelve 403 (use curl).
6. **KV es la única fuente de verdad** : la configuración vive en KV; `/setapi` `/setkey` `/setcode` surten efecto de inmediato, sin redespliegue.
7. **Autocuración al eliminar una API** : los usuarios de una API temporal eliminada vuelven automáticamente a los modelos gratuitos de Cloudflare.

## 🐛 Errores comunes de implementación

1. **Webhook sin registrar** : tras implementar, ejecute `/setup` (con `X-Setup-Key`), si no el bot no recibe mensajes.
2. **`TG_WEBHOOK_SECRET` cambiado sin re-registrar** : obtiene 403; vuelva a ejecutar `/setup`.
3. **Permisos de token insuficientes** : `/status` informa `[{"code":10000,"message":"Authentication error"}]` → cambie al token Edit All Resources en el Dashboard.
4. **wrangler KV sin `--remote`** : `wrangler kv key get/put` opera sobre el emulador local por defecto; añada `--remote` al depurar la nube.
5. **URL de API personalizada sin protocolo** : debe empezar por `http://` o `https://`, si no se rechaza.
6. **Política de ejecución de PowerShell** : si deploy.ps1 se bloquea, use `powershell -ExecutionPolicy Bypass -File .\deploy.ps1`.
7. **Ajustes de memoria fuera del límite** : `/mem turnos caracteres` se rechaza cuando el total supera ~120 K caracteres; reduzca turnos o caracteres.
8. **Respuestas largas truncadas** : modelos CF max_tokens 4096, APIs personalizadas 2000 — el truncamiento de respuestas muy largas es normal.

---

## 🔒 Notas de seguridad
- Todos los secretos viven en Cloudflare Secrets, nunca en el código
- KV es la única fuente de verdad para la configuración (`cfg:apis`), los cambios surten efecto de inmediato
- El webhook verifica `secret_token`; las rutas de administración verifican las cabeceras de solicitud

## 📄 Licencia
MIT

---

*Este proyecto fue generado con ayuda de IA.*
