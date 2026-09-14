# 信息源清单与扩展规则

默认配置为 `sources.json`，共 **30 个源、7 类**。以下链接是实际配置的采集入口，不是示例地址；每个源的成功、失败、零条结果由运行报告如实记录。

## AI 官方发布与研究机构 · `official_ai`（7）

| 来源 | 入口 | 主要内容 |
|---|---|---|
| OpenAI | [官方 RSS](https://openai.com/news/rss.xml) | 模型、产品、公司发布 |
| Hugging Face | [官方 RSS](https://huggingface.co/blog/feed.xml) | 模型、工具、开源实践 |
| Google DeepMind | [官方 RSS](https://deepmind.google/blog/feed/basic/) | 前沿模型与研究 |
| Google Research | [官方 RSS](https://research.google/blog/rss) | 研究与技术成果 |
| Microsoft Research | [官方 RSS](https://www.microsoft.com/en-us/research/feed) | 微软研究院动态 |
| NVIDIA Blog | [官方 RSS](https://blogs.nvidia.com/feed) | AI、GPU 与公司动态 |
| Google AI | [官方 RSS](https://blog.google/innovation-and-ai/technology/ai/rss/) | Google AI 产品与应用 |

## 工程与开发者博客 · `engineering`（4）

| 来源 | 入口 | 主要内容 |
|---|---|---|
| NVIDIA Developer Blog | [官方 Feed](https://developer.nvidia.com/blog/feed/) | GPU、推理与工程优化 |
| AWS Machine Learning | [官方 RSS](https://aws.amazon.com/blogs/machine-learning/feed/) | AI 云服务与工程方案 |
| Cloudflare Blog | [官方 RSS](https://blog.cloudflare.com/rss/) | 网络、基础设施、安全与 AI 工程 |
| GitHub Blog | [官方 RSS](https://github.blog/feed/) | 开发工具、平台与 Copilot 动态 |

## 研究论文 · `research`（3）

| 来源 | 入口 | 主要内容 |
|---|---|---|
| arXiv cs.AI | [官方 RSS](https://rss.arxiv.org/rss/cs.AI) | 人工智能 |
| arXiv cs.LG | [官方 RSS](https://rss.arxiv.org/rss/cs.LG) | 机器学习 |
| arXiv cs.CL | [官方 RSS](https://rss.arxiv.org/rss/cs.CL) | NLP、语言模型 |

采用 `arxiv` 类型，只选择 `announce_type=new`，排除论文替换版本、跨类再公告。每类最多 25 篇，是最新公告样本，不是排名或全量论文检索。RSS 在周末和部分节假日可能为空；空源不等于采集失败。Feed 更新可能晚于当天采集，下一次采集才会出现。

`published_at` 对这里的论文表示首次公告日期，不是投稿日期；模型不得把旧论文修订说成新论文。数据使用见 [arXiv RSS 说明](https://info.arxiv.org/help/rss.html)和[字段规范](https://info.arxiv.org/help/rss_specifications.html)。

Thank you to arXiv for use of its open access interoperability.

## 开源项目发布 · `releases`（7）

| 来源 | 官方项目 | 采集入口 |
|---|---|---|
| vLLM Releases | [vLLM](https://github.com/vllm-project/vllm) | [Releases API](https://api.github.com/repos/vllm-project/vllm/releases) |
| Ollama Releases | [Ollama](https://github.com/ollama/ollama) | [Releases API](https://api.github.com/repos/ollama/ollama/releases) |
| Transformers Releases | [Transformers](https://github.com/huggingface/transformers) | [Releases API](https://api.github.com/repos/huggingface/transformers/releases) |
| LangChain Releases | [LangChain](https://github.com/langchain-ai/langchain) | [Releases API](https://api.github.com/repos/langchain-ai/langchain/releases) |
| llama.cpp Releases | [llama.cpp](https://github.com/ggml-org/llama.cpp) | [Releases API](https://api.github.com/repos/ggml-org/llama.cpp/releases) |
| PyTorch Releases | [PyTorch](https://github.com/pytorch/pytorch) | [Releases API](https://api.github.com/repos/pytorch/pytorch/releases) |
| OpenAI Changelog | [OpenAI](https://openai.com/) | [官方 RSS](https://openai.com/changelog/rss.xml) |

使用 [GitHub 官方 Releases API](https://docs.github.com/en/rest/releases/releases)，不用未受正式支持的 `releases.atom`。每次请求 `per_page=25`，排除草稿和预发布，再按近 30 天保留，因此并不保证覆盖每一个稳定版本。例如仓库近期全部发布 nightly/prerelease 时，该源会返回零条；这是筛选结果，不是假装抓取失败。

GitHub Actions 的只读 `GITHUB_TOKEN` 用于提高配额，由平台自动提供，不需要用户填写新的 PAT。代码只在 URL 严格匹配 `https://api.github.com/repos/<owner>/<repo>/releases` 时才使用该凭据，所有带凭据的重定向都被拒绝。其他来源不收到它。本地没有该环境变量时使用匿名读取，可能遇到 GitHub IP 共享限流。

## 科技媒体 · `media`（6）

| 来源 | 入口 | 主要内容 |
|---|---|---|
| TechCrunch | [RSS](https://techcrunch.com/feed/) | 科技公司、创业、融资与 AI |
| Ars Technica | [官方目录列出的 Feed](https://feeds.arstechnica.com/arstechnica/index) | 技术、硬件与科学 |
| The Verge | [Feed](https://www.theverge.com/rss/index.xml) | 科技产品、平台与行业 |
| MIT Technology Review | [RSS](https://www.technologyreview.com/feed/) | 技术影响与研究报道 |
| IEEE Spectrum AI | [AI 主题 RSS](https://spectrum.ieee.org/feeds/topic/artificial-intelligence.rss) | AI、机器人与工程 |
| Wired AI | [AI 主题 RSS](https://www.wired.com/feed/tag/ai/latest/rss) | AI 深度报道与行业观察 |

只读取公开 Feed，不代表可以绕过文章付费墙、下载全文或再分发。公开运营前须核查各自许可；例如 [TechCrunch 有专门的 RSS 条款](https://techcrunch.com/rss-terms-of-use/)。保持原文链接和来源归属，不把媒体报道伪装成官方发布。

## 开发者社区与个人观察 · `community`（2）

| 来源 | 入口 | 主要内容 |
|---|---|---|
| Hacker News | [官方 API](https://hacker-news.firebaseio.com/v0/) | 前 15 条热门技术故事，不采集全站评论 |
| Simon Willison | [作者 Feed](https://simonwillison.net/atom/everything/) | AI 工具实践、评测、链接与个人观察 |

个人意见、社区热度、转述链接不构成事实验证。Simon 的 Feed 包含文章、短笔记、引用等不同类型；日报要保留这个区别。

## 社媒二手摘要 · `social`（1）

| 来源 | 采集入口 | 实际覆盖 |
|---|---|---|
| AINews via Latent Space | [AINews 专栏 RSS](https://www.latent.space/feed?sectionId=327741) | X/Twitter 与 Reddit 的精选讨论摘要，不需要这两个平台账号 |

入口由 [AINews 专栏页面](https://www.latent.space/s/ainews/) 的 RSS 自动发现链接确认，不使用猜测地址。`ainews` 适配器只处理 `[AINews]` 条目，从公开 RSS 的 `content:encoded` 中抽取 `AI Twitter Recap`、`AI Reddit Recap` 两节的开头短摘录，每平台最多 215 字符，总摘录仍不超过 500 字符，避免开头广告或头条导语吞掉社媒内容。不抓文章付费部分，不保存或转发完整正文；更完整的讨论和原帖引用需进入该期摘要阅读。

- **计数单位是摘要期数，不是社媒帖子数。** 一期可能涵盖多条讨论；不代表跟踪全部账号、子版块或全部评论。
- `url` 指向摘要文章，`published_at` 是**摘要发布时间**，不能当作原始帖子时间。API/MCP 的 `provenance` 明确返回 `aggregated_digest`、候选平台与日期含义。`platforms` 是来源覆盖范围，不保证每一期同时包含两个平台；实际摘录带 `X via AINews` / `Reddit via AINews` 标签。
- 仅采公共 Feed 当前暴露的部分。没有可识别社媒正文的单期会跳过；非空 Feed 中完全没有可识别摘要时标记来源失败，不把普通文章或付费预览冒充社媒采集成功。
- AINews [2026-04-03 公告](https://www.latent.space/p/ainews-good-friday)已说明 Discord 访问终止。因此不能沿用旧首页宣传，声称当前覆盖 Discord；也不覆盖 Telegram。
- 自用订阅与公开再分发不是同一权限。保留发布者归属与摘要链接；公开提供内容、扩大采集或转载全文前须另行核查许可。

### 聚合站核查记录（2026-09-09）

| 候选 | 核查结论 | 是否默认采集 |
|---|---|---|
| AINews / Latent Space | 专栏 RSS 匿名实测成功，近期正文含 X、Reddit 讨论与原帖链接；原 `news.smol.ai` 站点和 RSS 实测 HTTP 402，不作为运行依赖 | 是，仅用专栏公开 RSS |
| [BestBlogs](https://www.bestblogs.dev/en/docs/how-it-works) | 确有推文聚合，RSS 可读，但[现行条款 §6](https://www.bestblogs.dev/en/terms)仅允许带有效 API Key 的公开 API 自动访问 | 否，需另行注册/授权 API，不以能读到 RSS 代替许可 |
| [Answer Overflow](https://www.answeroverflow.com/docs/overview) | 将参与社区的 Discord 支持讨论公开索引，并非全 Discord 新闻。其[公开实现](https://github.com/AnswerOverflow/AnswerOverflow/blob/main/apps/main-site/src/app/%28main-site%29/mcp/route.ts)提供 MCP 搜索；本次匿名 SDK 调用被 Vercel Security Checkpoint 拦截，未取得工具结果 | 否，可作为人工查找线索，机器访问尚未验收；不绕过验证 |
| [TGStat](https://api.tgstat.ru/docs/ru/start/intro.html) | 有 Telegram 频道聚合和 API；网页样本被拒绝，[API 要求注册并取得 Token](https://api.tgstat.ru/docs/ru/start/token.html) | 否，没有验证可匿名订阅的 RSS |
| [Telemetr.me](https://telemetr.me/) | 部分频道网页可匿名看，但[条款 §3.5](https://telemetr.me/terms-of-services/)限制抓取、内容提取和衍生使用；API 另需凭据 | 否 |
| [Telemetr.io](https://telemetr.io/) | 与 Telemetr.me 是不同服务；[API 接入](https://api.telemetr.io/docs/intro/getting-started)需要注册和通过 Telegram Bot 取得 Key | 否 |

Telegram 公开预览页不等于不受限制的数据接口。[Telegram 内容许可条款](https://telegram.org/tos/content-licensing)另有针对抓取、聚合及 AI 用途的限制。第三方镜像、RSS 转换器或付费 API 并不自动提供下游使用许可。本版本 **Telegram、Discord 采集仍未接入**；不能用网站博客的数量替代这两项覆盖。

上述访问测试来自开发沙箱，不证明中国大陆用户网络可达，也不保证聚合站未来持续免费、持续更新。运行时以逐源健康报告为准。

## 来源扩展与成本控制

- 修改 `sources.json` 增加/替换来源，保持名称唯一。最多 30 个源，与服务端运行报告的上限一致。
- `type` 支持 `feed`、`arxiv`、`github_releases`、`hackernews`、`ainews`；`category` 必须使用上面七个值之一。`ainews` 为 AINews 专用正文节选适配器，不适用于任意网页。
- 添加前确认真实入口、允许的用途、是否需授权，运行 `scripts/collect.py --dry-run` 实测。能解析但最近没有更新，应记录零条，不伪造新鲜度。
- 固定最多四源并发，每源独立超时/重试；输出按配置顺序合并，避免并发完成顺序改变跨源去重归属。HN 内部继续限速串行读取，避免过多请求。
- 全部来源仍保持每日采集一次。媒体 Feed 本身通常只暴露最近 10–30 条，日更可能错过两次采集之间被挤出 Feed 的内容；增加源数不等于完整覆盖或实时跟踪。
- API 默认每源最多 3 条，支持分类、分页、单源深挖。`has_more` 只描述当前过滤和每源上限内是否还有下一页，不表示源内文章已全部读完。
- Cloudflare Worker 导入来源分类表，修改来源后也要更新部署，避免采集器与 API 的分类表不一致。
- 按七类分别取每源两条的日报候选，通常比把所有来源的大量摘录一次塞给 WorkBuddy 更省上下文与积分。

## 暂不默认接入

- **X、Reddit 等直接平台接口**：与已接入的二手摘要不同，仍需要分别核实访问权限、费用和数据使用条款。不能因为网站公开可见就绕过平台访问规则。
- **Anthropic、Mistral 等未验证的官方 RSS**：不编造入口。第三方生成的 Feed 可以另行评估，但必须明确标注镜像维护方，不能称为官方数据接口。
- **长期低频博客**：可以替换到配置里，但不要为凑数量把多年不更新的源说成最新资讯来源。
