/**
 * hunhepan 插件 — 移植自 fish2018/pansou plugin/hunhepan
 * 一个插件覆盖 4 个聚合搜索站（共用同一套 JSON API 协议）：
 *   hunhepan.com / qkpanso.com / kuake8.com / misoso.cc
 *
 * ⚠️ 当前状态（2026-09-14 实测）：协议已漂移，暂不可用
 *   - hunhepan.com → {"code":0,"msg":"参数错误"}（请求体格式已改，前端 JS 中已无 search/disk 路径）
 *   - qkpanso.com  → {"code":422,"msg":"请求校验失败"}（增加了前端 token 校验）
 *   本插件保留作为框架示例；失败静默返回空数组，不影响 TG 频道主链路。
 *   恢复方法：用浏览器 DevTools 抓 hunhepan.com 搜索时的真实请求，更新下方 body/headers。
 *
 * 原协议（来自原版 Go 源码逆向，2025 版）：
 *   POST {api}  body: { page, q, user:"", exact:false, format:[], share_time:"", size:30, type:"", exclude_user:[], adv_params:{wechat_pwd:"",platform:"pc"} }
 *   resp: { code:200, data:{ list:[{ disk_name, disk_pass, disk_type, link, shared_time, files }] } }
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const ENDPOINTS = [
  { api: 'https://hunhepan.com/open/search/disk', referer: 'https://hunhepan.com/search' },
  { api: 'https://qkpanso.com/v1/search/disk', referer: 'https://qkpanso.com/search' },
  { api: 'https://kuake8.com/v1/search/disk', referer: 'https://kuake8.com/search' },
  { api: 'https://www.misoso.cc/v1/search/disk', referer: 'https://www.misoso.cc/search', origin: 'https://www.misoso.cc' }
];

const MAX_PAGES = 2;   // 每站抓前 2 页（原版 3 页；Serverless 预算内取 2 平衡速度）
const PAGE_SIZE = 30;

// 原版 convertDiskType 的映射，落回本项目的 type 命名
const DISK_TYPE_MAP = {
  BDY: 'baidu', ALY: 'aliyun', QUARK: 'quark', TIANYI: 'tianyi',
  UC: 'uc', CAIYUN: 'mobile', '115': 'u115', XUNLEI: 'xunlei',
  '123PAN': 'p123', PIKPAK: 'pikpak'
};

function cleanTitle(t) {
  return String(t || '')
    .replace(/<\/?(?:em|b|strong|i)>/g, '')
    .trim();
}

async function searchOne(ep, kw, page, timeoutMs) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(ep.api, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': UA,
        'accept': 'application/json, text/plain, */*',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'referer': ep.referer,
        ...(ep.origin ? { origin: ep.origin } : {})
      },
      body: JSON.stringify({
        page, q: kw, user: '', exact: false, format: [], share_time: '',
        size: PAGE_SIZE, type: '', exclude_user: [],
        adv_params: { wechat_pwd: '', platform: 'pc' }
      }),
      signal: ctl.signal
    });
    if (!res.ok) return [];
    const j = await res.json();
    if (!j || j.code !== 200 || !j.data || !Array.isArray(j.data.list)) return [];
    return j.data.list;
  } catch (e) {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {string} kw 关键词
 * @param {number} timeoutMs 单请求超时
 * @returns {Array<{type,name,url,code,title,channel,date,ts}>} 与 TG 频道结果同构
 */
async function search(kw, timeoutMs) {
  const jobs = [];
  for (const ep of ENDPOINTS) {
    for (let page = 1; page <= MAX_PAGES; page++) {
      jobs.push({ ep, page });
    }
  }
  const lists = await Promise.all(jobs.map(j => searchOne(j.ep, kw, j.page, timeoutMs)));

  const out = [];
  const seen = new Set();
  for (const list of lists) {
    for (const it of list) {
      if (!it || !it.link) continue;
      const key = it.disk_id || (it.link + '|' + it.disk_name);
      if (seen.has(key)) continue;
      seen.add(key);
      // shared_time 形如 "2025-07-07 13:19:48"（北京时间）
      const date = it.shared_time ? it.shared_time.replace(' ', 'T') + '+08:00' : '';
      out.push({
        type: DISK_TYPE_MAP[it.disk_type] || 'others',
        name: '',
        url: it.link,
        code: it.disk_pass || '',
        title: cleanTitle(it.disk_name) || it.link,
        channel: 'hunhepan',
        date,
        ts: date ? (Date.parse(date) || 0) : 0
      });
    }
  }
  return out;
}

module.exports = {
  name: 'hunhepan',
  label: '混搜盘(4站)',
  search
};
