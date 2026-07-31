---
title: "录屏前的彩排：让我修完三个能毁掉演示的 bug"
description: "录屏前对着脚本做了一次完整彩排，暴露了三处一到面试就会翻车的 bug——Langfuse trace 里 latency 和 cost 都是 0、Agent 处理年假问题稳定报 TOOL_EXECUTION_FAILED、以及 TOKEN_BUDGET_EXCEEDED。每一个单独看都是小问题，但连在一起足以毁掉整场演示。这篇按修复顺序复盘,顺便谈谈「哪些通路能加重试、哪些不能」。"
pubDate: 2026-08-01
tags: ["Agent", "LLM", "重试", "可观测性", "Langfuse", "RAG"]
series: "rag"
seriesLabel: "RAG 项目"
---

> 一句话总结：录屏前我信心满满对着脚本先做了一次彩排——毕竟功能都测过了、Langfuse 也接上了、Agent 三个工具场景也验证过。结果两个小时里连撞三个能毁掉整场演示的 bug：Langfuse UI 里 latency 显示 0 秒（讲「可观测性」时观众看到 0 秒会尴尬）、Agent 处理「公司请年假」稳定报 `TOOL_EXECUTION_FAILED`（讲 Agent 演示时正好翻车）、以及 `TOKEN_BUDGET_EXCEEDED`。这篇按修复顺序复盘，最后聊聊哪些 LLM 通路能加重试、哪些绝对不能。

## 0. 起因：彩排的必要性

录屏脚本是我提前一天写好的，7 分钟 6 段：

1. 首页架构图（30s）
2. Ask 页三模式对比（2min）
3. Agent 页三工具授权（2min）
4. RAGAS 评估结果（1min）
5. Langfuse trace 展示（1min）
6. 收尾（30s）

按脚本从头走到尾要 8-10 分钟（含解说），我打算录 3-5 遍剪一个最好的。第一遍开始：

- 段 1 首页架构图 → OK
- 段 2 三模式对比 → OK
- 段 3 Agent 演示「公司请年假」→ **报错 `TOOL_EXECUTION_FAILED`**
- 段 5 Langfuse trace → **latency: 0ms, cost: $0.00**

一段废掉、一段观感极差。要不是彩排先跑一遍，明天面试对着录屏讲 Langfuse 那段就直接抓瞎。

## 1. Bug 1：Langfuse UI 里 latency = 0 和 cost = 0

**现象**：Langfuse 面板打开，随便挑一条 trace，右上角显示 `Latency: 0ms`、`Cost: $0`。子 generation 里 token usage 有值、内容也完整，就是耗时和成本全零。

**排查**：我的 `LangfuseTracer.buildGenerationEvent` 里长这样：

```java
private Map<String, Object> buildGenerationEvent(
    String traceId, String genId, String model,
    Object input, Object output, long latencyMs, Usage usage) {
  return Map.of(
    "type", "generation-create",
    "body", Map.of(
      "id", genId,
      "traceId", traceId,
      "model", model,
      "input", input,
      "output", output,
      "startTime", Instant.now(),      // ← 两个都是 now
      "endTime", Instant.now(),        // ← 完全没用到 latencyMs
      "usage", usage,
      ...
    )
  );
}
```

我在参数里传了 `latencyMs`——LLM 调用时用 `System.currentTimeMillis()` 记的起止时间差——但**根本没塞进事件体**。startTime 和 endTime 都取 `Instant.now()`，Langfuse UI 拿两者相减自然是 0。cost 也归零是因为 Langfuse 部分内部逻辑按 latency 比例呈现的。

**修复**：从 endTime 倒推 startTime：

```java
Instant endInstant = Instant.now();
Instant startInstant = endInstant.minusMillis(Math.max(0L, latencyMs));

return Map.of(
  "body", Map.of(
    ...
    "startTime", startInstant,
    "endTime", endInstant,
    ...
  )
);
```

**为什么倒推而不是提前记 startTime？** 因为 `LangfuseTracer.recordGeneration` 是在 LLM 调用**完成后**才被调用的——SDK 拿到的是「已经花了 300ms」这个事实，不是「300ms 前」这个时间点。倒推最方便，也不需要在 LLM 调用前后各插一个埋点。

**单测**：

```java
@Test
void generationBody_startTimeIsLatencyMsBeforeEndTime() {
  Map<String, Object> event = tracer.buildGenerationEvent(
      "trace-1", "gen-1", "qwen-plus", input, output, 300L, usage);

  Map<String, Object> body = (Map) event.get("body");
  Instant start = (Instant) body.get("startTime");
  Instant end = (Instant) body.get("endTime");

  long actualMs = Duration.between(start, end).toMillis();
  assertThat(actualMs).isBetween(290L, 310L);  // ±10ms 容忍
}
```

**面试口径**：Langfuse UI 是从 event 事件体的 `startTime` / `endTime` 减出 latency 的，**不是从 SDK 侧上报的 `latencyMs` 字段直接展示**。埋点时得同时给两个时间戳，不能只给耗时。这是可观测性 SDK 里常见的**「传的和展示的字段错位」**问题。

## 2. Bug 2：Agent「公司请年假」稳定报 TOOL_EXECUTION_FAILED

**现象**：Agent 页选「公司请年假流程是什么」，稳定失败。日志：

```
com.yhl.rag.llm.LlmException: Embedding 接口调用失败：Connection reset
  at com.yhl.rag.llm.EmbeddingClient.embed(EmbeddingClient.java:87)
  ...
Caused by: java.net.SocketException: Connection reset
```

工具 `search_knowledge_base` 因为外部 embedding API 抖了一下（`Connection reset`）就直接抛错，整个 Agent 循环崩掉。

**根因**：外部 API 调用**没有重试机制**。DashScope 的 embedding 服务偶尔有 RST 包，几十毫秒内的抖动，正常应该重试一次就成功。但我的 `EmbeddingClient.embed` 里是 JDK `HttpClient.send` 直调，抛错就往上抛。

**修复**：加**有选择的一次重试**：

```java
private HttpResponse<String> sendWithOneRetry(HttpRequest request)
    throws IOException, InterruptedException {
  try {
    return client.send(request, HttpResponse.BodyHandlers.ofString());
  } catch (IOException ex) {
    if (isRetriableIoError(ex)) {
      log.warn("Embedding IO error, retrying once: {}", ex.getMessage());
      try {
        Thread.sleep(300L);
      } catch (InterruptedException ie) {
        Thread.currentThread().interrupt();
        throw ie;
      }
      return client.send(request, HttpResponse.BodyHandlers.ofString());
    }
    throw ex;
  }
}

private boolean isRetriableIoError(IOException ex) {
  // Connection reset / RST 等瞬时错误重试
  // Timeout / 主动中断 / 业务错不重试
  if (ex instanceof HttpTimeoutException) return false;
  if (ex instanceof InterruptedIOException) return false;
  String msg = ex.getMessage();
  return msg != null && (msg.contains("Connection reset")
                      || msg.contains("Broken pipe")
                      || msg.contains("Connection closed"));
}
```

关键在于「**有选择**」——不是所有错误都重试：

| 错误类型 | 重试? | 原因 |
|---|---|---|
| Connection reset / RST | ✅ | 瞬时网络抖动，重试通常能过 |
| Broken pipe | ✅ | 类似瞬时 |
| HttpTimeoutException | ❌ | 服务端已经在慢，重试只会让情况更糟 |
| HTTP 4xx | ❌ | 业务错，重试没用 |
| HTTP 5xx | ❌ | 服务端错，短时间重试大概率还错 |
| LlmException（自己抛的） | ❌ | 业务层已经判定是错，重试放大成本 |
| InterruptedException | ❌ | 上层要中断，别继续 |

`RerankClient` 用同一套 helper。

## 3. 为什么 chat 通路**故意不加**重试

写完 embed 和 rerank 的重试，我特意确认了一下 `LlmClient.generateWithUsage` / `streamChat`——**这两个 chat 通路完全不加重试**。

原因是 chat 调用**不是幂等**的：

- **每次都可能返回不同结果**：LLM 生成本身有随机性（temperature > 0）。
- **成本会翻倍**：每次 chat 调用都要过 token 计费，重试一次就是两次成本。
- **观测会错位**：重试成功了显示 200ms 完成，实际用户等了 400ms（等了两次 API）。

Embedding 就没这些问题——同样的输入必然生成同样的向量，重试成本是「一次 embed 请求」（比 chat 便宜 100 倍），观测上重试也没什么可展示的（用户不关心 embedding 花了多久）。

**面试口径**：这是**「什么时候能加重试」**的清晰边界。判断标准是三个：**幂等性、成本、可观测**。三个都过关（embed/rerank）才能加，任何一个不过关（chat）就绝对不加。这个判断标准我以前只在 REST API 层用过，这次在 LLM 通路里再验证了一遍。

## 4. Bug 3：TOKEN_BUDGET_EXCEEDED

修完 Bug 2，「公司请年假」不报 TOOL_EXECUTION_FAILED 了。跑一遍——**新报 `TOKEN_BUDGET_EXCEEDED: 2650 > 1500`**。

**现象**：Agent 循环走了两步：
1. 第 1 步：调 `search_knowledge_base` 检索「公司请年假」，返回 3 篇 chunk。
2. 第 2 步：把 observation（3 篇 chunk 拼接）塞进 user message 生成最终答案，token 预算 checker 报 2650 tokens 超了 1500 的上限。

**根因**：我把 chat/RAG/Agent 三条通路的 token 预算全部用同一个配置 `chatMaxInputTokens=1500`。这个 1500 是给 RAG 单轮 ask 设的——system + user question 一般 500 tokens 够了。**但 Agent 通路不一样**——它每一步都要把 tool observation 累积到上下文里，一个 3 chunk 的 observation 就 2000+ tokens 常态。

用一个预算兜三条通路，最短板决定天花板。

**修复**：Agent 独立预算：

```java
@ConfigurationProperties(prefix = "cost")
public record CostProperties(
    long chatMaxInputTokens,           // RAG/chat 通路,保持 1500
    long agentMaxInputTokens,          // Agent 独立通路,4000
    long maxOutputTokens
) {}
```

`AgentLoopService` 和 `AgentChatService` 里的 `checkBeforeLlm` 三处调用点全部切到 `agentMaxInputTokens`：

```java
tokenBudget.checkBeforeLlm(estimatedTokens, props.agentMaxInputTokens());
```

`RAG` 通路（`RagAskService`）的 1500 完全不动——RAG 单轮 ask 没必要放宽。

## 5. 修完 token 又撞字符预算——第二层护栏

以为 Bug 3 修完了，rebuild、部署、再跑「公司请年假」。**新的报错**：

```
LlmException: 输入长度超限：3183 > 2000 (maxInputChars)
  at LlmClient.validateInputLength(LlmClient.java:120)
```

我以为 token 预算就够了，没意识到还有**第二层护栏**：`LlmClient.validateInputLength` 里有个 `maxInputChars=2000` 的字符预算。这是我很早期加的 **defensive coding**——挡「万一 token 估算错了、或者输入是奇怪字符导致 token 少但字符多」的边缘情况。

Agent observation 塞了 3 篇年假 md chunk 拼接的 3000+ 字符，直接撞上这个护栏。

**修复**：`docker-compose.prod.yml` 里补透传 `LLM_MAX_INPUT_CHARS`：

```yaml
app:
  environment:
    LLM_MAX_INPUT_CHARS: ${LLM_MAX_INPUT_CHARS:-8000}    # 补透传
    LLM_MAX_OUTPUT_TOKENS: ${LLM_MAX_OUTPUT_TOKENS:-2000}
```

`.env.prod` 里 `LLM_MAX_INPUT_CHARS=8000` 早就设了，但**没在 compose.yml 的 environment 段显式列出，就不会透传进容器**——docker compose **不做隐式全量注入**，`.env` 只是 shell 变量的插值来源，不是自动 env 注入。

这个坑我在部署那篇里已经吐槽过一次，这里再撞一次。教训是：`.env.prod` 里加了新变量，`compose.yml` 里也要跟着显式列一遍。

**面试口径**：**双层预算是必要的**。token 预算限 LLM 侧成本，字符预算是 defensive coding 挡畸形输入。两道预算是独立护栏——token 是内容语义维度，字符是输入体积维度。Agent 循环的 observation 会累积长文本，两个维度都要给 Agent 单独放宽，不能和 chat/RAG 共用。

## 6. 最终验收

三个 bug 全部修完，四条 commit 顺次推上去，服务器 `dcp up -d --build`。彩排第二遍：

- 段 1-2：OK
- 段 3 Agent「公司请年假」：**跑通了**，Agent 3 步返回完整流程答案，`stopReason: SUCCESS`
- 段 5 Langfuse trace：**latency 显示 4.2s，cost 显示 $0.0012**（qwen-plus 定价）

段 5 的 chat 气泡也正常显示（这个是[自建 Langfuse 那篇](/blog/rag-langfuse-selfhost/)里的第 6 个坑修的），Agent 那段的 sources 也命中了年假 md。

彩排一共花了 2 小时——1 小时修 bug + 1 小时来回部署 + 排 env 透传。第二天正式录屏一遍过，7 分钟按脚本走完。

## 收尾

回头看这次彩排暴露的三个 bug，共性是**「本地跑得挺好、上线后特定场景才翻车」**：

- **Bug 1**（Langfuse latency=0）：本地 SDK 上报了、DB 里有值、只是 UI 展示逻辑跟我以为的不一样。**触发条件是「用户认真看 UI 才发现」**——彩排前我根本没细看 latency 数字。
- **Bug 2**（Connection reset）：本地网络稳定基本不复现，云上访问 DashScope 偶尔抖一下就翻车。**触发条件是「跨公网 API」**。
- **Bug 3**（token 超限）：小知识库的 chunk 短，observation 加起来也就 800 tokens，不撞预算；生产的 5 篇脱敏 md 里年假那篇特别长，3 chunk 拼起来就爆。**触发条件是「文档长度分布」**。

三个 bug 都不是「代码写错」这种低级错误——都是「假设跟实际对不上」。这也是我这次学到最重要的一课：**彩排是必要的，因为很多 bug 只有在「按用户视角完整走一遍」时才会暴露**。单元测试测不出 Langfuse UI 展示问题，集成测试测不出跨公网抖动，本地 debug 测不出文档长度分布。

面试如果被追问「你的项目上线前是怎么做质量保障的」，除了讲测试覆盖率、CI/CD，我最想强调的是这次彩排——**「按面试官的视角完整走一遍」比任何单点测试都能发现问题**。这是从生产事故里学的，也是这次录屏 3 小时投入里最值得的一部分。
