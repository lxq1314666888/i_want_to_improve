# 信息源清单与扩展规则

**源清单的唯一真源是 [`config/sources.json`](../config/sources.json)**，主题定义在 [`config/topics.json`](../config/topics.json)。本文件只说明采集规则、类型差异与合规边界——不再重复一份源表格，避免文档与配置不同步。

改完配置先跑 `python scripts/validate_config.py`，它逐项检查并指出哪个文件、哪一项、什么问题。

## 主题体系

主题按**选题方向**划分，不按来源性质划分，因为取数时的实际问题是「我要写 AI 搞钱案例，该拉哪一批」。`sources.json` 里每个源的 `category` 必须是 `topics.json` 中已定义的 id。

| 主题 id | 名称 | 用途 |
|---|---|---|
| `ai_industry` | AI 行业动态 | 大厂动作、融资并购、产品发布、监管政策 |
| `ai_tools` | AI 工具与产品 | 新上线工具、产品新功能、可上手方案 |
| `indie` | 独立开发与副业 | 个人项目、小团队产品、副业实操 |
| `creator` | 内容创作与平台运营 | AI 辅助创作、平台规则、涨粉与变现 |
| `ai_tech` | 技术前沿 | 论文、开源工程实践、架构方案 |
| `ai_releases` | 开源与发版 | 主流框架与推理引擎的版本发布 |

每个主题在 `topics.json` 里还有 `angle` 字段，写明该主题「怎么判断值不值得做」，供生成产物时使用。

## 源类型与采集规则

| type | 适用对象 | 规则与限制 |
|---|---|---|
| `feed` | RSS / Atom | 支持 RSS 2.0、Atom、RDF。拒绝包含 DTD 或实体的 XML，拒绝非 https 降级跳转 |
| `arxiv` | arXiv 分类 RSS | 只保留 `announce_type=new`，跳过替换版与跨类再公告。发布时间指首次公告时间，不是投稿时间 |
| `github_releases` | GitHub 仓库发版 | 走官方 REST API，`per_page=25`，排除 draft 与 prerelease。URL 必须严格匹配 `https://api.github.com/repos/<owner>/<repo>/releases`，否则拒绝携带凭据 |
| `hackernews` | Hacker News | 只取前 15 条热门故事，串行限速读取，不采集评论 |
| `ainews` | AINews 专栏 | 专用适配器，只处理 `[AINews]` 条目并抽取 X/Reddit recap 两节的开头摘录，不适用于任意网页 |
| `hot_api` | 热搜类 JSON 接口 | 约定 `{"data":[{"title":...,"link"?:...,"hot_value"?:...}]}`。这类条目没有发布时间，`published_at` 记为 null（不伪造时间），热度数值存入 `excerpt` |
| `html_scrape` | 静态 HTML 列表页 | 抽取页面内链接与锚文本。**只对服务端渲染页面有效**；依赖 JavaScript 渲染的站点（36氪、机器之心等）拿到的是空壳，需单独适配其数据接口 |

`hot_api` 与 `html_scrape` 是为「抓取型源」新增的类型。热搜榜能反映当下注意力分布，但内容以社会娱乐新闻为主，**建议配合关键词过滤使用**，别直接混进选题池。

## 当前状态（2026-09-15 实测）

- 启用 44 个源、覆盖 6 个主题，其中中文源 12 个（量子位、雷峰网、钛媒体、爱范儿、InfoQ 中文、少数派、稀土掘金、阮一峰，加 4 个中文热榜）
- 4 个源标记 `enabled: false` 作为待验证占位，**不占用数量配额**：
  - 36氪、机器之心：RSS 已下线（`/feed` 与 `/rss` 现返回 HTML 页面），需 `html_scrape` 专用适配或改用其数据接口
  - Indie Hackers、V2EX：大陆网络超时未能验证，GitHub Actions 海外网络可再试，确认可采后改 `enabled: true`
- 本机大陆网络实测可用的新增源：InfoQ 中文、量子位、雷峰网、钛媒体、爱范儿、少数派、稀土掘金、阮一峰、Product Hunt、Hacker News Show HN、The Rundown AI

**本机可达不等于 Actions 可达，反之亦然。** 上述结论来自本地网络探测，运行时以逐源健康报告（`/api/status` 的 `latest_run.sources`）为准。

## 许可与使用边界

- 只读取公开 Feed，不代表可以绕过付费墙、下载全文或再分发。公开运营前须核查各自许可，例如 [TechCrunch 有专门的 RSS 条款](https://techcrunch.com/rss-terms-of-use/)
- 保持原文链接与来源归属，不把媒体报道伪装成官方发布
- 个人意见、社区热度、转述链接不构成事实验证
- Telegram、Discord 采集**仍未接入**：公开预览页不等于不受限制的数据接口，[Telegram 内容许可条款](https://telegram.org/tos/content-licensing)另有针对抓取与 AI 用途的限制。不使用镜像或 RSS 转换器绕过
- 聚合站核查（2026-09 记录）：BestBlogs 条款要求 API Key、Answer Overflow 被 Vercel 风控拦截、TGStat 与 Telemetr 均需注册凭据——**能读到 RSS 不等于获得许可**，均未默认接入

Thank you to arXiv for use of its open access interoperability.

## 扩展一个新源

1. 确认真实入口（不要猜测地址）、允许的用途、是否需授权
2. 往 `config/sources.json` 加一条，字段：`name`（唯一）、`type`、`url`、`category`（须在 topics.json 中）、`lang`、`enabled`
3. 跑 `python scripts/validate_config.py` 校验
4. 跑 `python scripts/collect.py --dry-run --output /tmp/probe.json` 实测能否采到
5. 能解析但最近没有更新，应记录零条，不伪造新鲜度
6. push 后 `ai-news-apply-config.yml` 会自动部署，配置即刻生效

## 成本控制

- 固定最多四源并发，每源独立超时与重试；输出按配置顺序合并，避免并发完成顺序改变跨源去重归属
- 每源最多保留 25 条最近 30 天内容；HN 单源最多 15 条
- API 默认每源最多 3 条，支持按主题、按源、分页取数。`has_more` 只描述当前过滤与每源上限内是否还有下一页
- 按主题分别取每源两条，比一次拉全部来源更省上下文与积分
