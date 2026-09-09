# WorkBuddy AI 科技资讯 API

一个自用、免费额度优先的资讯管道：GitHub Actions 定时采集公开 RSS/API，Cloudflare Workers + D1 保存并提供只读 API/MCP，腾讯 WorkBuddy 负责中文筛选和总结。

**代码可部署不等于已上线。** 仓库不附带真实 Cloudflare 账号 ID、数据库 ID、访问密钥或公网服务地址。真实地址由部署流程返回；必须完成云端部署和本机 WorkBuddy 验收后才能依赖它。

## 方案

```text
GitHub Actions（Python，每日北京时间 07:17）
  ├─ AI 官方发布与研究机构（7 个源）
  ├─ 工程博客（4 个源）、论文公告（3 个源）
  ├─ GitHub 项目 Releases（6 个源）
  ├─ 科技媒体（5 个源）、开发者社区（2 个源）
  └─ AINews 社媒聚合摘要（1 个源：X / Reddit）
       ↓ 限流、超时、去重、提取元数据与简短摘录
POST /api/ingest + POST /api/runs（写入密钥）
       ↓
Cloudflare D1，保留约 30 天数据
       ↑
Cloudflare Worker
  ├─ REST：/api/news、/api/status
  └─ MCP：/mcp → get_news、get_collection_status（只读密钥）
       ↑
WorkBuddy → 中文日报 → 本地文件 / 由用户自行开启的小程序推送
```

### 首版范围

- 默认接入 **28 个来源、7 个分类**，见[完整来源清单与采集规则](docs/sources.md)。其中 AINews 通过公开聚合 RSS 提供 X/Reddit 摘要，不要求用户拥有社媒账号；Telegram、Discord 未接入。来源可配置，总数上限 30，与运行报告接口一致；不宣称覆盖所有国际社媒。
- 每源最多保留 25 条最近 30 天的内容；HN 最多请求 15 条热门故事。四个来源并发采集，单源失败独立记录，输出顺序和跨源去重结果保持确定性。
- GitHub Releases 使用官方 REST API，只取返回的最近 25 个 Release 中的非草稿、非预发布版本，使用 `published_at` 而不是 commit/更新日期。Actions 自带的只读 `GITHUB_TOKEN` 仅发送到严格校验的 GitHub API 端点，无需新增个人 Token。
- arXiv 只保留 `new` 类型的论文公告，跳过修改版与跨类再公告，避免把旧论文更新当新论文。这里的发布时间指 arXiv 首次公告时间，不是投稿时间；每类采样最多 25 篇，不是完整论文列表。
- 不调用付费模型，服务端不需要 OpenAI API Key；WorkBuddy 自身积分/套餐另算。
- 不接登录态、付费墙、私信和受限接口。X/Reddit 当前仅通过聚合发布者的公开摘要间接覆盖，直接平台接口与其他社媒仍需分别核实授权、预算和条款。
- 不做完整文章镜像，不下载视频或论文全文；摘要所依据的输入为标题和最多 500 字符的来源摘录，可能不足以判断详细结论。
- 第一版交付 API/MCP，不包含资讯浏览网页。

## 数据准确性与维护

- ID 为规范化 URL 的 SHA-256。只移除 fragment、`utm_*`、`fbclid`、`gclid`，保留业务查询参数。URL 相同才去重，不声称已经实现语义层面的事件合并。
- `published_at` 来自来源发布时间，未知、无时区或未来时间记为 `null`。聚合摘要的这个字段指摘要出版时间，不指其引用帖子的发帖时间；API/MCP 通过 `provenance` 标明。`first_seen_at`、`last_seen_at` 是服务端采集观察时间，不能当成发布时间。
- 时间窗口按 `published_at` 排序/过滤；未知时回退到首次发现时间，但保留 `null` 标记。
- 每源失败会单独记录，保留其他来源成果。全失败时流程失败，最近成功时间不更新；API 不会把已有数据伪装成这次采集成功。
- `stale` 只代表“距离最近至少一个来源成功超过 36 小时”，不代表每个来源健康。必须同时查看 `latest_run.sources`。来源正常返回零条也是一次成功检查。
- 来源条数是各源独立去重后的条数，跨来源可能重复，因此运行总条数不等于数据库唯一文章数。
- 成功写入运行报告时清理 30 天前的数据和报告。长时间停跑时不会自动清理；数据只有元数据和短摘录。
- Actions 定时任务非准点保证，可能延迟或漏跑。公共仓库连续 60 天无活动，定时任务可能被停用。默认日程关闭，配置变量后才会真正采集。

## 上线入口

按 [部署步骤](docs/deployment.md) 完成一次配置，再按 [WorkBuddy 接入与日报提示词](docs/workbuddy.md) 验收。

部署流程需要你在 GitHub 仓库 Settings → Secrets and variables → Actions 中设置：

| 类型 | 名称 | 用途 |
|---|---|---|
| Secret | `CLOUDFLARE_API_TOKEN` | 仅目标账号的 Workers Scripts 编辑、D1 编辑，用于手动部署 |
| Secret | `READ_TOKEN` | WorkBuddy 只读访问，至少 32 字符的独立随机密钥 |
| Secret | `INGEST_TOKEN` | 定时采集写入，不能交给 WorkBuddy |
| Variable | `CLOUDFLARE_ACCOUNT_ID` | 目标 Cloudflare 账号 ID，不是登录邮箱 |
| Variable，部署后填写 | `API_BASE_URL` | 流程返回的实际 Worker 地址，不含路径 |
| Variable，验收后填写 | `AI_NEWS_ENABLED` | 设为 `true` 才启用定时采集；手动采集不受此开关限制 |

不会自动合并 PR、改变仓库公开性、购买域名、开启付费方案或注册第三方数据套餐。手动部署默认拒绝覆盖同名资源；确认资源属于本项目后才能勾选允许更新。

## API

| 路径 | 方法 | 鉴权 | 作用 |
|---|---|---|---|
| `/health` | GET | 无 | 仅检查程序存活，不代表采集成功 |
| `/api/news?hours=24&limit=20` | GET | `READ_TOKEN` | 资讯检索，支持分类、来源、多样性上限和分页 |
| `/api/status` | GET | `READ_TOKEN` | 全部配置来源/分类、最近成功时间、运行与来源健康情况 |
| `/mcp` | POST | `READ_TOKEN` | 无状态 Streamable HTTP MCP |
| `/api/ingest` | POST | `INGEST_TOKEN` | 每批最多 25 条，输入体最多 128KiB |
| `/api/runs` | POST | `INGEST_TOKEN` | 提交本次各源结果，触发保留期清理 |

`get_news` 与 `/api/news` 使用相同查询参数：

| 参数 | 规则 |
|---|---|
| `hours` | 1–168，默认 24 |
| `limit` | 每页 1–50，默认 20，不一次性把所有内容塞给模型 |
| `category` | `official_ai`、`engineering`、`research`、`releases`、`media`、`community`、`social` |
| `source` | 来源名称精确匹配，可从 `configured_sources` 获取 |
| `per_source_limit` | 未指定 source 时默认每源最多 3 条，可设 1–10，防止高频媒体占满结果；单源查询忽略此参数 |
| `offset` | 0–1000，默认 0；按返回的 `next_offset` 翻页并保持其他参数不变 |

返回 `has_more`、`next_offset`。分页只针对当前时间范围、分类和每源上限内的结果，并非全文数据库快照；采集更新或时间窗口滑动时，连续翻页可能变化。需要深入某个源时按 source 单独查询。日常日报建议先查 `social`，再按其余六个分类分别取每源 2 条，而不是只读总榜前 50 条。

鉴权格式是 HTTP Header `Authorization: Bearer <密钥>`，不是 URL 查询参数。两把密钥必须不同。未配置或短密钥返回 503；鉴权失败返回 401。除了 `/health`，不会匿名公开数据。

MCP 只提供两个只读工具，不允许调用者修改来源、触发采集、执行代码或访问任意 URL。没有 SSE 会话、Durable Objects、OAuth 用户系统或对外开放注册。`GET /mcp` 返回 405 是无状态实现的预期行为，POST 才用于 MCP 交互。

## 本地开发与验证

需要 Node.js 22+ 和 Python 3.12+。在本目录运行：

```sh
npm ci
python -m venv .venv
# Windows PowerShell: .venv\Scripts\Activate.ps1
# macOS/Linux: source .venv/bin/activate
python -m pip install -r requirements.txt
python -m unittest discover -s tests -p 'test_*.py'
npm test
npm run build
```

`npm test` 自动启动本地 Worker 和独立的本地 D1，使用仅测试用途的假密钥；通过官方 MCP SDK 连接、发现和调用工具，并验证 Python 写入契约。部署准备脚本测试只模拟 Cloudflare API，不创建云资源。

采集真实来源但不上传：

```sh
python scripts/collect.py --dry-run --output collection-output.json
```

输出含 `items` 和 `run`。真实请求可能被来源拒绝，按实际运行结果处理，不保证每次成功。收集结果被 `.gitignore` 排除；不要提交第三方内容。

手动调试服务时先运行 `npm run db:local`，通过本地 `.dev.vars` 配置独立的 `READ_TOKEN`、`INGEST_TOKEN`，再运行 `npm run dev`。本地文件已加入忽略规则。不要使用生产密钥做测试。

## 费用、连通性与限制

- [Workers 免费版](https://developers.cloudflare.com/workers/platform/limits/)当前每天 10 万请求，每次 **10ms CPU**；网络等待不算 CPU。免费额度不等于可运行任意复杂任务。
- [D1 免费版](https://developers.cloudflare.com/d1/platform/pricing/)当前总存储 5GB、每天 500 万行读/10 万行写。索引和查询扫描也计入额度；超过免费额度会产生错误，而不是无限使用。
- [GitHub Actions](https://docs.github.com/en/billing/concepts/product-billing/github-actions)标准公共 runner 免费，GitHub Free 私有仓库有账号共享的每月 2,000 分钟和存储额度。不要开启超额付费，控制日志保留期，不上传大体积构建产物。
- 代码面向上述免费额度设计，但本地测试不验证生产 CPU 配额。部署后还要检查 Worker 真实错误率/CPU 使用；不能为了通过测试自动升级付费。
- D1 创建请求使用 APAC 位置提示，不保证固定新加坡节点；Worker 是全球运行的 serverless 服务，不是固定地区 VPS。
- 免费 `workers.dev` 域名不能保证中国大陆网络可达，自定义域名也不保证。一定先从 WorkBuddy 所在电脑测试 `/health` 和带鉴权的 MCP。
- 若已经在付费 Cloudflare/GitHub 账号中部署，计费规则以账号实际套餐为准；脚本不会切换套餐。
- 本项目保持自用、私有部署。将来公开代码前另行选择开源许可证；将来公开数据前另行核查来源授权、隐私及所在地适用要求。

## 论文数据致谢

Thank you to arXiv for use of its open access interoperability.

## 安全边界

凭据只放 GitHub Secrets、Cloudflare Worker Secrets 和 WorkBuddy 本地受控配置，不放 README、Git 提交、日志或聊天。采集密钥不能读数据，读取密钥不能写数据。密钥需要定期轮换，轮换后更新对应消费端。

外部文章、标题、摘录都属于不可信数据，不能成为给 Agent 的指令。日报任务不得因为来源文字要求而执行命令、外发消息、读取凭据或修改文件范围。仅授予这两个只读 MCP 工具所需权限，不建议开启 WorkBuddy 全部工具的完全访问模式。
