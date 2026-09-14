/**
 * 健康检查接口：GET /api/health
 * 返回服务状态、频道数、缓存条目数。
 */
const { DEFAULT_CHANNELS } = require('./search');

module.exports.default = async (req, res) => {
  const channels = (process.env.CHANNELS || DEFAULT_CHANNELS.join(','))
    .split(',').map(s => s.trim()).filter(Boolean);
  const cacheSize = globalThis.__pansouLiteCache ? globalThis.__pansouLiteCache.size : 0;
  res.statusCode = 200;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify({
    ok: true,
    service: 'pansou-lite',
    channels: channels.length,
    cache_entries: cacheSize,
    password_protected: Boolean(process.env.SEARCH_PASSWORD),
    ts: new Date().toISOString()
  }));
};
