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
      const role = await getRole(env, chatId);
      if (!role) {
        await sendTg(env, chatId, '🔒 请先输入邀请码激活后使用。');
        await answerCb(env, cb.id);
        return new Response('ok');
      }
      if (data === 'status') {
        await cfStatus(env, chatId);
      } else if (data === 'ai') {
        await sendTg(env, chatId, '🤖 直接输入你的问题即可对话（不用加 /ai）\n\n例如：帮我写一个 Python 排序函数');
      } else if (data === 'help') {
        await sendHelp(env, chatId);
      } else if (data === 'models') {
        await showModels(env, chatId);
      } else if (data === 'setapi') {
        await sendTg(env, chatId,
          '⚙️ <b>添加自定义 API</b>\n\n发送：\n<code>/setapi 地址 | 密钥 | 模型1,模型2 | 名称</code>\n\n' +
          '例如：\n<code>/setapi https://api.deepseek.com | sk-xxx | deepseek-chat | DeepSeek</code>\n\n' +
          '· 名称可省略（默认取域名）\n' +
          '· 添加的是<u>新增</u> API，不会覆盖已有配置\n' +
          '· 添加后在 🧠 模型选择 里点选即可使用\n' +
          '· 内置 lfree API 永久保留，不会被覆盖'
        );
      } else if (data === 'delapi') {
        await showDelApi(env, chatId);
      } else if (data === 'setkey') {
        await sendTg(env, chatId,
          '🔑 <b>修改 API Key</b>\n\n发送：\n<code>/setkey 名称 新密钥</code>\n\n' +
          '例如：\n<code>/setkey lfree sk-新的key</code>\n\n' +
          '· 名称可以是 lfree 或任意已添加的 API\n' +
          '· 修改后立即生效，无需重新部署'
        );
      } else if (data === 'mem') {
        await showMemSettings(env, chatId);
      } else if (data === 'mem:clear') {
        const confirm = await clearHist(env, chatId, cb.message.message_id);
        await answerCb(env, cb.id, confirm || undefined);
        return new Response('ok');
      } else if (data.startsWith('mem:')) {
        const confirm = await handleMemPick(env, chatId, data, cb.message.message_id);
        await answerCb(env, cb.id, confirm || undefined);
        return new Response('ok');
      } else if (data.startsWith('mc:')) {
        const confirm = await handleModelPick(env, chatId, data, cb.message.message_id);
        await answerCb(env, cb.id, confirm || undefined);
        return new Response('ok');
      } else if (data.startsWith('da:')) {
        await handleDelApiCb(env, chatId, data, cb.id);
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
          await sendHelp(env, chatId, '✅ 管理员邀请码验证成功，你已获得<u>管理员权限</u>！');
        } catch (e) {
          console.log('[access-put-err]', String(e.message || e));
          await sendTg(env, chatId, '❌ 激活失败，请稍后重试或联系管理员。');
        }
      } else if (codes.member && text === codes.member) {
        try {
          await env.ACCESS.put('chat:' + chatId, 'member');
          await sendHelp(env, chatId, '✅ 成员邀请码验证成功，你已获得<u>普通成员权限</u>！');
        } catch (e) {
          console.log('[access-put-err]', String(e.message || e));
          await sendTg(env, chatId, '❌ 激活失败，请稍后重试或联系管理员。');
        }
      } else {
        await sendTg(env, chatId,
          '🔒 本机器人需要邀请码才能使用。\n\n' +
          '请输入管理员或成员邀请码，验证通过后即可使用。\n' +
          '（普通成员可对话/查用量/选模型；管理员额外可管理 API）'
        );
      }
      return new Response('ok');
    }

    const isAdmin = role === 'admin';

    if (text === '/start' || text === '/help' || text === '❓ 帮助') {
      await sendHelp(env, chatId);
    } else if (text === '/status' || text === '📊 用量查询' || text === '📊 查看用量') {
      await cfStatus(env, chatId);
    } else if (text === '🤖 AI 对话') {
      await sendTg(env, chatId, '🤖 直接输入你的问题即可对话（不用加 /ai）\n\n例如：帮我写一个 Python 排序函数');
    } else if (text === '🧠 模型选择') {
      await showModels(env, chatId);
    } else if (text === '⚙️ 设置API' || text === '⚙️ 添加API') {
      await sendTg(env, chatId,
        '⚙️ <b>添加自定义 API</b>\n\n发送：\n<code>/setapi 地址 | 密钥 | 模型1,模型2 | 名称</code>\n\n' +
        '例如：\n<code>/setapi https://api.deepseek.com | sk-xxx | deepseek-chat | DeepSeek</code>\n\n' +
        '· 名称可省略（默认取域名）\n' +
        '· 添加的是<u>新增</u> API，不会覆盖已有配置\n' +
        '· 添加后在 🧠 模型选择 里点选即可使用'
      );
    } else if (text === '🗑️ 删除API') {
      await showDelApi(env, chatId);
    } else if (text === '🔑 修改Key') {
      await sendTg(env, chatId,
        '🔑 <b>修改 API Key</b>\n\n发送：\n<code>/setkey 名称 新密钥</code>\n\n' +
        '例如：\n<code>/setkey lfree sk-新的key</code>\n\n' +
        '· 名称可以是 lfree 或任意已添加的 API\n' +
        '· 修改后立即生效，无需重新部署'
      );
    } else if (text === '🧠 记忆设置') {
      await showMemSettings(env, chatId);
    } else if (text === '🆕 新会话' || text === '/new' || text === '/clear' || text === '/reset') {
      await clearHist(env, chatId);
    } else if (text.startsWith('/mem')) {
      await handleMem(env, chatId, text);
    } else if (text.startsWith('/setkey')) {
      if (!isAdmin) { await sendTg(env, chatId, '🔒 只有管理员可以修改 Key。'); return new Response('ok'); }
      await handleSetKey(env, chatId, text);
    } else if (text.startsWith('/setcode')) {
      if (!isAdmin) { await sendTg(env, chatId, '🔒 只有管理员可以设置邀请码。'); return new Response('ok'); }
      await handleSetCode(env, chatId, text);
    } else if (text.startsWith('/setapi')) {
      if (!isAdmin) { await sendTg(env, chatId, '🔒 只有管理员可以配置 API。'); return new Response('ok'); }
      await handleSetApi(env, chatId, text);
    } else if (text.startsWith('/delapi')) {
      if (!isAdmin) { await sendTg(env, chatId, '🔒 只有管理员可以删除 API。'); return new Response('ok'); }
      await handleDelApi(env, chatId, text);
    } else if (text === '/ai') {
      await sendTg(env, chatId, '🤖 直接输入你的问题即可对话（不用加 /ai）\n\n例如：帮我写一个 Python 排序函数');
    } else if (text.startsWith('/ai ')) {
      await aiChat(env, chatId, text.slice(4));
    } else if (text.startsWith('/ai\n')) {
      await aiChat(env, chatId, text.slice(4));
    } else if (text.startsWith('/')) {
      await sendTg(env, chatId, '❓ 未识别的命令。试试：/status、/setapi、/delapi 或直接输入文字对话');
    } else {
      // 默认模式：任何普通文字都走 AI 对话
      await aiChat(env, chatId, text);
    }

    return new Response('ok');
  },

};

// ============================================================
// 模型体系：Cloudflare 免费（永久）+ API 注册表（内置永久 + 临时可删）
// ============================================================

// Cloudflare 免费模型（短码 id + 完整绑定名 + 优缺点说明）
const CF_MODELS = [
  { id: 'qwen3', full: '@cf/qwen/qwen3-30b-a3b-fp8', name: '通义 Qwen3-30B', pros: '中文理解最好，回答自然，综合均衡', cons: '创意发挥略保守' },
  { id: 'gpt120b', full: '@cf/openai/gpt-oss-120b', name: 'GPT-OSS-120B', pros: '英文/代码能力强，逻辑严谨', cons: '中文略生硬，较耗额度' },
  { id: 'llama70b', full: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', name: 'Llama 3.3 70B', pros: '综合均衡，响应快', cons: '中文表现一般' },
  { id: 'mistral24b', full: '@cf/mistralai/mistral-small-3.1-24b-instruct', name: 'Mistral Small 24B', pros: '轻快省额度，多语言', cons: '复杂深度任务一般' },
  { id: 'llama8b', full: '@cf/meta/llama-3.1-8b-instruct-fp8', name: 'Llama 3.1 8B', pros: '最省额度，秒回', cons: '能力最弱，适合闲聊' },
];
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
function describeCurrent(pref, apis) {
  if (pref.type === 'api') {
    const api = apis.find(a => a.id === pref.apiId);
    const src = api ? api.name : '未知API';
    return '<b>' + escapeHtml(pref.model || '自定义模型') + '</b>（' + escapeHtml(src) + '）';
  }
  const m = CF_MODELS.find(x => x.id === pref.cfModel) || CF_MODELS[0];
  return '<b>' + m.name + '</b>（Cloudflare 免费）';
}

// ---------- 模型选择面板：消息与按钮 ----------
function buildModelsMsg(pref, apis) {
  let msg = '🧠 <b>模型选择</b>\n\n';
  msg += '当前：' + describeCurrent(pref, apis) + '\n\n';
  msg += '图例：<code>☁️ CF</code> = Cloudflare 免费　<code>🔑 lfree</code> = 内置永久　<code>📦 名称</code> = 临时 API\n\n';

  // CF 免费模型（永久）
  msg += '📋 <b>☁️ Cloudflare 免费模型（永久）</b>：\n';
  for (const m of CF_MODELS) {
    const mark = pref.type === 'cf' && pref.cfModel === m.id ? '✅ ' : '⚪ ';
    msg += mark + '<b>' + m.name + '</b>\n　👍 ' + m.pros + '\n　👎 ' + m.cons + '\n';
  }

  // API 模型
  for (const api of apis) {
    const customModels = (api.model || '').split(',').map(s => s.trim()).filter(Boolean);
    if (customModels.length === 0) continue;
    const tag = api.builtin ? '🔑' : '📦';
    msg += '\n📋 <b>' + tag + ' ' + escapeHtml(api.name) + (api.builtin ? '（永久保留）' : '（临时）') + '</b>：\n';
    for (const m of customModels) {
      const mark = pref.type === 'api' && pref.apiId === api.id && pref.model === m ? '✅ ' : '⚪ ';
      msg += mark + '<b>' + escapeHtml(m) + '</b>\n';
    }
  }

  if (apis.length === 0) {
    msg += '\n（暂无自定义 API，可用 <code>/setapi 地址 | 密钥 | 模型</code> 添加）';
  }
  return msg;
}

function buildModelsKb(pref, apis) {
  const rows = [];
  // CF 免费模型：☁️ 前缀
  for (let i = 0; i < CF_MODELS.length; i += 2) {
    rows.push(CF_MODELS.slice(i, i + 2).map(m => ({
      text: (pref.type === 'cf' && pref.cfModel === m.id ? '✅ ' : '') + '☁️ ' + m.name,
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
  const bottom = [{ text: '⚙️ 添加 API', callback_data: 'setapi' }];
  const hasTmp = apis.some(a => !a.builtin);
  if (hasTmp) bottom.push({ text: '🗑️ 删除临时 API', callback_data: 'delapi' });
  rows.push(bottom);
  return rows;
}

async function showModels(env, chatId) {
  const pref = await getPref(env, chatId);
  const apis = await getApis(env);
  await healPref(env, chatId, pref, apis); // 自愈：指向已删除 API 时切回 CF
  await sendTg(env, chatId, buildModelsMsg(pref, apis), { inline_keyboard: buildModelsKb(pref, apis) }, true);
}

// ---------- 处理模型选择回调 ----------
// 返回确认文案（供 answerCallbackQuery toast 显示）
async function handleModelPick(env, chatId, data, msgId) {
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
      confirm = '✅ 已切换：' + m.name;
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
      confirm = '✅ 已切换：' + m;
    } else {
      return '';
    }
    await savePref(env, chatId, pref);
    // 刷新面板：优先编辑原消息（带最新 ✅ 标记），失败则补发新面板
    const newMsg = buildModelsMsg(pref, apis);
    const newKb = { inline_keyboard: buildModelsKb(pref, apis) };
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
    return '❌ 切换失败';
  }
}

// ---------- 删除临时 API 面板 ----------
async function showDelApi(env, chatId) {
  const apis = await getApis(env);
  const tmp = apis.filter(a => !a.builtin);
  let msg = '🗑️ <b>删除临时 API</b>\n\n';
  if (tmp.length === 0) {
    msg += '当前没有临时 API 可删除。\n内置 <b>lfree</b> 永久保留，不会出现在这里。';
    await sendTg(env, chatId, msg);
    return;
  }
  msg += '内置 API 永久保留，以下为临时 API，点按钮删除，或发送 <code>/delapi 名称</code>：\n\n';
  const rows = [];
  for (const a of tmp) {
    const models = (a.model || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 3).join(', ');
    msg += '· <b>' + escapeHtml(a.name) + '</b>：' + escapeHtml(models) + '\n';
    rows.push([{ text: '🗑️ 删除 ' + a.name, callback_data: 'da:' + a.id }]);
  }
  await sendTg(env, chatId, msg, { inline_keyboard: rows }, true);
}

// ---------- 处理删除回调 ----------
async function handleDelApiCb(env, chatId, data, cbId) {
  try {
    const isAdmin = (await getRole(env, chatId)) === 'admin';
    if (!isAdmin) {
      await sendTg(env, chatId, '🔒 只有管理员可以删除 API。');
      return;
    }
    const apiId = data.slice(3);
    const apis = await getApis(env);
    const api = apis.find(a => a.id === apiId);
    if (!api) {
      await sendTg(env, chatId, '❌ 未找到该 API。');
      return;
    }
    if (api.builtin) {
      await sendTg(env, chatId, '🔒 内置 API（' + escapeHtml(api.name) + '）永久保留，不可删除。');
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
    await sendTg(env, chatId, '🗑️ 已删除临时 API：<b>' + escapeHtml(api.name) + '</b>');
  } catch (e) {
    console.log('[delapi-cb-err]', String(e.message || e));
    await sendTg(env, chatId, '❌ 删除失败：' + escapeHtml(String(e.message || e)));
  }
}

// ---------- /setapi 添加 API ----------
async function handleSetApi(env, chatId, text) {
  try {
    const arg = text.replace(/^\/setapi\s*/, '').trim();
    if (!arg) {
      await sendTg(env, chatId,
        '⚙️ <b>添加自定义 API</b>\n\n发送：\n<code>/setapi 地址 | 密钥 | 模型1,模型2 | 名称</code>\n\n' +
        '· 名称可省略（默认取域名）\n' +
        '· 添加的是<u>新增</u> API，不会覆盖已有配置\n' +
        '· <code>/delapi 名称</code> 可删除临时 API'
      );
      return;
    }
    const parts = arg.split('|').map(s => s.trim());
    if (parts.length < 3) {
      await sendTg(env, chatId, '❌ 格式不对，请用 <code>|</code> 分隔：\n<code>/setapi 地址 | 密钥 | 模型1,模型2 | 名称</code>');
      return;
    }
    const url = parts[0];
    const key = parts[1];
    const model = parts[2];
    const name = parts[3] || (url.replace(/^https?:\/\//, '').split('/')[0] || 'api');
    if (!url || !key || !model) {
      await sendTg(env, chatId, '❌ 地址/密钥/模型不能为空');
      return;
    }
    if (!/^https?:\/\//i.test(url)) {
      await sendTg(env, chatId, '❌ 地址必须以 http:// 或 https:// 开头：\n<code>' + escapeHtml(url) + '</code>');
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
      '✅ 已添加 API：<b>' + escapeHtml(finalName) + '</b>' +
      (firstModel ? '，并已自动设为主模型：<b>' + escapeHtml(firstModel) + '</b>' : '') + '\n\n' +
      '· 模型：' + escapeHtml(model) + '\n' +
      '· 已有配置（lfree 等）完全不受影响\n\n' +
      '也可随时点 <b>🧠 模型选择</b> 按钮切换'
    );
  } catch (e) {
    console.log('[setapi-err]', String(e.message || e));
    await sendTg(env, chatId, '❌ 保存失败：' + escapeHtml(String(e.message || e)));
  }
}

// ---------- /setkey 修改 API Key ----------
async function handleSetKey(env, chatId, text) {
  try {
    const arg = text.replace(/^\/setkey\s*/, '').trim();
    const parts = arg.split(/\s+/);
    if (!arg || parts.length < 2) {
      await sendTg(env, chatId,
        '🔑 <b>修改 API Key</b>\n\n发送：\n<code>/setkey 名称 新密钥</code>\n\n' +
        '例如：<code>/setkey lfree sk-新的key</code>'
      );
      return;
    }
    const name = parts[0];
    const newKey = parts.slice(1).join('');
    if (newKey.length < 10) {
      await sendTg(env, chatId, '❌ 密钥太短，请检查是否完整复制。');
      return;
    }
    const apis = await getApis(env);
    const target = apis.find(a => a.name === name) || apis.find(a => a.id === name);
    if (!target) {
      await sendTg(env, chatId, '❌ 未找到名为 <b>' + escapeHtml(name) + '</b> 的 API。可发送 /delapi 查看列表');
      return;
    }
    target.key = newKey;
    await saveApis(env, apis);
    await sendTg(env, chatId,
      '✅ 已更新 <b>' + escapeHtml(target.name) + '</b> 的 Key\n\n' +
      '· 新 Key 尾四位：<code>' + escapeHtml(newKey.slice(-4)) + '</code>\n' +
      '· 修改已生效，直接对话即可使用'
    );
  } catch (e) {
    console.log('[setkey-err]', String(e.message || e));
    await sendTg(env, chatId, '❌ 修改失败：' + escapeHtml(String(e.message || e)));
  }
}

// ---------- /delapi 命令 ----------
async function handleDelApi(env, chatId, text) {
  try {
    const arg = text.replace(/^\/delapi\s*/, '').trim();
    if (!arg) {
      await showDelApi(env, chatId);
      return;
    }
    const apis = await getApis(env);
    const target = apis.find(a => a.name === arg) || apis.find(a => a.id === arg);
    if (!target) {
      await sendTg(env, chatId, '❌ 未找到名为 <b>' + escapeHtml(arg) + '</b> 的 API。可用 /delapi 查看列表');
      return;
    }
    if (target.builtin) {
      await sendTg(env, chatId, '🔒 内置 API（' + escapeHtml(target.name) + '）永久保留，不可删除。');
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
    await sendTg(env, chatId, '🗑️ 已删除临时 API：<b>' + escapeHtml(target.name) + '</b>');
  } catch (e) {
    console.log('[delapi-err]', String(e.message || e));
    await sendTg(env, chatId, '❌ 删除失败：' + escapeHtml(String(e.message || e)));
  }
}

// ============================================================
// 访问控制 / 帮助 / 键盘
// ============================================================

// ---------- 角色获取 ----------
// 返回 'admin' | 'member' | null
// 超级管理员（TG_CHAT_ID）永远是 admin；KV 记录值：
//   'admin' → 管理员；'member' → 普通成员；旧版数字时间戳 → 视为 admin（原来用管理员邀请码激活）
async function getRole(env, chatId) {
  const isBoss = env.TG_CHAT_ID && String(chatId) === String(env.TG_CHAT_ID);
  if (isBoss) return 'admin';
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
async function handleSetCode(env, chatId, text) {
  try {
    const arg = text.replace(/^\/setcode\s*/, '').trim();
    const parts = arg.split(/\s+/);
    if (!arg || parts.length < 2) {
      await sendTg(env, chatId,
        '🔐 <b>设置邀请码</b>\n\n发送：\n<code>/setcode 新管理员码 新成员码</code>\n\n' +
        '例如：\n<code>/setcode admin2026 member2026</code>\n\n' +
        '· 两个码都要填，长度至少 6 位\n' +
        '· 设置后立即生效，旧码作废\n' +
        '· 已激活的用户不受影响'
      );
      return;
    }
    const admin = parts[0];
    const member = parts[1];
    if (admin.length < 6 || member.length < 6) {
      await sendTg(env, chatId, '❌ 邀请码长度至少 6 位');
      return;
    }
    if (admin === member) {
      await sendTg(env, chatId, '❌ 管理员码和成员码不能相同');
      return;
    }
    await env.ACCESS.put('cfg:codes', JSON.stringify({ admin, member }));
    await sendTg(env, chatId,
      '✅ 邀请码已更新，立即生效：\n\n' +
      '· 管理员码：<code>' + escapeHtml(admin) + '</code>\n' +
      '· 成员码：<code>' + escapeHtml(member) + '</code>'
    );
  } catch (e) {
    console.log('[setcode-err]', String(e.message || e));
    await sendTg(env, chatId, '❌ 设置失败：' + escapeHtml(String(e.message || e)));
  }
}

// ---------- 帮助（带按钮） ----------
async function sendHelp(env, chatId, extra) {
  const helpText =
    '🤖 <b>CF 监控 + AI 机器人</b>\n\n' +
    (extra ? extra + '\n\n' : '') +
    '直接输入文字 = AI 对话（不用加命令）\n' +
    '命令：\n' +
    '· <code>/status</code> — 查询用量\n' +
    '· <code>/setapi</code> — 添加自定义 API（不覆盖已有）\n' +
    '· <code>/delapi</code> — 删除临时 API\n' +
    '· <code>/setkey</code> — 修改任意 API 的 Key\n' +
    '· <code>/setcode</code> — 设置两级邀请码（仅管理员）\n' +
    '· <code>/mem</code> — 设置记忆深度（轮数/每条字数）\n' +
    '· <code>/new</code> — 清空记忆，开新会话\n' +
    '· <code>/help</code> — 显示本菜单\n\n' +
    '底部快捷按钮随时可用👇';
  await sendTg(env, chatId, helpText, null);
}

// ---------- 常驻快捷键盘 ----------
function replyKb() {
  return {
    keyboard: [
      [{ text: '📊 用量查询' }, { text: '🤖 AI 对话' }, { text: '🧠 模型选择' }],
      [{ text: '🧠 记忆设置' }, { text: '🆕 新会话' }],
      [{ text: '⚙️ 添加API' }, { text: '🗑️ 删除API' }, { text: '🔑 修改Key' }],
      [{ text: '❓ 帮助' }],
    ],
    resize_keyboard: true,
    one_time_keyboard: false,
  };
}

// ---------- Telegram 发送消息（默认带常驻快捷键盘） ----------
async function sendTg(env, chatId, text, inlineKb, noReplyKb) {
  const body = { chat_id: chatId, text, parse_mode: 'HTML' };
  if (inlineKb) body.reply_markup = JSON.stringify(inlineKb);
  else if (!noReplyKb) body.reply_markup = JSON.stringify(replyKb());
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

async function cfStatus(env, chatId) {
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
    const curModel = describeCurrent(pref, apis);

    let msg = '📊 <b>CF 用量</b>（今日，00:00 UTC 重置）\n\n';
    msg += '⚙️ <b>Workers 请求</b>\n';
    msg += '已用：<b>' + totalReq.toLocaleString() + '</b> / ' + WRK_DAILY_LIMIT.toLocaleString() + '\n';
    msg += '剩余：' + Math.max(0, WRK_DAILY_LIMIT - totalReq).toLocaleString() + '\n';
    msg += '子请求：' + totalSub.toLocaleString() + '\n\n';
    msg += '🧠 <b>AI 用量（本 Bot）</b>\n';
    msg += '已用：<b>' + aiUsed.toFixed(1) + '</b> / ' + AI_DAILY_LIMIT.toLocaleString() + ' Neurons\n';
    msg += '剩余：' + Math.max(0, AI_DAILY_LIMIT - aiUsed).toFixed(1) + ' Neurons\n\n';
    msg += '🎯 当前主模型：' + curModel;
    await sendTg(env, chatId, msg);
  } catch (e) {
    await sendTg(env, chatId, '❌ 出错：' + escapeHtml(String(e.message || e)));
  }
}

// ============================================================
// AI 对话（主用 Cloudflare 免费模型，自定义 API 可选，带多轮记忆）
// ============================================================

const SYSTEM_PROMPT = '你是一个乐于助人的中文AI助手，请用简洁清晰、自然连贯的中文回答用户问题。';

// ---------- 记忆深度设置（每人独立，KV cfg:mem:<chatId>） ----------
// 档位：从少到多，只受模型上下文能力约束（上限约 12 万字符 ≈ 128K tokens）
const MEM_PRESETS = [
  { id: 'light', name: '浅记忆', rounds: 1, len: 400, desc: '1轮·每条400字，最省' },
  { id: 'std', name: '标准', rounds: 5, len: 1000, desc: '5轮·每条1000字，均衡' },
  { id: 'mid', name: '中等', rounds: 10, len: 1500, desc: '10轮·每条1500字' },
  { id: 'deep', name: '深度', rounds: 20, len: 2000, desc: '20轮·每条2000字' },
  { id: 'max', name: '极深', rounds: 40, len: 3000, desc: '40轮·每条3000字，拉满' },
];
const MEM_MAX_CHARS = 120000; // 总字符上限（模型窗口保护）

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
async function showMemSettings(env, chatId) {
  const mem = await getMem(env, chatId);
  let msg = '🧠 <b>记忆深度设置</b>\n\n';
  msg += '当前：<b>' + mem.rounds + ' 轮</b> × 每条 <b>' + mem.len + ' 字</b>（共约 ' + (mem.rounds * mem.len) + ' 字）\n\n';
  msg += '档位从少到多，额度不设限，只受模型能力约束（上限约 12 万字符）\n\n';
  for (const p of MEM_PRESETS) {
    const mark = mem.rounds === p.rounds && mem.len === p.len ? '✅ ' : '⚪ ';
    msg += mark + '<b>' + p.name + '</b> — ' + p.desc + '\n';
  }
  msg += '\n自定义：发送 <code>/mem 轮数 每条字数</code>\n如 <code>/mem 30 2500</code>';
  const rows = [];
  for (let i = 0; i < MEM_PRESETS.length; i += 2) {
    rows.push(MEM_PRESETS.slice(i, i + 2).map(p => ({
      text: (mem.rounds === p.rounds && mem.len === p.len ? '✅ ' : '') + p.name,
      callback_data: 'mem:' + p.id,
    })));
  }
  rows.push([{ text: '🆕 清空记忆·开新会话', callback_data: 'mem:clear' }]);
  await sendTg(env, chatId, msg, { inline_keyboard: rows }, true);
}

// ---------- 记忆档位回调 ----------
async function handleMemPick(env, chatId, data, msgId) {
  const id = data.split(':')[1];
  const p = MEM_PRESETS.find(x => x.id === id);
  if (!p) return '';
  await saveMem(env, chatId, { rounds: p.rounds, len: p.len });
  const newMsg = '🧠 <b>记忆深度设置</b>\n\n' +
    '当前：<b>' + p.rounds + ' 轮</b> × 每条 <b>' + p.len + ' 字</b>\n\n' +
    '✅ 已切换为 <b>' + p.name + '</b>：' + p.desc + '\n\n' +
    '· 新对话立即生效，AI 将记住最近 ' + p.rounds + ' 轮问答\n' +
    '· 自定义：/mem 轮数 每条字数';
  const kb = { inline_keyboard: [[{ text: '✅ ' + p.name, callback_data: 'mem:' + p.id }]] };
  let edited = false;
  if (msgId) edited = await editTg(env, chatId, msgId, newMsg, kb);
  if (!edited) await sendTg(env, chatId, newMsg, kb, true);
  return '✅ 已切换：' + p.name;
}

// ---------- 清空记忆 / 开新会话 ----------
// 从消息命令调用：直接删历史并确认；从记忆面板按钮调用：编辑面板显示已清空
async function clearHist(env, chatId, msgId) {
  try {
    await env.ACCESS.delete('hist:' + chatId);
  } catch (e) {
    console.log('[clear-hist-err]', String(e.message || e));
  }
  const confirmText = '🆕 已清空记忆，开启新会话！\n\nAI 将不记得之前的对话。';
  if (msgId) {
    const mem = await getMem(env, chatId);
    const newMsg = '🧠 <b>记忆深度设置</b>\n\n' +
      '当前：<b>' + mem.rounds + ' 轮</b> × 每条 <b>' + mem.len + ' 字</b>\n\n' +
      '🆕 已清空记忆，开启新会话！';
    const kb = { inline_keyboard: [[{ text: '🆕 清空记忆·新会话', callback_data: 'mem:clear' }]] };
    const edited = await editTg(env, chatId, msgId, newMsg, kb);
    if (!edited) await sendTg(env, chatId, newMsg, kb, true);
  } else {
    await sendTg(env, chatId, confirmText);
  }
  return '🆕 已清空记忆';
}

// ---------- /mem 命令 ----------
async function handleMem(env, chatId, text) {
  const arg = text.replace(/^\/mem\s*/, '').trim();
  if (!arg) {
    await showMemSettings(env, chatId);
    return;
  }
  const parts = arg.split(/\s+/);
  const rounds = parseInt(parts[0], 10);
  const len = parseInt(parts[1], 10);
  if (!rounds || !len || rounds < 1 || rounds > 100 || len < 100 || len > 4000) {
    await sendTg(env, chatId, '❌ 格式：<code>/mem 轮数 每条字数</code>\n轮数 1~100，每条字数 100~4000\n如 <code>/mem 30 2500</code>');
    return;
  }
  if (rounds * len > MEM_MAX_CHARS) {
    await sendTg(env, chatId, '❌ 超出模型窗口上限（约 12 万字符）。可减少轮数或每条字数，如 <code>/mem ' + Math.floor(MEM_MAX_CHARS / len) + ' ' + len + '</code>');
    return;
  }
  await saveMem(env, chatId, { rounds, len });
  await sendTg(env, chatId, '✅ 记忆已设置为：<b>' + rounds + ' 轮</b> × 每条 <b>' + len + ' 字</b>（共约 ' + (rounds * len) + ' 字）\n\n新对话立即生效');
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

async function aiChat(env, chatId, prompt) {
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

  // 组装带历史的 messages（历史每条按个人设置截断，节省 tokens）
  const buildMessages = (userText) => [
    { role: 'system', content: SYSTEM_PROMPT },
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
      extFallbackNote = '⚠️ ' + escapeHtml(api.name) + ' 所有模型调用失败，已临时使用 CF 免费模型回复。';
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
      const displayName = curM ? curM.name : full.split('/').pop();
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
  await sendTg(env, chatId, '❌ AI 调用失败，请检查 Workers AI 绑定或额度。');
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}
