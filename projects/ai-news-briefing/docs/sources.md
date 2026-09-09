# 信息源清单与扩展规则

默认配置为 `sources.json`，共 **27 个源、6 类**。以下链接是实际配置的采集入口，不是示例地址；每个源的成功、失败、零条结果由运行报告如实记录。

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

## 开源项目发布 · `releases`（6）

| 来源 | 官方项目 | 采集入口 |
|---|---|---|
| vLLM Releases | [vLLM](https://github.com/vllm-project/vllm) | [Releases API](https://api.github.com/repos/vllm-project/vllm/releases) |
| Ollama Releases | [Ollama](https://github.com/ollama/ollama) | [Releases API](https://api.github.com/repos/ollama/ollama/releases) |
| Transformers Releases | [Transformers](https://github.com/huggingface/transformers) | [Releases API](https://api.github.com/repos/huggingface/transformers/releases) |
| LangChain Releases | [LangChain](https://github.com/langchain-ai/langchain) | [Releases API](https://api.github.com/repos/langchain-ai/langchain/releases) |
| llama.cpp Releases | [llama.cpp](https://github.com/ggml-org/llama.cpp) | [Releases API](https://api.github.com/repos/ggml-org/llama.cpp/releases) |
| PyTorch Releases | [PyTorch](https://github.com/pytorch/pytorch) | [Releases API](https://api.github.com/repos/pytorch/pytorch/releases) |

使用 [GitHub 官方 Releases API](https://docs.github.com/en/rest/releases/releases)，不用未受正式支持的 `releases.atom`。每次请求 `per_page=25`，排除草稿和预发布，再按近 30 天保留，因此并不保证覆盖每一个稳定版本。例如仓库近期全部发布 nightly/prerelease 时，该源会返回零条；这是筛选结果，不是假装抓取失败。

GitHub Actions 的只读 `GITHUB_TOKEN` 用于提高配额，由平台自动提供，不需要用户填写新的 PAT。代码只在 URL 严格匹配 `https://api.github.com/repos/<owner>/<repo>/releases` 时才使用该凭据，所有带凭据的重定向都被拒绝。其他来源不收到它。本地没有该环境变量时使用匿名读取，可能遇到 GitHub IP 共享限流。

## 科技媒体 · `media`（5）

| 来源 | 入口 | 主要内容 |
|---|---|---|
| TechCrunch | [RSS](https://techcrunch.com/feed/) | 科技公司、创业、融资与 AI |
| Ars Technica | [官方目录列出的 Feed](https://feeds.arstechnica.com/arstechnica/index) | 技术、硬件与科学 |
| The Verge | [Feed](https://www.theverge.com/rss/index.xml) | 科技产品、平台与行业 |
| MIT Technology Review | [RSS](https://www.technologyreview.com/feed/) | 技术影响与研究报道 |
| IEEE Spectrum AI | [AI 主题 RSS](https://spectrum.ieee.org/feeds/topic/artificial-intelligence.rss) | AI、机器人与工程 |

只读取公开 Feed，不代表可以绕过文章付费墙、下载全文或再分发。公开运营前须核查各自许可；例如 [TechCrunch 有专门的 RSS 条款](https://techcrunch.com/rss-terms-of-use/)。保持原文链接和来源归属，不把媒体报道伪装成官方发布。

## 开发者社区与个人观察 · `community`（2）

| 来源 | 入口 | 主要内容 |
|---|---|---|
| Hacker News | [官方 API](https://hacker-news.firebaseio.com/v0/) | 前 15 条热门技术故事，不采集全站评论 |
| Simon Willison | [作者 Feed](https://simonwillison.net/atom/everything/) | AI 工具实践、评测、链接与个人观察 |

个人意见、社区热度、转述链接不构成事实验证。Simon 的 Feed 包含文章、短笔记、引用等不同类型；日报要保留这个区别。

## 来源扩展与成本控制

- 修改 `sources.json` 增加/替换来源，保持名称唯一。最多 30 个源，与服务端运行报告的上限一致。
- `type` 支持 `feed`、`arxiv`、`github_releases`、`hackernews`；`category` 必须使用上面六个值之一。
- 添加前确认真实入口、允许的用途、是否需授权，运行 `scripts/collect.py --dry-run` 实测。能解析但最近没有更新，应记录零条，不伪造新鲜度。
- 固定最多四源并发，每源独立超时/重试；输出按配置顺序合并，避免并发完成顺序改变跨源去重归属。HN 内部继续限速串行读取，避免过多请求。
- 全部来源仍保持每日采集一次。媒体 Feed 本身通常只暴露最近 10–30 条，日更可能错过两次采集之间被挤出 Feed 的内容；增加源数不等于完整覆盖或实时跟踪。
- API 默认每源最多 3 条，支持分类、分页、单源深挖。`has_more` 只描述当前过滤和每源上限内是否还有下一页，不表示源内文章已全部读完。
- Cloudflare Worker 导入来源分类表，修改来源后也要更新部署，避免采集器与 API 的分类表不一致。
- 按六类分别取每源两条的日报候选，通常比把所有来源的大量摘录一次塞给 WorkBuddy 更省上下文与积分。

## 暂不默认接入

- **X、Reddit、LinkedIn 等**：需要分别核实访问权限、费用和数据使用条款。不能因为网站公开可见就绕过平台访问规则。
- **Anthropic、Mistral 等未验证的官方 RSS**：不编造入口。第三方生成的 Feed 可以另行评估，但必须明确标注镜像维护方，不能称为官方数据接口。
- **长期低频博客**：可以替换到配置里，但不要为凑数量把多年不更新的源说成最新资讯来源。
