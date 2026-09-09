# GitHub + Cloudflare 部署步骤

本流程只在你手动触发时创建或更新 Worker/D1，不会购买服务或自动公开仓库。GitHub 分支有代码、测试通过、公网部署成功、本机 WorkBuddy 可用，是四个不同阶段。

## 1. 合并并检查代码

将包含本项目的 PR 合并到仓库默认分支 `main`。三个工作流才会出现在正常部署入口：

- `AI news checks`：无云凭据的本地验证。
- `Deploy AI news`：只允许在 `main` 上手动部署。
- `Collect AI news`：每日北京时间 07:17 的采集，默认未启用；也可手动触发。

请先审阅 `scripts/prepare-deploy.mjs` 和三个 `.github/workflows/ai-news-*.yml` 文件。Actions 从 `main` 读取源码；不要把外部不可信 PR 合并后直接交给带生产凭据的部署流程。

## 2. 准备 Cloudflare 免费账号

在你的 Cloudflare 控制台确认：

1. 使用的是你打算承载本项目的账号；复制该账号的 **Account ID**。
2. Workers & Pages 已完成初始设置，账号有可用的 `workers.dev` 子域名。没有时先在控制台完成配置，部署脚本不会替你占用一个猜测的子域名。
3. 当前套餐符合你的免费预算。不要为此项目开通 Workers Paid、R2、域名购买或其他付费套餐。
4. 创建自定义 API Token，仅对这个账号授权：**Workers Scripts 编辑、D1 编辑**。不要使用 Global API Key，也不需要 DNS 全局编辑权限。
5. Token 只用于 GitHub 部署 Secret。这里连接 Cloudflare 的 OAuth 授权不会自动变成 GitHub Actions 能读取的密钥。

如果 Token 权限不足，流程会明确失败；先检查账号和上述权限，不要直接改成全账号全权限。

## 3. 配置 GitHub Secrets 和 Variables

进入目标仓库 → Settings → Secrets and variables → Actions。

### Repository secrets

| 名称 | 值 |
|---|---|
| `CLOUDFLARE_API_TOKEN` | 上一步创建的受限 Token |
| `READ_TOKEN` | 新生成的随机密钥，供 WorkBuddy 只读使用 |
| `INGEST_TOKEN` | 另一把独立随机密钥，仅供采集器写入 |

两把应用密钥至少 32 字符，建议各自生成 32 字节随机值再编码。可在你自己的终端运行两次：

```sh
python -c "import secrets; print(secrets.token_urlsafe(32))"
```

不要将真实输出放进聊天、PR、截图或配置示例。记录 `READ_TOKEN` 到你自己的密码管理器，后面配置 WorkBuddy 需要它。GitHub Secret 保存后不能从界面读回原值。

### Repository variables

先填写：

| 名称 | 值 |
|---|---|
| `CLOUDFLARE_ACCOUNT_ID` | 32 位账号 ID |

部署后再填写 `API_BASE_URL`，验收完成后再将 `AI_NEWS_ENABLED` 设为 `true`。不需要给采集工作流 Cloudflare 管理 Token。

## 4. 手动触发首次部署

仓库 Actions → `Deploy AI news` → Run workflow：

- 分支选择 `main`。
- `resource_name` 默认 `workbuddy-ai-news`。可以换成专属于此项目的名称，3–50 位小写字母、数字或连字符，首位字母。
- **首次不要勾选 `allow_update`**。如果已有同名 Worker 或数据库，脚本会停止，不会静默覆盖。

流程依次执行：

1. 安装锁定依赖，运行离线测试。
2. 检查资源名称、账号 `workers.dev` 子域名和已有资源。
3. 创建 D1（APAC 位置提示，非固定地域保证），取得真实 ID，生成运行时 Wrangler 配置。
4. 应用数据库迁移、部署 Worker、写入两把 Worker Secrets。Secret 从标准输入传递，不打印内容。
5. 从 Actions runner 验证 `/health`、匿名访问被拒绝，以及官方 MCP 客户端能发现并调用两个只读工具。
6. 在运行 Summary 中输出实际 API/MCP 地址。
7. 进行一次真实来源采集。此步骤可能单独失败，不能只看部署 Summary 就认定已有最新资讯。

Worker 代码刚部署、Secrets 尚未写入的短暂阶段，受保护接口会关闭访问并返回 503，不会匿名开放。

### 流程失败怎么办？

- **同名资源错误**：换新名称；只有确认现有 Worker 和 D1 都属于本项目时，才勾选 `allow_update` 重试。部分部署失败可能已经创建数据库，此时先检查控制台。
- **Cloudflare HTTP 401/403**：检查 Token、目标账号及权限，错误处理不输出 Token。
- **未配置子域名**：先在 Cloudflare 完成 Workers 初始设置。
- **新服务的地址暂时未生效**：验证脚本有有限重试；持续失败时检查控制台配置，不将失败视为通过。
- **所有信息源失败**：服务可能已经部署，但没有新数据。查看采集错误和 `/api/status`，不要反复绕过来源访问限制。
- **本地测试通过但线上出现 1102**：可能超过免费 Worker CPU/内存限制。先检查实际使用、缩小请求或优化，不自动开通付费方案。

不要为了绕过失败而关闭鉴权、将写入接口公开或把密钥放进 URL。

## 5. 启用每日采集

部署与初次采集成功后：

1. 将 Summary 中的实际基础地址填写到 Repository variable `API_BASE_URL`，例如其协议和域名部分；**不要附加 `/mcp` 或 `/api/news`**。
2. 手动运行一次 `Collect AI news`，验证这组 Variables/Secrets 确实有效。
3. 将 `AI_NEWS_ENABLED` 设置为字符串 `true`。
4. 每日任务在 UTC 23:17 触发，即北京时间次日 07:17；Actions 可能延迟或漏跑，不能保证 07:17 准点完成。
5. WorkBuddy 日报可以定在北京时间 08:00，但必须先检查来源状态、最后成功时间与文章日期。

关闭定时采集：将 `AI_NEWS_ENABLED` 改为 `false`，或禁用 `Collect AI news` 工作流。手动采集仍可运行；如要彻底停止，禁用工作流。

## 6. 维护与撤销

- 更新代码：合并审阅过的代码到 `main`，手动运行 `Deploy AI news` 并勾选仅更新本项目资源。没有 push 自动部署。
- 轮换应用密钥：更新 GitHub Secret，重新部署；如更新 `READ_TOKEN`，同步更新 WorkBuddy 本地配置。
- 撤销 CI 部署权限：撤销 Cloudflare API Token，删除 GitHub 中对应 Secret。已经部署的 Worker 不会因此自动删除。
- 停用服务：先停用采集，在 Cloudflare 删除属于本项目的 Worker；确认不再需要数据后再删除 D1。删除数据库会丢失历史记录，本项目不会自动替你执行。
- D1 数据库 ID 只在部署运行时写入 Wrangler 配置，仓库示例保持占位符；不要直接把示例里的占位符用于远程操作。

## 验收清单

- [ ] 本地与 GitHub 检查通过。
- [ ] Cloudflare 实际部署完成，拿到了真实地址。
- [ ] 匿名访问 `/api/news` 返回 401，带只读密钥返回数据。
- [ ] 只读密钥不能写入，采集密钥不能读取。
- [ ] `get_collection_status` 能显示各源成功/失败情况。
- [ ] 真实采集有结果；无内容时不编造日报。
- [ ] 本机 WorkBuddy 成功连接 MCP 并调用两个工具。
- [ ] 已核实本机网络可达，未把云端可达当成本机可达。
- [ ] 每日采集和 WorkBuddy 日报分别启用，确认客户端执行条件。

参考：[Cloudflare 无状态 MCP](https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/)、[D1 创建 API](https://developers.cloudflare.com/api/resources/d1/subresources/database/methods/create/)、[Actions 定时限制](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)。
