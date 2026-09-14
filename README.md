# 盘搜 Lite（PanSou-Lite for Vercel）

一个专为 **Vercel Serverless** 设计的网盘资源搜索聚合站。灵感来自 fish2018/pansou，
但架构完全重写，以适配 Serverless 的限制：无长驻进程、无磁盘写入、按请求执行。

数据源为 **Telegram 公开频道的网页预览版**（`t.me/s/<频道>?q=关键词`）——
Vercel 函数运行在海外，天然直连 Telegram，无需任何代理。

## 功能

- 双数据源：TG 公开频道（内置 32 个，`CHANNELS` 可扩到 150 个）+ 搜索插件
- 内置插件系统（`api/_lib/plugins/`），并发窗口限流，与频道搜索并行执行
- 识别 11 类网盘链接：夸克 / 阿里云盘 / 百度网盘 / 迅雷 / 115 / UC / 123 / 天翼 / 移动 / PikPak / 磁力
- 自动提取"提取码 / 密码"，随链接一起返回
- 结果去重、按时间倒序、按网盘类型分组展示
- 两级缓存：函数内内存缓存（10 分钟，热实例复用）+ CDN 边缘缓存（s-maxage=300）
- 可选访问密码门（防止公网被扫白嫖）
- 前端零依赖原生 HTML/JS，移动端适配，无任何构建步骤

## 项目结构

```
pansou-vercel/
├── api/
│   ├── search.js      搜索聚合接口（核心）
│   └── health.js      健康检查接口
├── public/
│   └── index.html     前端界面（静态，自动部署到根路径）
├── vercel.json        区域（hkg1）与函数超时配置
├── package.json       零依赖
└── README.md
```

## 部署到 Vercel（两种方式）

### 方式一：GitHub 导入（推荐）

1. 把本目录推到你的 GitHub 仓库
2. 打开 https://vercel.com/new ，选择该仓库导入
3. 其他保持默认，直接 Deploy
4. 完成后得到 `https://<你的项目>.vercel.app`，手机、外网直接访问

### 方式二：Vercel CLI

```bash
cd pansou-vercel
npx vercel login
npx vercel --prod
```

## 环境变量（均在 Vercel 项目 Settings → Environment Variables 配置）

| 变量 | 必填 | 说明 |
|---|---|---|
| `CHANNELS` | 否 | 逗号分隔的 TG 频道名列表，覆盖默认 32 个。上限 150 个（110 频道现成清单见 `channels-110.txt`） |
| `ENABLED_PLUGINS` | 否 | 逗号分隔的插件名，如 `hunhepan`。**不设 = 启用全部内置插件**；设为空串 = 禁用所有插件 |
| `SEARCH_PASSWORD` | 否 | 设置后全站需密码。前端会弹出密码输入框；API 需带 `x-key` 头或 `?key=` 参数 |
| `FETCH_TIMEOUT_MS` | 否 | 单频道/单插件请求超时（毫秒），默认 6000，范围 2000–12000 |
| `MAX_RESULTS` | 否 | 去重后返回条数上限，默认 1000，范围 100–2000。设大上限可拿到更多结果，但受单次请求 25 秒预算约束 |

**强烈建议线上设置 `SEARCH_PASSWORD`**，否则任何人扫到你的域名都能消耗你的函数调用额度。

### 使用 110 个频道（原版 PanSou 全量清单）

Vercel 项目环境变量里新增 `CHANNELS`，值用 `channels-110.txt` 的内容整个粘贴（108 个，
原清单中 2 个成人频道已移除）。注意：

- 108 个频道按 30/波滚动并发，首次搜索约 8~15 秒，之后命中缓存毫秒级返回
- 频道越多首次搜索越慢、函数负载越大；60~110 个之间是体验与覆盖的平衡点
- 请求总预算 20 秒，超时波次自动放弃（下次搜索命中缓存后继续补齐）

## API

### GET /api/search?kw=关键词

```json
{
  "kw": "三体",
  "total": 42,
  "channels_ok": 28,
  "channels_total": 32,
  "took_ms": 3512,
  "items": [
    {
      "type": "quark",
      "name": "夸克网盘",
      "url": "https://pan.quark.cn/s/xxxxxxxx",
      "code": "",
      "title": "三体 全季 4K 内封中字",
      "channel": "Quark_Movies",
      "date": "2026-08-30T12:00:00+00:00",
      "ts": 1787068800000
    }
  ]
}
```

开启密码后需带 `x-key: <密码>` 请求头。

### GET /api/health

返回服务状态、频道数、缓存条目数、是否开启密码。

## 与原版 PanSou 的差异（为什么这样改）

| 原版 PanSou（Docker 常驻） | 本项目（Vercel Serverless） |
|---|---|
| Go 常驻进程，goroutine 工作池 | 每请求内 Promise.allSettled 并发，超时预算 6 秒/频道 |
| 磁盘持久化缓存 /app/cache | 内存 Map（热实例）+ CDN 边缘缓存 |
| 60+ 插件解析第三方资源站 | 仅 TG 公开频道（后续可按需加插件，见下） |
| 后台异步补全深度结果 | 不做后台任务；一次请求内先返回快速结果 |
| 需要服务器 + 代理访问 TG | 海外函数直连 t.me，零代理 |

**为什么在 Vercel 上反而更省心**：不用买服务器、不用配代理、不用运维，
免费额度对个人使用完全够（ Hobby 计划含每月 100GB 带宽与充足的函数调用次数）。

## 插件系统

插件放在 `api/_lib/plugins/`（`_` 前缀目录不会被 Vercel 误建为独立函数），每个文件导出：

```js
module.exports = {
  name: 'hunhepan',              // 插件名（ENABLED_PLUGINS 里引用）
  label: '混搜盘(4站)',           // 展示名
  async search(kw, timeoutMs) {  // 返回与 TG 频道结果同构的数组
    return [{ type, name, url, code, title, channel, date, ts }];
  }
};
```

写好后到 `api/search.js` 顶部的 `PLUGINS` 数组里 `require` 一行即可。
单个插件失败静默降级（返回空数组），不影响其他源。

### 当前插件状态

| 插件 | 状态 | 说明 |
|---|---|---|
| `hunhepan` | 协议漂移，待适配 | 移植自原版 Go 插件；实测 hunhepan.com 已改请求格式、qkpanso.com 加了前端校验。框架保留，恢复方法见插件文件头部注释 |

**关于原版 67 个插件的移植现实**：那些插件不是配置，是 67 段针对具体资源站写的
Go 爬虫，必须逐个用 JS 重写，且第三方站 API 随时改版（原版仓库的提交记录就是
不断"修复 xxx 插件"）。务实的做法是：TG 频道打满（协议稳定多年），插件按需逐个
移植——遇到值得接的资源站，抓包看请求，照 `hunhepan.js` 的结构写 20~50 行即可。

## 本地测试

```bash
node test-local.js
```

会运行解析器单元用例，并尝试真实抓取 1 个频道验证全链路。

## 免责声明

本项目仅用于技术学习与个人搜索聚合演示，不存储、不上传、不传播任何资源文件，
所有链接均来自公开 Telegram 频道。请遵守当地法律法规，勿用于商业或侵权用途。
