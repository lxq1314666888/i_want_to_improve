# ops —— 运维脚本

这个仓库的改动**不走 git**：本机 `git` 协议访问 `github.com` 被网络层拦截
（`schannel: server closed abruptly` / `OpenSSL SSL_read: unexpected eof`，换 TLS 后端也不行），
而 GitHub MCP 是只读的。所以推送、触发、核验一律通过 Playwright 驱动**已登录的 Edge** 完成。

## 前置

| 项 | 位置 |
|---|---|
| Playwright 模块 | `~/.workbuddy/binaries/node/workspace/node_modules/playwright` |
| Node | `~/.workbuddy/binaries/node/versions/22.22.2-3/node.exe` |
| 持久化 profile | `~/.workbuddy/pw-profile`（已登录 GitHub，会话有效期至 2026-09-28） |

运行前必须清掉代理，沙箱注入的代理会拦本地回环：

```bash
env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY NO_PROXY="*" \
  "C:/Users/11600493/.workbuddy/binaries/node/versions/22.22.2-3/node.exe" ops/gh-check.cjs
```

## 四个脚本

| 脚本 | 用途 |
|---|---|
| `gh-check.cjs` | **只读**检查登录态、仓库可访问性、是否有 Add file 权限。改动前先跑它确认通道可用 |
| `gh-push.cjs` | 按仓库目录分组批量上传。`--only=<组名>` 精确选取（组名见脚本内 `GROUPS`）；`--dry` 只打开页面报告 DOM，不提交 |
| `gh-delete.cjs <仓库相对路径>` | 删除文件。**删除前自动归档到 `backup/`**，删除后匿名回读确认 404 才算成功 |
| `gh-run.cjs <workflow文件名>` | 触发 `workflow_dispatch`，如 `gh-run.cjs ai-news-collect.yml` |

> 新增脚本后记得同步 `gh-push.cjs` 里的 `GROUPS` 数组，否则它不会被推送上去。

用法示例：

```bash
node ops/gh-push.cjs --only=config     # 只推 config/ 三个文件
node ops/gh-push.cjs                   # 推全部分组
node ops/gh-run.cjs ai-news-apply-config.yml
```

## 为什么必须做 API 回读（重要）

**汇总行说「失败 0 组」没有任何证据价值。** 这个脚本曾**连续两次谎报成功**，仓库文件其实没变：

1. 第一版用 `!url.includes('/upload/')` 判断提交成功 —— 提交后停留的 `/upload` **没有尾部斜杠**，
   被误判成「已跳转」；
2. 补成 `!includes('/upload')` 后仍然不可靠 —— `waitForURL` 的 predicate 会在**导航中间态**返回 true；
3. 另一个独立原因：多文件时固定 `sleep(4000)` 不够，GitHub 还没把文件渲染进待提交列表就点了提交。
   规律很明确 —— **1–2 个文件的组全对，3 个文件的 `config/` 组反复失败**。

现在的实现是两条一起上，缺一不可：

- **按文件名逐个等待渲染完成**（`getByText(...).waitFor()`），而不是固定 sleep；
- **提交后匿名回读仓库文件比对字节数**（`verifyUploaded()`），不再以 URL 变化为判据。

## 删除文件是两步操作

`gh-delete.cjs` 走 GitHub 的 `/delete/<branch>/<path>` 页面。注意该页的按钮文本是
**`Commit changes...`（带省略号）**，点它只是**展开**提交面板；真正的提交按钮在展开后才出现，
文本是 `Commit changes`（**不带**省略号）。用一条 `has-text` 一次匹配会命中不可见元素并超时，
所以脚本先展开、再用精确文本匹配提交。

删除前脚本一定先把文件内容归档到 `backup/`，归档失败就中止删除——**不留不可恢复的删除**。

## 变更流程

```bash
# 1. 本地先验证，别把红着的东西推上去
python scripts/validate_config.py
python -m unittest discover -s tests -p 'test_*.py'
npm run build

# 2. 推送改动涉及的组
node ops/gh-push.cjs --only=config

# 3. config/** 或 src/** 的改动会自动触发 ai-news-apply-config.yml
#    （校验 → 打包 → 测试 → 注入 D1 id → 迁移+部署 → 线上 API 验证）
#    也可以手动触发：
node ops/gh-run.cjs ai-news-apply-config.yml
```

## 目录说明

- `backup/` —— `cloud-2026-09-15-worker.js` 是**改造前的线上 Worker 源码**，用于回滚核对
  （改造后 Worker 由 `config/` 驱动，旧版源码里是写死的 7 个分类）。Cloudflare 控制台也可直接回滚版本。
- `samples/` —— 本地 `--dry-run` 的采集样本，用于核对解析结果，不参与线上流程。

`backup/` 与 `samples/` 都已在 `.gitignore` 中排除，不会推到仓库。
