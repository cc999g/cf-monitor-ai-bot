/**
 * CF 用量监控 + AI 对话 Telegram Bot
 * 命令：
 *   /start /help - 帮助
 *   /status     - 查询 Cloudflare 账户用量（今日，00:00 UTC 重置）
 *   /ai 问题    - AI 对话（也可直接输入文字，带多轮记忆）
 *   /setapi     - 添加自定义 API（地址 | 密钥 | 模型列表 | 名称[可选]，自动设为主模型）
 *   /delapi     - 删除临时 API（内置 API 不可删）
 *   /setkey     - 修改任意 API 的 Key
 * 访问控制：两级邀请码（TG_ACCESS_CODE=管理员 / TG_MEMBER_CODE=成员）；TG_CHAT_ID 为超级管理员
 * 模型体系：
 *   - Cloudflare 免费模型：永久内置，每人独立选择（KV cfg:pref:<chatId>）
 *   - 内置 API（lfree）：永久保留，不可删除
 *   - 临时 API：/setapi 添加（不覆盖），/delapi 删除
 * 配置存 KV：cfg:apis（API注册表，唯一权威）、cfg:pref:<chatId>（模型偏好）、hist:<chatId>（多轮记忆）、ai_usage:<date>（AI用量）
 * Webhook 安全：setWebhook 带 secret_token，所有 POST 校验 X-Telegram-Bot-Api-Secret-Token
 */

import { t, LANGS, DEFAULT_LANG, isBtn, LANG_NAMES } from './i18n.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    console.log('[hit]', request.method, url.pathname);
    // 一次性初始化路由：由 Worker 自己调用 Telegram 注册 Webhook
    // 用法：curl "https://<worker域名>/setup" -H "X-Setup-Key: <SETUP_KEY>"
    if (url.pathname === '/setup') {
      if ((request.headers.get('X-Setup-Key') || '') !== env.SETUP_KEY) {
        return new Response(JSON.stringify({ ok: false, error: 'bad key' }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        });
      }
      // 诊断模式：检查 env 变量与 GraphQL 调用
      if (url.searchParams.get('diag') === '1') {
        const envState = {
          TG_BOT_TOKEN: env.TG_BOT_TOKEN ? 'set(' + env.TG_BOT_TOKEN.length + ')' : 'MISSING',
          CF_API_TOKEN: env.CF_API_TOKEN ? 'set(' + env.CF_API_TOKEN.length + ')' : 'MISSING',
          CF_ACCOUNT_ID: env.CF_ACCOUNT_ID ? 'set' : 'MISSING',
          TG_CHAT_ID: env.TG_CHAT_ID ? 'set' : 'MISSING',
          SETUP_KEY: env.SETUP_KEY ? 'set' : 'MISSING',
          AI_API_KEY: env.AI_API_KEY ? 'set(' + env.AI_API_KEY.length + ')' : 'unset',
        };
        const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 19) + 'Z';
        const q = `query { viewer { accounts(filter: {accountTag: "${env.CF_ACCOUNT_ID}"}) { workersInvocationsAdaptive(limit: 10, filter: {datetimeHour_geq: "${since}"}, orderBy: [datetimeHour_DESC]) { dimensions { datetimeHour } sum { requests subrequests } } } } }`;
        const gqlRes = await fetch('https://api.cloudflare.com/client/v4/graphql', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${env.CF_API_TOKEN}`,
          },
          body: JSON.stringify({ query: q }),
        });
        const gqlText = await gqlRes.text();
        const pref = await getPref(env);
        const apis = await getApis(env);
        return new Response(JSON.stringify({
          env: envState,
          gqlStatus: gqlRes.status,
          gqlBody: gqlText.slice(0, 500),
          pref,
          apis: apis.map(a => ({ id: a.id, name: a.name, builtin: a.builtin, model: a.model })),
        }), { headers: { 'content-type': 'application/json' } });
      }
      const webhookUrl = url.origin + '/';
      let swUrl = `https://api.telegram.org/bot${env.TG_BOT_TOKEN}/setWebhook?url=${encodeURIComponent(webhookUrl)}&drop_pending_updates=true`;
      if (env.TG_WEBHOOK_SECRET) swUrl += '&secret_token=' + encodeURIComponent(env.TG_WEBHOOK_SECRET);
      const setRes = await fetch(swUrl, { method: 'POST' }).then(r => r.json());
      const infoRes = await fetch(
        `https://api.telegram.org/bot${env.TG_BOT_TOKEN}/getWebhookInfo`
      ).then(r => r.json());
      return new Response(JSON.stringify({ set: setRes, info: infoRes }), {
        headers: { 'content-type': 'application/json' },
      });
    }

    // 调试：查看 bot 身份与 webhook 状态（需 X-Setup-Key 请求头）
    if (url.pathname === '/debug') {
      if ((request.headers.get('X-Setup-Key') || '') !== env.SETUP_KEY) {
        return new Response(JSON.stringify({ ok: false, error: 'bad key' }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        });
      }
      const me = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/getMe`).then(r => r.json());
      const info = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/getWebhookInfo`).then(r => r.json());
      return new Response(JSON.stringify({
        me,
        info,
        env: {
          TG_CHAT_ID: env.TG_CHAT_ID || null,
          hasBotToken: !!env.TG_BOT_TOKEN,
          hasCfToken: !!env.CF_API_TOKEN,
          accountId: env.CF_ACCOUNT_ID || null,
        },
      }), { headers: { 'content-type': 'application/json' } });
    }

    if (request.method !== 'POST') return new Response('ok');

    // Webhook 签名校验：防止伪造的 Telegram 更新
    // Telegram 会把 setWebhook 时的 secret_token 放在 X-Telegram-Bot-Api-Secret-Token 头里
    if (env.TG_WEBHOOK_SECRET && request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.TG_WEBHOOK_SECRET) {
      return new Response('forbidden', { status: 403 });
    }

    let payload;
    try { payload = await request.json(); } catch { return new Response('ok'); }

    console.log('[update]', JSON.stringify(payload).slice(0, 300));

    // ---------- 按钮点击回调 ----------
    if (payload.callback_query) {
      const cb = payload.callback_query;
      const chatId = String(cb.message.chat.id);
      const data = String(cb.data || '');
      console.log('[cb] chatId=' + chatId + ' data=' + data);
      const lang = await getLang(env, chatId);
      const role = await getRole(env, chatId);
      if (!role) {
        await sendTg(env, chatId, t(lang, 'auth_lock'));
        await answerCb(env, cb.id);
        return new Response('ok');
      }
      if (data === 'status') {
        await cfStatus(env, chatId, lang);
      } else if (data === 'ai') {
        await sendTg(env, chatId, t(lang, 'ai_direct'));
      } else if (data === 'help') {
        await sendHelp(env, chatId, lang);
      } else if (data === 'models') {
        await showModels(env, chatId, lang);
      } else if (data === 'setapi') {
        await sendTg(env, chatId, t(lang, 'api_add_help') + '\n\n' + t(lang, 'api_add_ex') + '\n\n· ' + t(lang, 'm_add_hint'));
      } else if (data === 'delapi') {
        await showDelApi(env, chatId, lang);
      } else if (data === 'setkey') {
        await sendTg(env, chatId, t(lang, 'api_key_help'));
      } else if (data === 'mem') {
        await showMemSettings(env, chatId, lang);
      } else if (data === 'lang') {
        await showLangPanel(env, chatId, lang);
      } else if (data.startsWith('lang:')) {
        const newLang = data.slice(5);
        if (LANGS.includes(newLang)) {
          await saveLang(env, chatId, newLang);
          await answerCb(env, cb.id, t(newLang, 'lang_done', { name: LANG_NAMES[newLang] }));
          await sendHelp(env, chatId, newLang);
        } else {
          await answerCb(env, cb.id);
        }
        return new Response('ok');
      } else if (data === 'mem:clear') {
        const confirm = await clearHist(env, chatId, lang, cb.message.message_id);
        await answerCb(env, cb.id, confirm || undefined);
        return new Response('ok');
      } else if (data.startsWith('mem:')) {
        const confirm = await handleMemPick(env, chatId, lang, data, cb.message.message_id);
        await answerCb(env, cb.id, confirm || undefined);
        return new Response('ok');
      } else if (data.startsWith('mc:')) {
        const confirm = await handleModelPick(env, chatId, lang, data, cb.message.message_id);
        await answerCb(env, cb.id, confirm || undefined);
        return new Response('ok');
      } else if (data.startsWith('da:')) {
        await handleDelApiCb(env, chatId, lang, data, cb.id);
        await answerCb(env, cb.id);
        return new Response('ok');
      }
      await answerCb(env, cb.id);
      return new Response('ok');
    }

    const msg = payload.message;
    if (!msg || !msg.text) return new Response('ok');

    const chatId = String(msg.chat.id);
    console.log('[msg] chatId=' + chatId + ' text=' + msg.text.slice(0, 100));

    const text = msg.text.trim();

    // ---------- 语言：读取偏好；无记录时按 Telegram language_code 自动检测 ----------
    let lang = await getLang(env, chatId);
    if (lang === DEFAULT_LANG && msg.from && msg.from.language_code && LANGS.includes(msg.from.language_code)) {
      lang = msg.from.language_code;
      await saveLang(env, chatId, lang);
    }

    // ---------- 访问控制：两级邀请码机制 ----------
    // 管理员邀请码 → 管理员权限；成员邀请码 → 普通成员权限
    // 码来源：KV cfg:codes（bot 内 /setcode 修改，唯一权威）→ 兜底环境变量 TG_ACCESS_CODE / TG_MEMBER_CODE
    // 超级管理员（TG_CHAT_ID）永远为管理员；已激活记录存 KV chat:<id> = 'admin' | 'member'
    const role = await getRole(env, chatId);
    if (!role) {
      const codes = await getCodes(env);
      if (codes.admin && text === codes.admin) {
        try {
          await env.ACCESS.put('chat:' + chatId, 'admin');
          await sendHelp(env, chatId, lang, t(lang, 'auth_admin'));
        } catch (e) {
          console.log('[access-put-err]', String(e.message || e));
          await sendTg(env, chatId, t(lang, 'auth_fail'));
        }
      } else if (codes.member && text === codes.member) {
        try {
          await env.ACCESS.put('chat:' + chatId, 'member');
          await sendHelp(env, chatId, lang, t(lang, 'auth_member'));
        } catch (e) {
          console.log('[access-put-err]', String(e.message || e));
          await sendTg(env, chatId, t(lang, 'auth_fail'));
        }
      } else {
        await sendTg(env, chatId, env.AUTH_GROUP_ID ? t(lang, 'auth_group') : t(lang, 'auth_hint'));
      }
      return new Response('ok');
    }

    const isAdmin = role === 'admin';

    if (text === '/start' || text === '/help' || isBtn(text, 'btn_help')) {
      await sendHelp(env, chatId, lang);
    } else if (text === '/status' || isBtn(text, 'btn_status') || text === '📊 查看用量') {
      await cfStatus(env, chatId, lang);
    } else if (isBtn(text, 'btn_ai') || text === '/ai') {
      await sendTg(env, chatId, t(lang, 'ai_direct'));
    } else if (isBtn(text, 'btn_models')) {
      await showModels(env, chatId, lang);
    } else if (isBtn(text, 'btn_addapi') || text === '⚙️ 设置API') {
      await sendTg(env, chatId, t(lang, 'api_add_help') + '\n\n' + t(lang, 'api_add_ex') + '\n\n· ' + t(lang, 'm_add_hint'));
    } else if (isBtn(text, 'btn_delapi')) {
      await showDelApi(env, chatId, lang);
    } else if (isBtn(text, 'btn_key')) {
      await sendTg(env, chatId, t(lang, 'api_key_help'));
    } else if (isBtn(text, 'btn_mem')) {
      await showMemSettings(env, chatId, lang);
    } else if (isBtn(text, 'btn_new') || text === '/new' || text === '/clear' || text === '/reset') {
      await clearHist(env, chatId, lang);
    } else if (text === '/lang') {
      await showLangPanel(env, chatId, lang);
    } else if (text.startsWith('/mem')) {
      await handleMem(env, chatId, lang, text);
    } else if (text.startsWith('/setkey')) {
      if (!isAdmin) { await sendTg(env, chatId, t(lang, 'perm_admin_key')); return new Response('ok'); }
      await handleSetKey(env, chatId, lang, text);
    } else if (text.startsWith('/setcode')) {
      if (!isAdmin) { await sendTg(env, chatId, t(lang, 'perm_admin_code')); return new Response('ok'); }
      await handleSetCode(env, chatId, lang, text);
    } else if (text.startsWith('/setapi')) {
      if (!isAdmin) { await sendTg(env, chatId, t(lang, 'perm_admin_api')); return new Response('ok'); }
      await handleSetApi(env, chatId, lang, text);
    } else if (text.startsWith('/delapi')) {
      if (!isAdmin) { await sendTg(env, chatId, t(lang, 'perm_admin_del')); return new Response('ok'); }
      await handleDelApi(env, chatId, lang, text);
    } else if (text.startsWith('/ai ')) {
      await aiChat(env, chatId, lang, text.slice(4));
    } else if (text.startsWith('/ai\n')) {
      await aiChat(env, chatId, lang, text.slice(4));
    } else if (text.startsWith('/')) {
      await sendTg(env, chatId, t(lang, 'unk'));
    } else {
      // 默认模式：任何普通文字都走 AI 对话
      await aiChat(env, chatId, lang, text);
    }

    return new Response('ok');
  },

};

// ============================================================
// 模型体系：Cloudflare 免费（永久）+ API 注册表（内置永久 + 临时可删）
// ============================================================

// Cloudflare 免费模型（短码 id + 完整绑定名；显示名/优缺点在多语言字典里）
const CF_MODELS = [
  { id: 'qwen3', full: '@cf/qwen/qwen3-30b-a3b-fp8' },
  { id: 'gpt120b', full: '@cf/openai/gpt-oss-120b' },
  { id: 'llama70b', full: '@cf/meta/llama-3.3-70b-instruct-fp8-fast' },
  { id: 'mistral24b', full: '@cf/mistralai/mistral-small-3.1-24b-instruct' },
  { id: 'llama8b', full: '@cf/meta/llama-3.1-8b-instruct-fp8' },
];
// 每个 CF 模型的 i18n key：[名称, 优点, 缺点]
const CF_KEYS = {
  qwen3: ['m_qwen_n', 'm_qwen_p', 'm_qwen_c'],
  gpt120b: ['m_gpt_n', 'm_gpt_p', 'm_gpt_c'],
  llama70b: ['m_l70_n', 'm_l70_p', 'm_l70_c'],
  mistral24b: ['m_mis_n', 'm_mis_p', 'm_mis_c'],
  llama8b: ['m_l8_n', 'm_l8_p', 'm_l8_c'],
};
function cfName(lang, id) {
  const k = CF_KEYS[id];
  return k ? t(lang, k[0]) : id;
}
// Cloudflare 回退链（选中模型失败时依次尝试）
const CF_FALLBACK = [
  '@cf/qwen/qwen3-30b-a3b-fp8',
  '@cf/openai/gpt-oss-120b',
  '@cf/meta/llama-3.1-8b-instruct-fp8',
];

// ---------- API 注册表 ----------
// cfg:apis = [{ id, name, url, key, model, builtin }]
// builtin=true 的条目永久保留，/delapi 不可删除，/setapi 不会覆盖
// KV 是唯一权威：/setkey /setapi /delapi 的修改立即生效，不受环境变量影响
async function getApis(env) {
  try {
    const raw = await env.ACCESS.get('cfg:apis');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch (e) {
    console.log('[apis-read-err]', String(e.message || e));
  }
  // 首次初始化：从旧 secret 迁移为内置 lfree（仅当注册表为空时执行一次）
  if (env.AI_API_KEY) {
    const arr = [{
      id: 'lfree',
      name: 'lfree',
      url: env.AI_API_URL || 'https://api.openai.com/v1',
      key: env.AI_API_KEY,
      model: env.AI_API_MODEL || '',
      builtin: true,
    }];
    try { await env.ACCESS.put('cfg:apis', JSON.stringify(arr)); } catch (e) { console.log('[apis-seed-err]', String(e.message || e)); }
    return arr;
  }
  return [];
}

async function saveApis(env, arr) {
  await env.ACCESS.put('cfg:apis', JSON.stringify(arr));
}

// ---------- 模型偏好（按用户隔离） ----------
// 每人独立：cfg:pref:<chatId> = { type: 'cf' | 'api', cfModel: <CF短码>, apiId: <api.id>, model: <模型名> }
// chatId 为空时读全局旧键（兼容 /setup diag）
async function getPref(env, chatId) {
  const key = chatId ? 'cfg:pref:' + chatId : 'cfg:pref';
  try {
    const raw = await env.ACCESS.get(key);
    if (raw) {
      const p = JSON.parse(raw);
      return {
        type: p.type === 'api' ? 'api' : 'cf',
        cfModel: p.cfModel || CF_MODELS[0].id,
        apiId: p.apiId || '',
        model: p.model || '',
      };
    }
    // 旧版全局偏好迁移：用户键不存在时继承一次全局值
    if (chatId) {
      const legacy = await env.ACCESS.get('cfg:pref');
      if (legacy) {
        const lp = JSON.parse(legacy);
        const init = {
          type: lp.type === 'api' ? 'api' : 'cf',
          cfModel: lp.cfModel || CF_MODELS[0].id,
          apiId: lp.apiId || '',
          model: lp.model || '',
        };
        await env.ACCESS.put(key, JSON.stringify(init));
        return init;
      }
    }
  } catch (e) {
    console.log('[pref-read-err]', String(e.message || e));
  }
  return { type: 'cf', cfModel: CF_MODELS[0].id, apiId: '', model: '' };
}

async function savePref(env, chatId, pref) {
  const key = chatId ? 'cfg:pref:' + chatId : 'cfg:pref';
  await env.ACCESS.put(key, JSON.stringify(pref));
}

// ---------- 模型偏好自愈：指向的 API 已不存在 → 自动切回 CF ----------
// 返回是否发生了修复（已保存）
async function healPref(env, chatId, pref, apis) {
  if (pref.type === 'api' && pref.apiId) {
    const api = apis.find(a => a.id === pref.apiId);
    if (!api) {
      pref.type = 'cf';
      pref.cfModel = pref.cfModel || CF_MODELS[0].id;
      pref.apiId = '';
      pref.model = '';
      await savePref(env, chatId, pref);
      return true;
    }
  }
  return false;
}

// ---------- 当前主模型描述 ----------
function describeCurrent(pref, apis, lang) {
  if (pref.type === 'api') {
    const api = apis.find(a => a.id === pref.apiId);
    const src = api ? api.name : 'unknown';
    return '<b>' + escapeHtml(pref.model || 'custom') + '</b>（' + escapeHtml(src) + '）';
  }
  const m = CF_MODELS.find(x => x.id === pref.cfModel) || CF_MODELS[0];
  return '<b>' + cfName(lang, m.id) + '</b>（Cloudflare）';
}

// ---------- 模型选择面板：消息与按钮 ----------
function buildModelsMsg(pref, apis, lang) {
  let msg = t(lang, 'm_title') + '\n\n';
  msg += t(lang, 'm_current', { model: describeCurrent(pref, apis, lang) }) + '\n\n';
  msg += t(lang, 'm_legend') + '\n\n';

  // CF 免费模型（永久）
  msg += t(lang, 'm_cf_sec') + '：\n';
  for (const m of CF_MODELS) {
    const mark = pref.type === 'cf' && pref.cfModel === m.id ? '✅ ' : '⚪ ';
    msg += mark + '<b>' + cfName(lang, m.id) + '</b>\n　👍 ' + t(lang, CF_KEYS[m.id][1]) + '\n　👎 ' + t(lang, CF_KEYS[m.id][2]) + '\n';
  }

  // API 模型
  for (const api of apis) {
    const customModels = (api.model || '').split(',').map(s => s.trim()).filter(Boolean);
    if (customModels.length === 0) continue;
    const tag = api.builtin ? '🔑' : '📦';
    msg += '\n' + t(lang, 'm_api_sec', { tag, name: escapeHtml(api.name) + (api.builtin ? t(lang, 'm_builtin') : t(lang, 'm_tmp')) }) + '：\n';
    for (const m of customModels) {
      const mark = pref.type === 'api' && pref.apiId === api.id && pref.model === m ? '✅ ' : '⚪ ';
      msg += mark + '<b>' + escapeHtml(m) + '</b>\n';
    }
  }

  if (apis.length === 0) {
    msg += '\n' + t(lang, 'm_none');
  }
  return msg;
}

function buildModelsKb(pref, apis, lang) {
  const rows = [];
  // CF 免费模型：☁️ 前缀
  for (let i = 0; i < CF_MODELS.length; i += 2) {
    rows.push(CF_MODELS.slice(i, i + 2).map(m => ({
      text: (pref.type === 'cf' && pref.cfModel === m.id ? '✅ ' : '') + '☁️ ' + cfName(lang, m.id),
      callback_data: 'mc:cf:' + m.id,
    })));
  }
  // API 模型：🔑 内置 / 📦 临时，带 API 名
  for (const api of apis) {
    const customModels = (api.model || '').split(',').map(s => s.trim()).filter(Boolean);
    if (customModels.length === 0) continue;
    const prefix = api.builtin ? '🔑 ' : '📦 ' + api.name + '·';
    for (let i = 0; i < customModels.length; i += 2) {
      rows.push(customModels.slice(i, i + 2).map(m => ({
        text: (pref.type === 'api' && pref.apiId === api.id && pref.model === m ? '✅ ' : '') + prefix + m,
        callback_data: 'mc:api:' + api.id + ':' + i,
      })));
    }
  }
  const bottom = [{ text: t(lang, 'btn_addapi'), callback_data: 'setapi' }];
  const hasTmp = apis.some(a => !a.builtin);
  if (hasTmp) bottom.push({ text: t(lang, 'btn_delapi'), callback_data: 'delapi' });
  rows.push(bottom);
  return rows;
}

async function showModels(env, chatId, lang) {
  const pref = await getPref(env, chatId);
  const apis = await getApis(env);
  await healPref(env, chatId, pref, apis); // 自愈：指向已删除 API 时切回 CF
  await sendTg(env, chatId, buildModelsMsg(pref, apis, lang), { inline_keyboard: buildModelsKb(pref, apis, lang) }, true);
}

// ---------- 处理模型选择回调 ----------
// 返回确认文案（供 answerCallbackQuery toast 显示）
async function handleModelPick(env, chatId, lang, data, msgId) {
  try {
    const pref = await getPref(env, chatId);
    const apis = await getApis(env);
    let confirm = '';
    const parts = data.split(':');
    // mc:cf:<id> | mc:api:<apiId>:<idx>
    if (parts[1] === 'cf') {
      const id = parts.slice(2).join(':');
      const m = CF_MODELS.find(x => x.id === id);
      if (!m) return '';
      pref.type = 'cf';
      pref.cfModel = id;
      pref.apiId = '';
      pref.model = '';
      confirm = t(lang, 'sw_ok', { name: cfName(lang, id) });
    } else if (parts[1] === 'api') {
      const apiId = parts.slice(2, -1).join(':');
      const idx = parseInt(parts[parts.length - 1], 10);
      const api = apis.find(a => a.id === apiId);
      if (!api) return '';
      const customModels = (api.model || '').split(',').map(s => s.trim()).filter(Boolean);
      const m = customModels[idx];
      if (!m) return '';
      pref.type = 'api';
      pref.apiId = apiId;
      pref.model = m;
      confirm = t(lang, 'sw_ok', { name: m });
    } else {
      return '';
    }
    await savePref(env, chatId, pref);
    // 刷新面板：优先编辑原消息（带最新 ✅ 标记），失败则补发新面板
    const newMsg = buildModelsMsg(pref, apis, lang);
    const newKb = { inline_keyboard: buildModelsKb(pref, apis, lang) };
    let edited = false;
    if (msgId) {
      edited = await editTg(env, chatId, msgId, newMsg, newKb);
    }
    if (!edited) {
      await sendTg(env, chatId, newMsg, newKb, true);
    }
    return confirm;
  } catch (e) {
    console.log('[model-pick-err]', String(e.message || e));
    return '❌';
  }
}

// ---------- 删除临时 API 面板 ----------
async function showDelApi(env, chatId, lang) {
  const apis = await getApis(env);
  const tmp = apis.filter(a => !a.builtin);
  let msg = t(lang, 'api_del_help') + '\n\n';
  if (tmp.length === 0) {
    msg += t(lang, 'api_del_none');
    await sendTg(env, chatId, msg);
    return;
  }
  msg += t(lang, 'api_del_here') + '\n\n';
  const rows = [];
  for (const a of tmp) {
    const models = (a.model || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 3).join(', ');
    msg += '· <b>' + escapeHtml(a.name) + '</b>：' + escapeHtml(models) + '\n';
    rows.push([{ text: '🗑️ ' + a.name, callback_data: 'da:' + a.id }]);
  }
  await sendTg(env, chatId, msg, { inline_keyboard: rows }, true);
}

// ---------- 处理删除回调 ----------
async function handleDelApiCb(env, chatId, lang, data, cbId) {
  try {
    const isAdmin = (await getRole(env, chatId)) === 'admin';
    if (!isAdmin) {
      await sendTg(env, chatId, t(lang, 'perm_admin_del'));
      return;
    }
    const apiId = data.slice(3);
    const apis = await getApis(env);
    const api = apis.find(a => a.id === apiId);
    if (!api) {
      await sendTg(env, chatId, t(lang, 'api_del_nf', { name: apiId }));
      return;
    }
    if (api.builtin) {
      await sendTg(env, chatId, t(lang, 'api_del_bi', { name: escapeHtml(api.name) }));
      return;
    }
    const rest = apis.filter(a => a.id !== apiId);
    await saveApis(env, rest);
    // 如果删的是当前主模型，切回 Cloudflare
    const pref = await getPref(env, chatId);
    if (pref.type === 'api' && pref.apiId === apiId) {
      pref.type = 'cf';
      pref.apiId = '';
      pref.model = '';
      await savePref(env, chatId, pref);
    }
    await sendTg(env, chatId, t(lang, 'api_del_done', { name: '<b>' + escapeHtml(api.name) + '</b>' }));
  } catch (e) {
    console.log('[delapi-cb-err]', String(e.message || e));
    await sendTg(env, chatId, t(lang, 'err_generic', { err: escapeHtml(String(e.message || e)) }));
  }
}

// ---------- /setapi 添加 API ----------
async function handleSetApi(env, chatId, lang, text) {
  try {
    const arg = text.replace(/^\/setapi\s*/, '').trim();
    if (!arg) {
      await sendTg(env, chatId, t(lang, 'api_add_help') + '\n\n' + t(lang, 'api_add_ex'));
      return;
    }
    const parts = arg.split('|').map(s => s.trim());
    if (parts.length < 3) {
      await sendTg(env, chatId, t(lang, 'api_add_err'));
      return;
    }
    const url = parts[0];
    const key = parts[1];
    const model = parts[2];
    const name = parts[3] || (url.replace(/^https?:\/\//, '').split('/')[0] || 'api');
    if (!url || !key || !model) {
      await sendTg(env, chatId, t(lang, 'api_add_empty'));
      return;
    }
    if (!/^https?:\/\//i.test(url)) {
      await sendTg(env, chatId, t(lang, 'api_add_url', { url: '<code>' + escapeHtml(url) + '</code>' }));
      return;
    }
    const apis = await getApis(env);
    // 名称重复则自动加序号
    let finalName = name;
    let n = 1;
    while (apis.some(a => a.name === finalName)) {
      finalName = name + '-' + (++n);
    }
    const api = {
      id: 'api' + Date.now().toString(36),
      name: finalName,
      url,
      key,
      model,
      builtin: false,
    };
    apis.push(api);
    await saveApis(env, apis);
    // 自动把该 API 的第一个模型设为主模型
    const firstModel = (api.model || '').split(',').map(s => s.trim()).filter(Boolean)[0];
    if (firstModel) {
      const pref = await getPref(env, chatId);
      pref.type = 'api';
      pref.apiId = api.id;
      pref.model = firstModel;
      await savePref(env, chatId, pref);
    }
    await sendTg(env, chatId,
      t(lang, 'api_add_done', { name: '<b>' + escapeHtml(finalName) + '</b>' }) +
      (firstModel ? t(lang, 'api_add_main', { model: '<b>' + escapeHtml(firstModel) + '</b>' }) : '') +
      t(lang, 'api_add_keep', { model: escapeHtml(model) })
    );
  } catch (e) {
    console.log('[setapi-err]', String(e.message || e));
    await sendTg(env, chatId, t(lang, 'err_save', { err: escapeHtml(String(e.message || e)) }));
  }
}

// ---------- /setkey 修改 API Key ----------
async function handleSetKey(env, chatId, lang, text) {
  try {
    const arg = text.replace(/^\/setkey\s*/, '').trim();
    const parts = arg.split(/\s+/);
    if (!arg || parts.length < 2) {
      await sendTg(env, chatId, t(lang, 'api_key_help'));
      return;
    }
    const name = parts[0];
    const newKey = parts.slice(1).join('');
    if (newKey.length < 10) {
      await sendTg(env, chatId, t(lang, 'api_key_short'));
      return;
    }
    const apis = await getApis(env);
    const target = apis.find(a => a.name === name) || apis.find(a => a.id === name);
    if (!target) {
      await sendTg(env, chatId, t(lang, 'api_key_nf', { name: '<b>' + escapeHtml(name) + '</b>' }));
      return;
    }
    target.key = newKey;
    await saveApis(env, apis);
    await sendTg(env, chatId, t(lang, 'api_key_done', {
      name: '<b>' + escapeHtml(target.name) + '</b>',
      tail: '<code>' + escapeHtml(newKey.slice(-4)) + '</code>',
    }));
  } catch (e) {
    console.log('[setkey-err]', String(e.message || e));
    await sendTg(env, chatId, t(lang, 'err_generic', { err: escapeHtml(String(e.message || e)) }));
  }
}

// ---------- /delapi 命令 ----------
async function handleDelApi(env, chatId, lang, text) {
  try {
    const arg = text.replace(/^\/delapi\s*/, '').trim();
    if (!arg) {
      await showDelApi(env, chatId, lang);
      return;
    }
    const apis = await getApis(env);
    const target = apis.find(a => a.name === arg) || apis.find(a => a.id === arg);
    if (!target) {
      await sendTg(env, chatId, t(lang, 'api_del_nf', { name: '<b>' + escapeHtml(arg) + '</b>' }));
      return;
    }
    if (target.builtin) {
      await sendTg(env, chatId, t(lang, 'api_del_bi', { name: escapeHtml(target.name) }));
      return;
    }
    const rest = apis.filter(a => a.id !== target.id);
    await saveApis(env, rest);
    const pref = await getPref(env, chatId);
    if (pref.type === 'api' && pref.apiId === target.id) {
      pref.type = 'cf';
      pref.apiId = '';
      pref.model = '';
      await savePref(env, chatId, pref);
    }
    await sendTg(env, chatId, t(lang, 'api_del_done', { name: '<b>' + escapeHtml(target.name) + '</b>' }));
  } catch (e) {
    console.log('[delapi-err]', String(e.message || e));
    await sendTg(env, chatId, t(lang, 'err_generic', { err: escapeHtml(String(e.message || e)) }));
  }
}

// ============================================================
// 访问控制 / 帮助 / 键盘
// ============================================================

// ---------- 群聊鉴权（默认）：getChatMember 验证是否在授权群内 ----------
// 群主/群管理员 → 'admin'；群成员 → 'member'；不在群 → null（走邀请码兜底）
// 结果缓存 KV gauth:<chatId>（3600s）；'no' = 不在群（300s 短缓存，避免频繁调 TG API）
async function groupRole(env, chatId) {
  if (!env.AUTH_GROUP_ID || !env.TG_BOT_TOKEN) return null;
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/getChatMember`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: Number(env.AUTH_GROUP_ID), user_id: Number(chatId) }),
    }).then(r => r.json());
    if (!res.ok || !res.result) return null;
    const st = res.result.status;
    if (st === 'creator' || st === 'administrator') return 'admin';
    if (st === 'member' || st === 'restricted') return 'member';
    return null; // left/kicked 不在群
  } catch (e) {
    console.log('[group-role-err]', String(e.message || e));
    return null;
  }
}

// ---------- 角色获取 ----------
// 返回 'admin' | 'member' | null
// 优先级：超级管理员（TG_CHAT_ID）永远 admin → 群聊鉴权（默认，AUTH_GROUP_ID 配置时）
//         → 邀请码激活记录（KV chat:<id>：admin/member/旧版时间戳视为 admin）
async function getRole(env, chatId) {
  const isBoss = env.TG_CHAT_ID && String(chatId) === String(env.TG_CHAT_ID);
  if (isBoss) return 'admin';
  if (env.AUTH_GROUP_ID) {
    try {
      const cached = await env.ACCESS.get('gauth:' + chatId);
      if (cached === 'admin' || cached === 'member') return cached;
      if (cached !== 'no') {
        const gRole = await groupRole(env, chatId);
        if (gRole) {
          try { await env.ACCESS.put('gauth:' + chatId, gRole, { expirationTtl: 3600 }); } catch (_) { /* 缓存失败不影响 */ }
          return gRole;
        }
        try { await env.ACCESS.put('gauth:' + chatId, 'no', { expirationTtl: 300 }); } catch (_) { /* 同上 */ }
      }
    } catch (e) {
      console.log('[gauth-err]', String(e.message || e));
    }
  }
  try {
    const v = await env.ACCESS.get('chat:' + chatId);
    if (v === 'admin') return 'admin';
    if (v === 'member') return 'member';
    if (v) return 'admin'; // 旧数据（时间戳）视为管理员
  } catch (e) {
    console.log('[role-kv-err]', String(e.message || e));
  }
  return null;
}

// ---------- 邀请码读取 ----------
// 优先 KV cfg:codes（/setcode 修改的唯一权威），兜底环境变量（兼容旧部署）
async function getCodes(env) {
  try {
    const raw = await env.ACCESS.get('cfg:codes');
    if (raw) {
      const c = JSON.parse(raw);
      if (c && c.admin) return { admin: String(c.admin), member: String(c.member || '') };
    }
  } catch (e) {
    console.log('[codes-read-err]', String(e.message || e));
  }
  return {
    admin: env.TG_ACCESS_CODE ? String(env.TG_ACCESS_CODE) : '',
    member: env.TG_MEMBER_CODE ? String(env.TG_MEMBER_CODE) : '',
  };
}

// ---------- /setcode 设置邀请码（仅管理员） ----------
async function handleSetCode(env, chatId, lang, text) {
  try {
    const arg = text.replace(/^\/setcode\s*/, '').trim();
    const parts = arg.split(/\s+/);
    if (!arg || parts.length < 2) {
      await sendTg(env, chatId, t(lang, 'code_help'));
      return;
    }
    const admin = parts[0];
    const member = parts[1];
    if (admin.length < 6 || member.length < 6) {
      await sendTg(env, chatId, t(lang, 'code_err_len'));
      return;
    }
    if (admin === member) {
      await sendTg(env, chatId, t(lang, 'code_err_same'));
      return;
    }
    await env.ACCESS.put('cfg:codes', JSON.stringify({ admin, member }));
    await sendTg(env, chatId, t(lang, 'code_done', {
      admin: '<code>' + escapeHtml(admin) + '</code>',
      member: '<code>' + escapeHtml(member) + '</code>',
    }));
  } catch (e) {
    console.log('[setcode-err]', String(e.message || e));
    await sendTg(env, chatId, t(lang, 'err_generic', { err: escapeHtml(String(e.message || e)) }));
  }
}

// ---------- 语言偏好：KV lang:<chatId> ----------
async function getLang(env, chatId) {
  try {
    const v = await env.ACCESS.get('lang:' + chatId);
    if (v && LANGS.includes(v)) return v;
  } catch (e) {
    console.log('[lang-read-err]', String(e.message || e));
  }
  return DEFAULT_LANG;
}

async function saveLang(env, chatId, lang) {
  try {
    await env.ACCESS.put('lang:' + chatId, lang);
  } catch (e) {
    console.log('[lang-write-err]', String(e.message || e));
  }
}

// ---------- 语言选择面板 ----------
async function showLangPanel(env, chatId, lang) {
  const rows = [];
  for (let i = 0; i < LANGS.length; i += 2) {
    rows.push(LANGS.slice(i, i + 2).map(l => ({
      text: (lang === l ? '✅ ' : '') + LANG_NAMES[l],
      callback_data: 'lang:' + l,
    })));
  }
  await sendTg(env, chatId, t(lang, 'lang_title'), { inline_keyboard: rows }, true);
}

// ---------- 帮助（带按钮） ----------
async function sendHelp(env, chatId, lang, extra) {
  const helpText =
    t(lang, 'help_title') + '\n\n' +
    (extra ? extra + '\n\n' : '') +
    t(lang, 'help_direct') + '\n' +
    t(lang, 'cmd_label') + '\n' +
    '· <code>/status</code> — ' + t(lang, 'cmd_status').split('—')[1].trim() + '\n' +
    '· <code>/setapi</code> — ' + t(lang, 'cmd_setapi').split('—')[1].trim() + '\n' +
    '· <code>/delapi</code> — ' + t(lang, 'cmd_delapi').split('—')[1].trim() + '\n' +
    '· <code>/setkey</code> — ' + t(lang, 'cmd_setkey').split('—')[1].trim() + '\n' +
    '· <code>/setcode</code> — ' + t(lang, 'cmd_setcode').split('—')[1].trim() + '\n' +
    '· <code>/mem</code> — ' + t(lang, 'cmd_mem').split('—')[1].trim() + '\n' +
    '· <code>/new</code> — ' + t(lang, 'cmd_new').split('—')[1].trim() + '\n' +
    '· <code>/lang</code> — ' + t(lang, 'cmd_lang').split('—')[1].trim() + '\n' +
    '· <code>/help</code> — ' + t(lang, 'cmd_help').split('—')[1].trim() + '\n\n' +
    t(lang, 'help_footer');
  await sendTg(env, chatId, helpText, null);
}

// ---------- 常驻快捷键盘（按用户语言） ----------
function replyKb(lang) {
  return {
    keyboard: [
      [{ text: t(lang, 'btn_status') }, { text: t(lang, 'btn_ai') }, { text: t(lang, 'btn_models') }],
      [{ text: t(lang, 'btn_mem') }, { text: t(lang, 'btn_new') }],
      [{ text: t(lang, 'btn_addapi') }, { text: t(lang, 'btn_delapi') }, { text: t(lang, 'btn_key') }],
      [{ text: t(lang, 'btn_help') }],
    ],
    resize_keyboard: true,
    one_time_keyboard: false,
  };
}

// ---------- Telegram 发送消息（默认带常驻快捷键盘，键盘语言跟随用户偏好） ----------
async function sendTg(env, chatId, text, inlineKb, noReplyKb) {
  const lang = await getLang(env, chatId);
  const body = { chat_id: chatId, text, parse_mode: 'HTML' };
  if (inlineKb) body.reply_markup = JSON.stringify(inlineKb);
  else if (!noReplyKb) body.reply_markup = JSON.stringify(replyKb(lang));
  const r = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const txt = await r.text();
  console.log('[send]', r.status, txt.slice(0, 300));
  try { return JSON.parse(txt); } catch { return null; }
}

// ---------- 编辑消息（支持 inline 键盘；返回是否成功） ----------
async function editTg(env, chatId, messageId, text, inlineKb) {
  try {
    const body = { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML' };
    if (inlineKb) body.reply_markup = JSON.stringify(inlineKb);
    const r = await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/editMessageText`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const txt = await r.text();
    console.log('[edit]', r.status, txt.slice(0, 200));
    try { return JSON.parse(txt).ok === true; } catch { return false; }
  } catch (e) {
    console.log('[edit-err]', String(e.message || e));
    return false;
  }
}

// ---------- 应答按钮回调（消除 loading；text 为 toast 提示） ----------
async function answerCb(env, cbId, text) {
  try {
    const body = { callback_query_id: cbId };
    if (text) body.text = text;
    await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    console.log('[cb-answer-err]', String(e.message || e));
  }
}

// ============================================================
// 用量查询
// ============================================================

const WRK_DAILY_LIMIT = 100000; // Workers Free 每日请求上限（00:00 UTC 重置）
const AI_DAILY_LIMIT = 10000;   // Workers AI 免费额度 Neurons/天（00:00 UTC 重置）

async function cfStatus(env, chatId, lang) {
  try {
    // 今日 00:00 UTC 起点
    const now = new Date();
    const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
    const query = `query { viewer { accounts(filter: {accountTag: "${env.CF_ACCOUNT_ID}"}) {
      workersInvocationsAdaptive(limit: 5000, filter: {datetimeMinute_geq: "${since}"}, orderBy: [datetimeMinute_DESC]) {
        dimensions { datetimeMinute }
        sum { requests subrequests }
      } } } }`;
    const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${env.CF_API_TOKEN}`,
      },
      body: JSON.stringify({ query }),
    });
    const data = await res.json();
    const groups = data?.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive || [];
    let totalReq = 0, totalSub = 0;
    for (const g of groups) {
      totalReq += g.sum?.requests || 0;
      totalSub += g.sum?.subrequests || 0;
    }

    // 本 Bot 今日 AI Neurons 用量（KV 累计）
    const today = since.slice(0, 10);
    let aiUsed = 0;
    try {
      aiUsed = parseFloat(await env.ACCESS.get('ai_usage:' + today)) || 0;
    } catch (e) {
      console.log('[ai-usage-read-err]', String(e.message || e));
    }

    // 当前主模型
    const pref = await getPref(env, chatId);
    const apis = await getApis(env);
    const curModel = describeCurrent(pref, apis, lang);

    let msg = t(lang, 'u_title') + '\n\n';
    msg += t(lang, 'u_workers') + '\n';
    msg += t(lang, 'u_used', { used: '<b>' + totalReq.toLocaleString() + '</b>', total: WRK_DAILY_LIMIT.toLocaleString() }) + '\n';
    msg += t(lang, 'u_remaining', { left: Math.max(0, WRK_DAILY_LIMIT - totalReq).toLocaleString() }) + '\n';
    msg += t(lang, 'u_sub', { sub: totalSub.toLocaleString() }) + '\n\n';
    msg += t(lang, 'u_ai') + '\n';
    msg += t(lang, 'u_used', { used: '<b>' + aiUsed.toFixed(1) + '</b>', total: AI_DAILY_LIMIT.toLocaleString() }) + ' Neurons\n';
    msg += t(lang, 'u_remaining', { left: Math.max(0, AI_DAILY_LIMIT - aiUsed).toFixed(1) }) + ' Neurons\n\n';
    msg += t(lang, 'u_model', { model: curModel });
    await sendTg(env, chatId, msg);
  } catch (e) {
    await sendTg(env, chatId, t(lang, 'u_err', { err: escapeHtml(String(e.message || e)) }));
  }
}

// ============================================================
// AI 对话（主用 Cloudflare 免费模型，自定义 API 可选，带多轮记忆）
// ============================================================

// 系统提示按用户语言（让模型用对应语言回答）
const SYSTEM_PROMPTS = {
  zh: '你是一个乐于助人的中文AI助手，请用简洁清晰、自然连贯的中文回答用户问题。',
  en: 'You are a helpful AI assistant. Answer in concise, natural, clear English.',
  ja: 'あなたは親切なAIアシスタントです。簡潔で自然な日本語で答えてください。',
  ko: '당신은 도움이 되는 AI 어시스턴트입니다. 간결하고 자연스러운 한국어로 답변하세요.',
  fr: 'Vous êtes un assistant IA serviable. Répondez en français, de manière concise et naturelle.',
  de: 'Sie sind ein hilfreicher KI-Assistent. Antworten Sie kurz und natürlich auf Deutsch.',
  es: 'Eres un asistente de IA servicial. Responde de forma concisa y natural en español.',
  ru: 'Вы полезный ИИ-ассистент. Отвечайте кратко и естественно на русском языке.',
};

// ---------- 记忆深度设置（每人独立，KV cfg:mem:<chatId>） ----------
// 档位：从少到多，只受模型上下文能力约束（上限约 12 万字符 ≈ 128K tokens）
// 档位名称/描述在多语言字典里（mem_light / mem_light_d ...）
const MEM_PRESETS = [
  { id: 'light', rounds: 1, len: 400 },
  { id: 'std', rounds: 5, len: 1000 },
  { id: 'mid', rounds: 10, len: 1500 },
  { id: 'deep', rounds: 20, len: 2000 },
  { id: 'max', rounds: 40, len: 3000 },
];
const MEM_MAX_CHARS = 120000; // 总字符上限（模型窗口保护）
function memName(lang, id) { return t(lang, 'mem_' + id); }
function memDesc(lang, id) { return t(lang, 'mem_' + id + '_d'); }

async function getMem(env, chatId) {
  try {
    const raw = await env.ACCESS.get('cfg:mem:' + chatId);
    if (raw) {
      const m = JSON.parse(raw);
      const rounds = Math.min(Math.max(parseInt(m.rounds, 10) || 5, 1), 100);
      const len = Math.min(Math.max(parseInt(m.len, 10) || 1000, 100), 4000);
      return { rounds, len };
    }
  } catch (e) {
    console.log('[mem-read-err]', String(e.message || e));
  }
  return { rounds: 5, len: 1000 }; // 默认"标准"
}

async function saveMem(env, chatId, mem) {
  await env.ACCESS.put('cfg:mem:' + chatId, JSON.stringify(mem));
}

// ---------- 记忆设置面板 ----------
async function showMemSettings(env, chatId, lang) {
  const mem = await getMem(env, chatId);
  let msg = t(lang, 'mem_title') + '\n\n';
  msg += t(lang, 'mem_current', { rounds: '<b>' + mem.rounds + '</b>', len: '<b>' + mem.len + '</b>', total: mem.rounds * mem.len }) + '\n\n';
  msg += t(lang, 'mem_desc') + '\n\n';
  for (const p of MEM_PRESETS) {
    const mark = mem.rounds === p.rounds && mem.len === p.len ? '✅ ' : '⚪ ';
    msg += mark + '<b>' + memName(lang, p.id) + '</b> — ' + memDesc(lang, p.id) + '\n';
  }
  msg += '\n' + t(lang, 'mem_custom') + '\n' + t(lang, 'mem_custom_ex');
  const rows = [];
  for (let i = 0; i < MEM_PRESETS.length; i += 2) {
    rows.push(MEM_PRESETS.slice(i, i + 2).map(p => ({
      text: (mem.rounds === p.rounds && mem.len === p.len ? '✅ ' : '') + memName(lang, p.id),
      callback_data: 'mem:' + p.id,
    })));
  }
  rows.push([{ text: t(lang, 'mem_btn_clear'), callback_data: 'mem:clear' }]);
  await sendTg(env, chatId, msg, { inline_keyboard: rows }, true);
}

// ---------- 记忆档位回调 ----------
async function handleMemPick(env, chatId, lang, data, msgId) {
  const id = data.split(':')[1];
  const p = MEM_PRESETS.find(x => x.id === id);
  if (!p) return '';
  await saveMem(env, chatId, { rounds: p.rounds, len: p.len });
  const newMsg = t(lang, 'mem_title') + '\n\n' +
    t(lang, 'mem_current', { rounds: '<b>' + p.rounds + '</b>', len: '<b>' + p.len + '</b>', total: p.rounds * p.len }) + '\n\n' +
    t(lang, 'mem_done', { name: '<b>' + memName(lang, id) + '</b>', desc: memDesc(lang, id) }) + '\n\n' +
    '· ' + t(lang, 'mem_custom') + '  <code>/mem ' + p.rounds + ' ' + p.len + '</code>';
  const kb = { inline_keyboard: [[{ text: '✅ ' + memName(lang, id), callback_data: 'mem:' + p.id }]] };
  let edited = false;
  if (msgId) edited = await editTg(env, chatId, msgId, newMsg, kb);
  if (!edited) await sendTg(env, chatId, newMsg, kb, true);
  return t(lang, 'sw_ok', { name: memName(lang, id) });
}

// ---------- 清空记忆 / 开新会话 ----------
// 从消息命令调用：直接删历史并确认；从记忆面板按钮调用：编辑面板显示已清空
async function clearHist(env, chatId, lang, msgId) {
  try {
    await env.ACCESS.delete('hist:' + chatId);
  } catch (e) {
    console.log('[clear-hist-err]', String(e.message || e));
  }
  const confirmText = t(lang, 'mem_cleared');
  if (msgId) {
    const mem = await getMem(env, chatId);
    const newMsg = t(lang, 'mem_title') + '\n\n' +
      t(lang, 'mem_current', { rounds: '<b>' + mem.rounds + '</b>', len: '<b>' + mem.len + '</b>', total: mem.rounds * mem.len }) + '\n\n' +
      t(lang, 'mem_cleared_panel');
    const kb = { inline_keyboard: [[{ text: t(lang, 'mem_btn_clear'), callback_data: 'mem:clear' }]] };
    const edited = await editTg(env, chatId, msgId, newMsg, kb);
    if (!edited) await sendTg(env, chatId, newMsg, kb, true);
  } else {
    await sendTg(env, chatId, confirmText);
  }
  return t(lang, 'mem_cleared_panel').split('!')[0];
}

// ---------- /mem 命令 ----------
async function handleMem(env, chatId, lang, text) {
  const arg = text.replace(/^\/mem\s*/, '').trim();
  if (!arg) {
    await showMemSettings(env, chatId, lang);
    return;
  }
  const parts = arg.split(/\s+/);
  const rounds = parseInt(parts[0], 10);
  const len = parseInt(parts[1], 10);
  if (!rounds || !len || rounds < 1 || rounds > 100 || len < 100 || len > 4000) {
    await sendTg(env, chatId, t(lang, 'mem_err_fmt'));
    return;
  }
  if (rounds * len > MEM_MAX_CHARS) {
    await sendTg(env, chatId, t(lang, 'mem_err_limit', { r: Math.floor(MEM_MAX_CHARS / len), len }));
    return;
  }
  await saveMem(env, chatId, { rounds, len });
  await sendTg(env, chatId, t(lang, 'mem_set_done', { rounds: '<b>' + rounds + '</b>', len: '<b>' + len + '</b>', total: rounds * len }));
}

const HIST_MAX = 200; // KV 存储上限（1轮=1问1答=2条；最大 100 轮×2=200 条正好）

async function readHist(env, chatId, rounds) {
  try {
    const raw = await env.ACCESS.get('hist:' + chatId);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) return arr.slice(-rounds * 2); // 按"轮"截取：1轮=最近2条
    }
  } catch (e) {
    console.log('[hist-read-err]', String(e.message || e));
  }
  return [];
}

async function saveHist(env, chatId, hist) {
  try {
    await env.ACCESS.put('hist:' + chatId, JSON.stringify(hist.slice(-HIST_MAX)));
  } catch (e) {
    console.log('[hist-write-err]', String(e.message || e));
  }
}

async function aiChat(env, chatId, lang, prompt) {
  // 用"正在输入…"状态提示，思考完直接发正文（只出现一条消息）
  await fetch(`https://api.telegram.org/bot${env.TG_BOT_TOKEN}/sendChatAction`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, action: 'typing' }),
  }).catch(() => {});

  const pref = await getPref(env, chatId);
  const apis = await getApis(env);
  await healPref(env, chatId, pref, apis); // 自愈：指向已删除 API 时切回 CF
  const mem = await getMem(env, chatId);
  const hist = await readHist(env, chatId, mem.rounds);

  const systemPrompt = SYSTEM_PROMPTS[lang] || SYSTEM_PROMPTS[DEFAULT_LANG];

  // 组装带历史的 messages（历史每条按个人设置截断，节省 tokens）
  const buildMessages = (userText) => [
    { role: 'system', content: systemPrompt },
    ...hist.map(h => ({ role: h.role === 'assistant' ? 'assistant' : 'user', content: String(h.content).slice(0, mem.len) })),
    { role: 'user', content: String(userText).slice(0, 2000) },
  ];

  // 记录一轮对话（成功回复后调用，存储按个人设置截断）
  const recordTurn = async (reply) => {
    await saveHist(env, chatId, hist.concat([
      { role: 'user', content: String(prompt).slice(0, mem.len) },
      { role: 'assistant', content: String(reply).slice(0, mem.len) },
    ]));
  };

  // 1) 自定义 API（仅当用户在模型选择里选了 API 模型且该 API 存在）
  let extFallbackNote = ''; // 自定义 API 全挂时，回退 CF 的提示
  if (pref.type === 'api' && pref.apiId) {
    const api = apis.find(a => a.id === pref.apiId);
    if (api) {
      const apiUrl = (api.url || '').replace(/\/+$/, '');
      const customModels = (api.model || '').split(',').map(s => s.trim()).filter(Boolean);
      // 把选中模型排到最前，失败后依次尝试其余
      let ordered = customModels.slice();
      if (pref.model) {
        const idx = ordered.indexOf(pref.model);
        if (idx > 0) ordered = ordered.slice(idx).concat(ordered.slice(0, idx));
      }
      for (const model of ordered) {
        try {
          const r = await fetch(apiUrl + '/chat/completions', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: 'Bearer ' + api.key,
            },
            body: JSON.stringify({ model, messages: buildMessages(prompt), max_tokens: 2000 }),
          });
          const data = await r.json();
          const reply = data?.choices?.[0]?.message?.content;
          if (reply) {
            await sendTg(env, chatId, '🤖 <b>' + model + '</b>\n\n' + escapeHtml(reply.slice(0, 4000)));
            await recordTurn(reply);
            return;
          }
          console.log('[ext-api-err]', model, r.status, JSON.stringify(data).slice(0, 300));
        } catch (e) {
          console.log('[ext-api-err]', model, String(e.message || e));
        }
      }
      // 自定义 API 全部失败 → 回退 Cloudflare 免费模型（附提示）
      extFallbackNote = t(lang, 'ai_fb_note', { name: escapeHtml(api.name) });
    }
  }

  // 2) Cloudflare Workers AI（免费额度，主用）
  // 优先选中模型，失败后按回退链依次尝试
  const cfOrder = [];
  if (pref.cfModel) {
    const cur = CF_MODELS.find(m => m.id === pref.cfModel);
    if (cur) cfOrder.push(cur.full);
  }
  for (const f of CF_FALLBACK) {
    if (!cfOrder.includes(f)) cfOrder.push(f);
  }
  for (const full of cfOrder) {
    try {
      const resp = await env.AI.run(full, { messages: buildMessages(prompt), max_tokens: 4096 });
      const reply =
        resp.response ||
        resp.choices?.[0]?.message?.content ||
        resp.choices?.[0]?.text ||
        resp.result?.response ||
        JSON.stringify(resp);
      const curM = CF_MODELS.find(m => m.full === full);
      const displayName = curM ? cfName(lang, curM.id) : full.split('/').pop();
      const note = extFallbackNote ? '\n\n' + extFallbackNote : '';
      await sendTg(env, chatId, '🤖 <b>' + displayName + '</b>\n\n' + escapeHtml(reply.slice(0, 4000)) + note);
      await recordTurn(reply);
      // 累计今日 AI Neurons 用量到 KV
      const neurons = resp.usage?.neurons || resp.usage?.total_neurons || 0;
      if (neurons > 0) {
        try {
          const today = new Date().toISOString().slice(0, 10);
          const key = 'ai_usage:' + today;
          const prev = parseFloat(await env.ACCESS.get(key)) || 0;
          await env.ACCESS.put(key, String(prev + neurons));
        } catch (e) {
          console.log('[ai-usage-write-err]', String(e.message || e));
        }
      }
      return;
    } catch (e) {
      console.log('[cf-ai-err]', full, String(e.message || e));
    }
  }
  await sendTg(env, chatId, t(lang, 'ai_fail'));
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
