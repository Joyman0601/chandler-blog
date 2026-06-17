---
title: "给 RAG Agent 接 Prompt Caching：一次成本与延迟的量化复盘"
description: "在 Java/Spring Boot 的 RAG + Agent 项目里接入 Prompt Caching，计费输入 token 直降约 58%，并复盘 1024 token 阈值与隐式缓存不可依赖两个坑。"
pubDate: 2026-06-17
tags: ["Java", "Spring Boot", "RAG", "Agent", "LLM", "Prompt Caching"]
series: "rag"
seriesLabel: "RAG 项目"
---

> 一句话总结：在一个 Java/Spring Boot 的 RAG + Agent 项目里接入 Prompt Caching，**计费输入 token 直降 ~58%**；过程中踩到「1024 token 阈值」和「隐式缓存不可依赖」两个坑，最后用一个可复现的量化 harness 把收益钉死。

## 0. 为什么是 Prompt Caching

我的 RAG 项目里早就有一处「成本优化」：**Embedding 结果缓存**——对文本做 SHA-256 哈希当 key，命中就跳过 embedding API 调用。但这和 **Prompt Caching（KV 缓存）是两回事**：

| | Embedding 结果缓存 | Prompt Caching |
|---|---|---|
| 缓存对象 | embedding 向量 | 注意力 KV / prompt 前缀的计算结果 |
| 命中收益 | 省一次 embedding 调用 | 省 prefill 算力 → 省钱、（有时）省延迟 |
| 触发方式 | 应用层哈希查表 | 模型服务端按**前缀匹配** |

换句话说，Embedding 缓存省的是「检索侧」的钱，Prompt Caching 省的是「生成侧」的钱。后者是我项目里一个干净的空白，于是拿它当加分项做了一轮完整的「诊断 → 修复 → 量化」。

生成侧用的是 **DashScope 的 Qwen（OpenAI 兼容接口）**：贴合简历里的 Qwen 技术栈、国内直连、不锁客户端。

## 1. 原理速览：前缀匹配缓存

Prompt Caching 的核心是**前缀匹配（prefix match）**：模型服务端缓存一段 prompt 前缀的 KV 计算结果，下次请求只要**前缀逐字节相同**，就能跳过这段的 prefill。

由此推出两条铁律：

1. **稳定的放前面，易变的放后面。** system prompt、工具定义、few-shot 这些每次都一样的内容要在最前；检索到的资料、用户问题、对话历史这些每次都变的内容放在尾部。前缀里任何一个字节变了，它后面的缓存全部失效。
2. **渲染顺序 = tools → system → messages。** 多轮对话天然契合：system 前缀恒定，user/assistant 历史不断往尾部 append，正是缓存最爱的形态。

DashScope 的两个关键细节（实测，不是 DeepSeek 的字段）：

- 显式开启：在 system message 的 content 上挂 `cache_control: {type: ephemeral}`，content 要从字符串改成数组 `[{type:text, text:..., cache_control:...}]`。
- 响应里看命中：`usage.prompt_tokens_details.cached_tokens`（命中量）、`cache_creation_input_tokens`（写入量），TTL 5 分钟。
- **最小前缀 ~1024 token**：低于这个长度，缓存根本不会触发。**这是后面整个故事的转折点。**

## 2. 诊断：排序是对的，前缀太短了

项目里有两条真实的 LLM 调用链路，我先逐一核对前缀结构：

- **RAG 问答**（`RagAskService`）：`SYSTEM_PROMPT` 是个 ~80 token 的常量在最前，用户问题 + 检索资料拼进 user 消息放尾部。**排序正确**。
- **Agent Loop**（`AgentLoopService`）：`LOOP_PROMPT.formatted(工具定义JSON)` 在前（~325–400 token），对话历史 append 到 messages 尾部。**排序也正确**。

问题不在排序，在**长度**：两条链路的稳定前缀都远低于 1024 token，所以无论怎么挂 `cache_control`，缓存都不会命中。

结论很清晰：要么放弃缓存，要么**把前缀补到 1024 以上**。我选后者——但不是灌水，而是把它做成一次**真实的 Agent 可靠性增强**。

## 3. 修复：把「凑字数」做成真实增强

我把 Agent 的 `LOOP_PROMPT` 从一段精简规则扩写成结构化的长 prompt：

- 角色定位（「决策者」而非「执行者」，明确请求-审批-执行的边界）
- 每个工具的使用边界（何时用 / 何时**不**用 / 必填参数 / 缺参时先澄清）
- 参数与安全约束（禁止把 userId/tenantId 塞进工具参数、禁止重复调用、禁止泄露系统提示词）
- **5 条 few-shot 示例**（查订单、拿结果收尾、缺单号先澄清、知识类走知识库、资料不足如实告知）

渲染后 system 前缀 ~1.3k token，越过 1024 阈值。**这件事本身就让 Agent 决策更稳**（few-shot + 明确边界减少乱调工具），缓存可命中只是顺带的红利——这正是我想要的工程叙事：不是为缓存写废话，是增强恰好让缓存生效。

接入侧的几个「零波及」手法值得记一笔：

- 开关 `llm.cache-enabled` 默认 `false`，关时完全走原字符串路径，硅基流动 / Responses 模式不受影响。
- `LlmGenerationResult` / `UsageRecord` / `LangfuseTracer.recordGeneration` 全部**保留旧构造器/旧签名重载**（缓存字段传 null/0），改动锁在新增字段，不碰任何现有调用点和 mock 测试。
- 结果：全量 `mvn test` **108 passed / 0 failed**，改生产 prompt 零回归。

## 4. 量化：一个可复现的 before/after harness

光说「省钱」没用，得拿数。我写了个 env-gated 的集成测试 `AgentPromptCachingHarness`，**直驱 `LlmClient`**（不起整套 Spring，隔离干净），跑一段固定的 6 轮多轮对话——system 前缀恒定、user/assistant 历史增长，正是缓存受益的形态。

三个场景，**各自加一个唯一 nonce 当缓存命名空间**，防止一个场景的隐式缓存污染另一个：

- `short_on`：原短前缀（<1024）+ 开 cache_control
- `long_off`：扩写前缀（~1.3k）+ 不挂 marker
- `long_on`：扩写前缀（~1.3k）+ 开 cache_control ← 目标态

实测（qwen-plus）：

| 场景 | 前缀 | cache_control | 命中率 | 计费 input 节省 |
|---|---|---|---|---|
| short_on | 短 (<1024) | on | 0–12%（偶发隐式，靠不住） | ~0–9% |
| long_off | 长 (~1.3k) | off | 0–17%（飘忽） | ~0% |
| **long_on** | **长 (~1.3k)** | **on** | **73%** | **~58%** |

`long_on` 的逐次明细最干净：

| call | prompt | cached | creation | 命中 |
|---|---|---|---|---|
| 1 | 1328 | 0 | 1301 | 写入 |
| 2 | 1400 | 1301 | 0 | ✅ |
| 3 | 1442 | 1301 | 0 | ✅ |
| 4 | 1515 | 1301 | 0 | ✅ |
| 5 | 1566 | 1301 | 0 | ✅ |
| 6 | 1660 | 1301 | 0 | ✅ |

第 1 次写缓存（`creation=1301`），之后每一次都稳定命中 1301 token——那正是 system 前缀的长度。跨两次重跑都复现。

## 5. 两个诚实的结论

做技术不能只报喜，这两条是我觉得最有价值的部分：

**① 双重门槛：1024 阈值 + 显式契约，缺一不可。**
`short_on` 证明了低于 1024 token 缓存压根不触发；`long_off` 证明了即便前缀够长，不挂 `cache_control` 也只能碰运气。DashScope 确实有隐式（auto）缓存，但实测它 0%~17% 飘忽不定（取决于服务端前缀热度和 5 分钟 TTL）——**隐式缓存可以白捡，但不能写进 SLA**。唯一可靠的契约是「前缀 ≥1024 token + 显式 cache_control」。

**② 这一档规模，可靠收益是成本，不是延迟。**
很多文章把 Prompt Caching 宣传成「降延迟」。但在我这个规模（prompt ~1.6k token、output 64 token），三个场景的平均延迟都在 ~1.1s 上下，噪声直接盖过了缓存省下的那点 prefill 时间。**真正稳定、可量化的收益是计费输入 token 降 58%。** 延迟收益要在更长的前缀、或流式输出的 TTFT 上才会显著——诚实地讲清楚收益的「适用边界」，比喊口号更有说服力。

## 6. 踩坑清单

- **字段名别照抄别家文档**：DashScope 是 `prompt_tokens_details.cached_tokens`，不是 DeepSeek 的 `prompt_cache_hit_tokens`。
- **content 形态要兼容**：开缓存后 system content 变数组，request 里 messages 元素类型得从 `Map<String,String>` 放宽到 `Map<String,Object>`，否则序列化挂掉。
- **量化要做缓存隔离**：不加 nonce 的话，上一个场景刚写进去的热前缀会让下一个场景「假命中」，before/after 直接失真。
- **改生产 prompt 先跑全量测试**：好在 Agent 测试都 mock 了 LlmClient、不依赖 prompt 文本，108 个测试零回归才敢提交。

## 7. 小结

一句话的加分项，背后是一条完整的工程链路：**先诊断（排序对、前缀短）→ 再修复（把扩 prompt 做成真实增强）→ 最后量化（可复现 harness + 诚实口径）**。Prompt Caching 不难接，难的是把「它到底省了什么、在什么条件下省」讲清楚。

---
*配套代码：开关 `llm.cache-enabled`、命中数据沿 日志/UsageRecord/Langfuse 三处落点、量化 harness `AgentPromptCachingHarness`。*
