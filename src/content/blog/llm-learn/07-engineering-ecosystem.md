---
title: "工程化与生态：LangChain、MCP 与 Langfuse 可观测性"
description: "收尾整条路线：LangChain/LlamaIndex 到底解决了什么、什么时候可以主动选择不用、MCP 协议为什么重要，以及如何用 Langfuse 给 RAG 链路接入可观测性——和后端的链路追踪经验直接对应。"
pubDate: 2026-06-08
tags: ["LangChain", "MCP", "Langfuse", "可观测性"]
series: "llm-learn"
seriesLabel: "大模型应用岗学习"
---

> 系列第 7 篇，收尾。前面都在搭功能，这一篇看「生态」：业界的轮子解决了什么问题、什么时候该用什么时候可以不用，以及怎么让一个 LLM 系统变得可排查、可监控——这正好和后端的工程经验接得上。

## LangChain / LlamaIndex 解决了什么

它们是 LLM 应用的「积木库」，把 Retriever、Chain、Agent、Memory、DocumentLoader 这些常用组件封装好，用来快速搭原型。

如果一个项目是手搓的，它的每个组件其实都能在框架里找到对应：

| LangChain 组件 | 手搓等价物 |
|---|---|
| Retriever | 检索服务 |
| Chain | LLM 客户端 + 管道 |
| Agent / Tool | Agent Loop + 工具注册表 |
| Memory | 会话状态服务 |

### 什么时候可以主动选择不用

「没用框架」不一定是短板，可以是主动选择。当项目有一些**企业级需求**——灰度发布、Human-in-the-Loop 确认、多租户权限隔离、成本管控——框架在这些方面要么没有现成支持，要么需要大量定制。

这种情况下手搓反而更可控：能用完整的测试覆盖保证质量，也能真正理解每一层的原理。框架适合快速起步和通用场景，定制化、强管控的系统则可能手搓更合适。**关键是知道取舍的依据，而不是无脑站队。**

## MCP（Model Context Protocol）

**解决什么**：同一个工具（查数据库、读文件、调某个 SaaS）要接进不同的 AI 应用，以前每个应用都得单独写一遍对接代码。MCP 统一的是工具服务和 AI 应用之间的协议：应用是宿主（host），工具以 MCP server 的形式提供，双方用 JSON-RPC 通信，`tools/list` 列工具、`tools/call` 执行工具。**工具服务实现一次，支持 MCP 的应用都能接**。

它不统一模型侧的 tool calling 格式。模型怎么表达「我要调这个工具」，仍然是各家 API 自己的格式（OpenAI 一套、Anthropic 一套）。宿主负责中间的翻译：把 MCP server 列出的工具转成模型 API 要的工具定义，模型提出调用后，再转成 `tools/call` 发给对应的 server。MCP 官方文档也写明，它只管上下文交换的协议，不规定应用怎么用 LLM。

> USB 比喻：以前每个设备有自己的充电口，MCP 就像 USB，统一的是设备和电脑之间的接口；电脑内部怎么处理，各家照旧。

如果项目里已经有手搓的工具注册表 + 工具定义（JSON Schema）+ 工具执行服务，那它在宿主一侧已经做了 MCP 要做的事。迁移到 MCP，就是把工具执行服务包成 MCP server，或者让应用作为 MCP 宿主去接现成的 server。

## LLM 可观测性：Langfuse / LangSmith

**为什么需要**：LLM 应用出了问题（奇怪的答案、异常的高成本），普通日志查不清——你需要知道每一次 LLM 调用的完整 prompt 和原始输出、token 成本，以及 RAG 链路每一步的质量。

如果你做过后端的链路追踪，这个类比会很顺（后端这边的做法见 [可观测性：微服务出了问题怎么定位](/blog/ms-learn/08-observability/)）：

| Langfuse | 链路追踪（如 Zipkin） |
|---|---|
| 每次 LLM 调用记录完整 prompt + 输出 | Span 记录每次微服务调用 |
| token 用量和费用统计 | 响应时间和吞吐 |
| RAG 链路可视化 | 调用链瀑布图 |

### 结构化日志已经够了吗

很多项目已经有结构化日志，能记录每一步的工具名、延迟、成功与否、token 数——靠它已经能定位「错误出在哪一步」。

Langfuse 真正的**增量价值**是结构化日志做不到的两点：

1. **完整 prompt + LLM 原始输出可视化** —— 出了奇怪答案时，能直接在 UI 里拉到模型当时看到的完整上下文，可复现。普通日志一般不会把整段 prompt 存下来。
2. **token 成本 dashboard** —— 现在只能看账单总额，Langfuse 能按 trace / 请求类型看成本分布，知道哪类请求最烧钱。

### 一个干净的接入点

接入时有个小技巧：**在 LLM 调用的唯一出入口埋点**，按 requestId 把一次请求串成一条 trace。这样一处埋点就能覆盖 RAG、Agent、Query 改写所有走 LLM 的路径，不用到处插桩。

工程上注意两点：埋点要异步、fire-and-forget，失败只 warn 不影响主链路；另外某些 HTTP 客户端默认走 HTTP/2，和部分 Langfuse 部署不兼容，需要强制 HTTP/1.1。自建 Langfuse 时踩过的坑见 [自建 Langfuse 反代到公网](/blog/rag-langfuse-selfhost/)。

## 整条路线收尾

到这里，这条学习路线走完了一圈：

- **Phase 0** 打基础直觉。
- **Phase 1~2** 把检索做扎实并量化（招牌）。
- **Phase 3** 讲清 Agent 原理。
- **Phase 4** 拓展进阶检索范式。
- **Phase 5** 跳出「只会调 API」。
- **Phase 6** 补上工程生态。

贯穿始终的三条原则没变：不脱离项目空学、有量化才有结论、每阶段输出一篇。技术名词谁都能背，但「在这个系统里，这一层解决什么问题、代价是什么、什么时候才该上」——这才是真正能落地的能力。
