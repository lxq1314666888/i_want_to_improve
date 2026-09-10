# GitHub AI News 部署仓库（GitHub Actions + Cloudflare Workers + D1 + MCP）

把 AI / 科技资讯自动采集到 Cloudflare D1 数据库，对外提供带鉴权的 HTTP API 与
MCP 服务（可连接腾讯 WorkBuddy 生成中文日报）。采集由 GitHub Actions 定时执行，
云端运行，不依赖你的电脑开机。

## 架构

```
GitHub Actions (Collect AI news, 每天 07:17 北京时间)
        │  HTTP POST (Bearer INGEST_TOKEN)
        ▼
Cloudflare Worker (workbuddy-ai-news) ── D1 数据库 (news / collection_log)
        │
        ├── GET  /health               健康检查（无需密钥）
        ├── GET  /api/news             新闻列表（Bearer READ_TOKEN）
        ├── GET  /api/news/:id         单条新闻（Bearer READ_TOKEN）
        ├── POST /api/news/batch       批量写入（Bearer INGEST_TOKEN）
        ├── GET  /api/collection/status 最近采集状态（Bearer READ_TOKEN）
        ├── POST /api/collection/log   采集日志回写（Bearer INGEST_TOKEN）
        └── POST /mcp                  MCP Streamable HTTP（Bearer READ_TOKEN）
                └─ 工具：get_news / get_collection_status
```

- `READ_TOKEN`：只读，给 WorkBuddy / 你自己查询使用
- `INGEST_TOKEN`：只写，给 GitHub Actions 采集任务使用
- 两把密钥必须不同、≥32 字符，只作为 GitHub Secrets 保存，绝不入库、不提交

## 一、仓库配置（一次性）

### Secrets（3 条，Settings → Secrets and variables → Actions → Secrets）

| Name | 值 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare 自定义 Token（权限：Account → Workers Scripts → Edit；Account → D1 → Edit；资源范围限定本账号） |
| `READ_TOKEN` | 随机 64 位字符串（只读） |
| `INGEST_TOKEN` | 随机 64 位字符串（只写，与 READ_TOKEN 不同） |

### Variables（3 条，同页 Variables 标签）

| Name | 值 |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Account ID（32 位，可放 Secrets 也可放 Variables，工作流两者兼容） |
| `API_BASE_URL` | 首次部署后从 Deploy 运行摘要复制，如 `https://workbuddy-ai-news.xxx.workers.dev`（不带路径） |
| `AI_NEWS_ENABLED` | 手动采集测试通过后设为小写 `true` 开启每日定时；置 `false` 可暂停 |

> 不要自己创建 `GITHUB_TOKEN`，GitHub 会自动提供。

## 二、首次部署

1. 完成上面的 Secrets / Variables 配置。
2. GitHub 仓库 → Actions → 左侧 **Deploy AI news** → **Run workflow**。
   - Branch: `main`
   - resource_name: 保持默认 `workbuddy-ai-news`
   - allow_update: 不勾选（首次）
3. 等整条运行绿色结束（包括最后的 Initial collection）。
4. 打开运行记录 → Summary，复制 `API_BASE_URL`，填进仓库 Variables。
5. 浏览器打开 `API_BASE_URL/health` 应看到 `{"ok":true,...}`；
   打开 `API_BASE_URL/api/news` 应看到 `401 Unauthorized`（无密钥被拒，符合预期）。

> 若报"同名资源已存在"：先到 Cloudflare 确认同名 Worker / D1 是否属于本项目，
> 确认后再用相同 resource_name 并勾选 allow_update 重试；不是本项目的资源请换一个名字。

## 三、数据采集

- **手动采集**：Actions → **Collect AI news** → Run workflow（Branch: main）。
  逐源日志格式：`OK: 来源名: N items` / `WARNING: 来源名: 原因`。
  部分来源失败仍可能整体绿色，请查看逐源日志；某源 0 条可能是近期无新内容，属正常。
- **每日定时**：`AI_NEWS_ENABLED=true` 后，每天北京时间 07:17 自动触发
  （GitHub 可能排队延迟；不保证准点，刚开启不会补跑过去的时间）。
- 采集在 GitHub 云端执行，与你的电脑是否开机无关。

### 来源覆盖（sources.json 可增删）

- official_ai / engineering / research / media / community：各官方博客与媒体 RSS、arXiv、
  Nature、IEEE、Hacker News 等，共 30+ 源
- social：X/Reddit 无直连 API，经 **AINews** 二手摘要转述覆盖（注明"经 AINews 转述"，
  标题/时间/链接属于摘要本身，不是原帖）
- releases：GitHub 热门 AI 项目最新 Release（GitHub API 未鉴权每小时限 60 次，够用）
- Telegram / Discord 未接入

## 四、连接 WorkBuddy

1. WorkBuddy → 插件 → MCP 服务器 → 配置 MCP，新增 `ai-news`：

```json
{
  "mcpServers": {
    "ai-news": {
      "type": "http",
      "url": "REPLACE_WITH_FULL_MCP_URL",
      "headers": {
        "Authorization": "Bearer REPLACE_WITH_READ_TOKEN"
      }
    }
  }
}
```

2. `REPLACE_WITH_FULL_MCP_URL` → Summary 里的 MCP 地址（以 `/mcp` 结尾，不是 `/health`）
3. `REPLACE_WITH_READ_TOKEN` → 你保存的 READ_TOKEN（保留 `Bearer ` 和其后的空格）
4. 只批准 `get_news`、`get_collection_status` 两个只读工具。不要在此处使用 Cloudflare Token 或 INGEST_TOKEN。

验收：让 WorkBuddy 调用 `get_collection_status`（看最后采集时间、stale、失败源），
再调用 `get_news`（最近 24 小时、按分类、limit 等），能返回真实数据或明确空结果即可。

日报定时任务：WorkBuddy 自动化里创建"AI 科技日报"，每天 08:00，
工具仅开放上述两个只读工具，文件写入仅限你指定的日报文件夹，文件名 `YYYY-MM-DD-ai-news.md`。

## 五、本地开发 / 验证

```bash
npm test            # 模拟 Worker 逻辑（22 项断言：鉴权/写入/读取/MCP）
npm run test:live   # 真实抓取演练（本地 mock 接收端，需联网）
npm run debug:source -- "AINews"   # 调试单个来源
```

## 六、安全与运维

- 三把密钥只放密码管理器，不发聊天、不入仓库、不截图。
- 中国大陆网络可能无法访问部分海外源/最终 workers.dev 地址，属网络因素，不是代码故障。
- 停每日采集：`AI_NEWS_ENABLED` 改 `false`（手动采集仍可用）；
  停整个采集工作流：Actions → Collect AI news → Disable workflow。
- 更新代码：合入 main 后手动 Run **Deploy AI news**（resource_name 一致，确认资源归属后勾选 allow_update）。
  push 代码不会自动更新线上 Worker（`on: push` 已配置，但依赖 Secrets，未配置时会失败，属预期）。
- 密钥泄露：Cloudflare 撤销旧 Token 重建并更新 Secret；READ/INGEST_TOKEN 重新生成，
  更新 GitHub Secrets 后重跑 Deploy；READ_TOKEN 变了还要更新 WorkBuddy。
- 删除 D1 会丢数据，不建议为排错随意删除。

## 记录卡（本机自留，不提交）

| 项 | 值 |
|---|---|
| Cloudflare 账号 |  |
| resource_name | workbuddy-ai-news |
| API_BASE_URL |  |
| MCP 完整地址 |  |
| Token 保存位置 / 到期提醒 |  |
| 日报文件夹 |  |
