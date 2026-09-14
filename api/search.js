/**
 * PanSou-Lite for Vercel
 * 网盘搜索聚合 API — 双数据源：
 *   1) Telegram 公开频道网页预览 (t.me/s/<channel>?q=关键词)，支持 110+ 频道
 *   2) 内置搜索插件（api/_lib/plugins/，移植自 fish2018/pansou 的插件生态）
 *
 * 架构要点（为 Vercel Serverless 设计）：
 *  - 无长驻进程：每次请求内完成全部抓取，总预算约 20 秒（maxDuration 30）
 *  - 并发窗口：频道按 30/波滚动执行，防止瞬时并发触发 t.me 限流
 *  - 无磁盘写入：缓存用模块级 Map（热实例复用）+ CDN s-maxage
 *  - 海外函数直连 t.me 与各资源站，无需代理
 *
 * 环境变量：
 *  - CHANNELS          可选，逗号分隔的 TG 频道列表（上限 150，默认内置 32 个）
 *  - ENABLED_PLUGINS   可选，逗号分隔的插件名（默认全部启用，当前: hunhepan）
 *  - SEARCH_PASSWORD   可选，设置后所有请求需带 header x-key 或 query ?key=
 *  - FETCH_TIMEOUT_MS  可选，单频道/单插件请求超时，默认 6000
 */

const PLUGINS = [
  require('./_lib/plugins/hunhepan')
];

const DEFAULT_CHANNELS = [
  'tgsearchers2', 'tgsearchers3', 'Aliyun_4K_Movies', 'yunpanx', 'yunpanxunlei',
  'bdwpzhpd', 'Q66Share', 'shareAliyun', 'Quark_Movies', 'xx123pan',
  'Baidu_netdisk', 'PanjClub', 'quark_res', 'yunpanquark', 'wp123zy',
  'yydf_hzl', 'leoziyuan', 'kkdj001', 'kuakedongman', 'zdqxm',
  'movielover8888_film3', 'ucwpzy', 'yingshifenxiang123', 'zyfb123', 'Lsp115',
  'taoxgzy', 'vip115hot', 'yunpan139', 'Channel_Shares_115', 'FLMdongtianfudi',
  'regengguangya', 'Netdisk_Movies'
];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// 网盘类型识别规则（TG 频道解析用，顺序即展示顺序）
const PAN_TYPES = [
  { type: 'quark',  name: '夸克网盘', re: /https?:\/\/pan\.quark\.cn\/s\/[0-9a-zA-Z]{6,}/g },
  { type: 'aliyun', name: '阿里云盘', re: /https?:\/\/(?:www\.)?(?:alipan\.com|aliyundrive\.com)\/s\/[0-9a-zA-Z]{6,}/g },
  { type: 'baidu',  name: '百度网盘', re: /https?:\/\/pan\.baidu\.com\/s\/[0-9a-zA-Z_-]{4,}(?:\?[^"\s<>]*)?/g },
  { type: 'xunlei', name: '迅雷云盘', re: /https?:\/\/pan\.xunlei\.com\/s\/[0-9a-zA-Z]{6,}/g },
  { type: 'u115',   name: '115网盘',  re: /https?:\/\/(?:115\.com|115cdn\.com|anxia\.com)\/s\/[0-9a-zA-Z]{6,}/g },
  { type: 'uc',     name: 'UC网盘',   re: /https?:\/\/drive\.uc\.cn\/s\/[0-9a-zA-Z]{6,}/g },
  { type: 'p123',   name: '123网盘',  re: /https?:\/\/(?:www\.)?123(?:pan|\d{3})\.(?:com|cn)\/s\/[0-9a-zA-Z_-]{6,}/g },
  { type: 'tianyi', name: '天翼云盘', re: /https?:\/\/cloud\.189\.cn\/(?:t|w)\/[0-9a-zA-Z]{6,}/g },
  { type: 'magnet', name: '磁力链接', re: /magnet:\?xt=urn:btih:[0-9a-zA-Z]{32,40}/g }
];

// 类型 → 展示名（供插件结果与前端补全颜色/名称用）
const TYPE_NAMES = {
  quark: '夸克网盘', aliyun: '阿里云盘', baidu: '百度网盘', xunlei: '迅雷云盘',
  u115: '115网盘', uc: 'UC网盘', p123: '123网盘', tianyi: '天翼云盘',
  magnet: '磁力链接', mobile: '移动云盘', pikpak: 'PikPak', others: '其他'
};

// ---------- 工具函数 ----------

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
}

function stripHtml(html) {
  return decodeEntities(
    html.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ')
  ).replace(/\s+/g, ' ').trim();
}

// 并发窗口：list 按 limit 一波波执行（防止瞬时高并发触发目标站限流）
async function mapLimit(list, limit, fn) {
  const ret = new Array(list.length);
  let i = 0;
  async function worker() {
    while (i < list.length) {
      const idx = i++;
      ret[idx] = await fn(list[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker));
  return ret;
}

// ---------- 解析 t.me/s/ 页面 ----------

function parseChannelPage(html, channel) {
  if (!html || html.indexOf('tgme_widget_message') === -1) return [];
  const chunks = html.split(/(?=<div class="tgme_widget_message_wrap)/);
  const out = [];
  for (const chunk of chunks) {
    const tm = chunk.match(/<time[^>]*datetime="([^"]+)"/);
    if (!tm) continue;
    const tx = chunk.match(/class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/);
    if (!tx) continue;

    const rawHtml = tx[1];
    const raw = decodeEntities(rawHtml);
    // 标题必须从原始 HTML 片段去标签（先去标签后解码各一次），
    // 若对已解码文本再走去标签，正文里合法的 "<xxx>" 字样会被误删
    const title = stripHtml(rawHtml).slice(0, 100);
    const date = tm[1];
    const ts = Date.parse(date) || 0;
    const cm = raw.match(/(?:提取码|访问码|密码|pwd)\s*[:：=]?\s*([0-9a-zA-Z]{4})(?![0-9a-zA-Z])/i);
    const code = cm ? cm[1] : '';

    for (const p of PAN_TYPES) {
      const re = new RegExp(p.re.source, 'g');
      let m;
      while ((m = re.exec(raw)) !== null) {
        out.push({
          type: p.type, name: p.name, url: m[0], code,
          title: title || m[0], channel, date, ts
        });
        if (p.type === 'magnet') break;
      }
    }
  }
  return out;
}

// ---------- 抓取 ----------

async function fetchChannel(channel, kw, timeoutMs) {
  const url = 'https://t.me/s/' + encodeURIComponent(channel) + '?q=' + encodeURIComponent(kw);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' },
      signal: ctl.signal
    });
    if (!res.ok) return [];
    const html = await res.text();
    return parseChannelPage(html, channel);
  } catch (e) {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// 频道阶段：并发窗口 30/波滚动，总预算 deadline 内尽量多查
async function fetchAllChannels(channels, kw, timeoutMs, deadline) {
  const all = [];
  let ok = 0;
  const WINDOW = 30;
  for (let i = 0; i < channels.length; i += WINDOW) {
    if (Date.now() > deadline) break; // 预算耗尽，剩余频道放弃（缓存下次补）
    const wave = channels.slice(i, i + WINDOW);
    const results = await Promise.all(wave.map(ch => fetchChannel(ch, kw, timeoutMs)));
    for (const r of results) {
      if (r.length > 0) { ok++; all.push(...r); }
    }
  }
  return { items: all, ok };
}

// 插件阶段：所有插件并行，单个插件内部自行并发
async function runPlugins(plugins, kw, timeoutMs) {
  const all = [];
  let ok = 0;
  const results = await Promise.allSettled(
    plugins.map(p => p.search(kw, timeoutMs).catch(() => []))
  );
  for (const r of results) {
    if (r.status === 'fulfilled' && Array.isArray(r.value) && r.value.length > 0) {
      ok++;
      all.push(...r.value);
    }
  }
  return { items: all, ok };
}

// ---------- 缓存（模块级，热实例间复用；冷启动自动重建） ----------

const CACHE = globalThis.__pansouLiteCache || (globalThis.__pansouLiteCache = new Map());
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 120;

function cacheGet(key) {
  const hit = CACHE.get(key);
  if (hit && Date.now() - hit.t < CACHE_TTL_MS) return hit.data;
  if (hit) CACHE.delete(key);
  return null;
}

function cacheSet(key, data) {
  CACHE.set(key, { t: Date.now(), data });
  if (CACHE.size > CACHE_MAX) {
    CACHE.delete(CACHE.keys().next().value);
  }
}

// ---------- HTTP 响应 ----------

function sendJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('access-control-allow-origin', '*');
  res.end(JSON.stringify(obj));
}

// ---------- Vercel Handler ----------

module.exports.default = async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'x-key');
    res.statusCode = 204;
    return res.end();
  }

  const kw = String((req.query && req.query.kw) || '').trim();
  if (!kw || kw.length > 100) {
    return sendJson(res, 400, { error: '缺少参数 kw（搜索关键词）' });
  }

  const pass = process.env.SEARCH_PASSWORD;
  if (pass) {
    const provided = req.headers['x-key'] || (req.query && req.query.key) || '';
    if (provided !== pass) {
      return sendJson(res, 401, { error: 'unauthorized' });
    }
  }

  const ck = kw.toLowerCase();
  const cached = cacheGet(ck);
  if (cached) {
    res.setHeader('cache-control', 's-maxage=300, stale-while-revalidate=600');
    return sendJson(res, 200, Object.assign({}, cached, { cached: true }));
  }

  const channels = (process.env.CHANNELS || DEFAULT_CHANNELS.join(','))
    .split(',').map(s => s.trim()).filter(Boolean).slice(0, 150);
  const timeoutMs = Math.min(Math.max(parseInt(process.env.FETCH_TIMEOUT_MS || '6000', 10), 2000), 12000);

  // 插件启用过滤
  const enabledRaw = process.env.ENABLED_PLUGINS;
  let plugins = PLUGINS;
  if (enabledRaw !== undefined) {
    const on = new Set(enabledRaw.split(',').map(s => s.trim()).filter(Boolean));
    plugins = PLUGINS.filter(p => on.has(p.name));
  }

  const t0 = Date.now();
  const deadline = t0 + 20000; // 总预算 20s（maxDuration 30 留余量）

  // 频道与插件两路并行
  const [chanPhase, plugPhase] = await Promise.all([
    fetchAllChannels(channels, kw, timeoutMs, deadline),
    plugins.length ? runPlugins(plugins, kw, timeoutMs) : Promise.resolve({ items: [], ok: 0 })
  ]);

  const all = [...chanPhase.items, ...plugPhase.items];

  // 去重：同一分享链接（去查询参数后）只保留最新一条
  all.sort((a, b) => b.ts - a.ts);
  const seen = new Set();
  const items = [];
  for (const it of all) {
    const base = it.url.split(/[?#]/)[0];
    const k = it.type + '|' + base;
    if (seen.has(k)) continue;
    seen.add(k);
    if (!it.name) it.name = TYPE_NAMES[it.type] || '其他';
    items.push(it);
    if (items.length >= 300) break;
  }

  const data = {
    kw,
    total: items.length,
    channels_ok: chanPhase.ok,
    channels_total: channels.length,
    plugins_ok: plugPhase.ok,
    plugins_total: plugins.length,
    took_ms: Date.now() - t0,
    items
  };

  cacheSet(ck, data);
  res.setHeader('cache-control', 's-maxage=300, stale-while-revalidate=600');
  return sendJson(res, 200, data);
};

// 供本地测试使用
module.exports.parseChannelPage = parseChannelPage;
module.exports.fetchChannel = fetchChannel;
module.exports.DEFAULT_CHANNELS = DEFAULT_CHANNELS;
module.exports.PLUGINS = PLUGINS;
