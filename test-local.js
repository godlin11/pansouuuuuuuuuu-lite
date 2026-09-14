/**
 * 本地测试：解析器 + 插件 + 真实抓取
 * 运行：node test-local.js
 */
const { parseChannelPage, fetchChannel, DEFAULT_CHANNELS, PLUGINS } = require('./api/search');

// ---------- 用例 1：合成 HTML 解析 ----------
const sample = `
<div class="tgme_widget_message_wrap js-widget_message_wrap">
  <div class="tgme_widget_message text_not_supported_wrap js-widget_message" data-post="Quark_Movies/12345">
    <div class="tgme_widget_message_bubble">
      <div class="tgme_widget_message_text js-message_text before_footer" dir="auto">
        三体 电视剧 全30集 4K 高码率<br>
        链接：<a href="https://pan.quark.cn/s/a1b2c3d4e5f6">夸克网盘</a><br>
        备用：<a href="https://alipan.com/s/xyz789abc">阿里云盘</a><br>
        百度：<a href="https://pan.baidu.com/s/1abcDEF-ghi">百度网盘</a> 提取码: k9m2<br>
        磁力：magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567
      </div>
      <div class="tgme_widget_message_footer">
        <time datetime="2026-08-30T12:00:00+00:00">12:00</time>
      </div>
    </div>
  </div>
</div>
`;

console.log('=== 用例 1：TG 频道 HTML 解析 ===');
const parsed = parseChannelPage(sample, 'Quark_Movies');
console.log(`解析出 ${parsed.length} 条链接`);
const types = new Set(parsed.map(i => i.type));
const expectTypes = ['quark', 'aliyun', 'baidu', 'magnet'];
const passCase1 = expectTypes.every(t => types.has(t)) && parsed.some(i => i.code === 'k9m2');
console.log(passCase1 ? 'PASS' : 'FAIL（期望类型: ' + expectTypes.join(',') + '）');

// ---------- 用例 2：实体解码与去标签 ----------
console.log('\n=== 用例 2：HTML 实体解码 ===');
const entitySample = sample.replace('三体 电视剧', '三体&amp;衍生剧&lt;第一季&gt;');
const parsed2 = parseChannelPage(entitySample, 'Quark_Movies');
const titleOk = parsed2.length > 0 && parsed2[0].title.includes('&') && parsed2[0].title.includes('<');
console.log('标题:', parsed2[0] ? parsed2[0].title.slice(0, 40) : '(无)');
console.log(titleOk ? 'PASS' : 'FAIL');

// ---------- 用例 3：hunhepan 插件真实调用（国内站，本机可测） ----------
(async () => {
  console.log('\n=== 用例 3：hunhepan 插件真实调用（4 站 x 2 页并发）===');
  const plugin = PLUGINS.find(p => p.name === 'hunhepan');
  const t0 = Date.now();
  try {
    const items = await plugin.search('三体', 6000);
    console.log(`返回 ${items.length} 条，耗时 ${Date.now() - t0}ms`);
    if (items.length) {
      const byType = {};
      items.forEach(i => { byType[i.type] = (byType[i.type] || 0) + 1; });
      console.log('按类型分布:', JSON.stringify(byType));
      console.log('示例:', JSON.stringify(items[0]).slice(0, 300));
      console.log('PASS');
    } else {
      console.log('WARN（0 条：站点可能限流/改版，部署后以线上为准）');
    }
  } catch (e) {
    console.log('FAIL: ' + e.message);
  }

  // ---------- 用例 4：TG 频道真实抓取 ----------
  console.log('\n=== 用例 4：真实抓取 t.me（超时 6 秒）===');
  console.log('频道: ' + DEFAULT_CHANNELS[0] + '，关键词: 4K');
  try {
    const chItems = await fetchChannel(DEFAULT_CHANNELS[0], '4K', 6000);
    console.log(`真实抓取返回 ${chItems.length} 条链接`);
    console.log(chItems.length > 0 ? 'PASS（全链路通畅）' : 'WARN（0 条：本机网络访问 t.me 受限属预期；Vercel 海外函数不受影响，以线上为准）');
  } catch (e) {
    console.log('FAIL（本地网络无法访问 t.me: ' + e.message + '）');
  }
})();
