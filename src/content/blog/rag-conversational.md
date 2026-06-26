---
title: "多轮会话 RAG：让「它的价格呢」也能被检索读懂"
description: "单轮 query 改写只看当前这一句，但真实多轮对话里追问几乎都带指代——「它的内存呢」拿去检索，「它」没有任何文档锚点，向量召回基本打空。这篇做结合历史的指代消解改写 + 历史压缩。12 组指代追问的实测里，turn-2 的 Hit@3 从 50% 提到了 100%。默认关，无 conversationId 时回退单轮，零回归。"
pubDate: 2026-06-26
tags: ["Java", "Spring Boot", "RAG", "多轮对话", "Query 改写", "指代消解"]
series: "rag"
seriesLabel: "RAG 项目"
---

> 一句话总结：单轮 query 改写只看当前一句，但真实多轮对话里追问几乎都带指代——「它的内存呢」拿去检索，「它」没有文档锚点，向量召回基本打空。这篇在单轮改写之上加一层**对话式改写**：结合最近几轮历史，把追问里的指代消解成自包含 query（「它的内存呢」→「ThinkPad X1 的内存大小」）；会话变长时把早期轮压成滚动摘要控 token。12 组指代追问实测，turn-2 的 Hit@3 **从 50% 提到 100%**。默认关、无 conversationId 时回退单轮，零回归。

## 0. 起因：代词拿去检索会打空

我项目里早就有单轮 query 改写（`QueryRewriterService.rewrite(String)`），但它只看当前这一句。问题出在多轮对话的追问上：

- 第 1 轮：「ThinkPad X1 的价格是多少？」→ 答「9999 元」。
- 第 2 轮：「**它的**内存呢？」

第 2 轮单独拿去检索，「它」没有任何文档锚点，向量召回基本是打空的。人能秒懂「它 = ThinkPad X1」，是因为脑子里存着上文。要让检索也懂，就得**把历史喂进去做指代消解**，把「它的内存呢」改写成「ThinkPad X1 的内存大小」再检索。

还有个连带问题：**历史会无限增长**。对话几十轮后，把全部历史塞进改写 prompt 又贵又超长。所以超过阈值时要把早期轮次**压成摘要**，只留最近 N 轮原文 + 一段滚动摘要。

## 1. 架构：在单轮改写上加一层

我没有另起炉灶，而是复用现有的 `QueryRewriterService`（它已经持有 `LlmClient` 和配置），加两个方法：

```java
// 结合历史的指代消解改写。会话关 / 总开关关 / 历史空 → 回退单轮 rewrite(question)；失败降级原问题。
String rewrite(String question, ConversationHistory history);

// 把已有摘要 + 较早轮次压成新摘要。无可压缩轮次 → 返回原摘要；LLM 失败/空 → 返回 null。
String summarizeHistory(String existingSummary, List<ConversationTurn> turnsToSummarize);
```

会话历史我新建了一个**轻量内存 store**，而不是复用退款 Agent 那套 `ConversationState`：

```java
ConversationTurn(userMessage, assistantMessage)        // 一轮问答
ConversationHistory(summary, recentTurns)              // 滚动摘要 + 最近若干轮原文
ConversationHistoryStore                               // ConcurrentHashMap, key = userId:conversationId
```

为什么不复用 `ConversationState`？它是退款 Agent 的会话态（currentOrderId / pendingConfirmationId / lastTool），字段和「问答轮历史」语义对不上，硬塞会把两个领域耦在一起。各管各的更干净。

改写时喂给 LLM 的 user 消息长这样：

```
对话历史摘要：
<summary>                ← 仅当有摘要时

最近对话：
用户：ThinkPad X1 的价格是多少
助手：ThinkPad X1 售价 9999 元

当前追问：它的内存呢
```

system 是固定的对话式改写说明，LLM 只输出改写后的 query，比如「ThinkPad X1 的内存大小」。

## 2. 接入问答链路：客户端只多带一个 conversationId

`RagAskService` 新增 `ask(question, conversationId, debug)`，旧的 `ask(question)` 委派进来传 `conversationId=null`（零回归）。核心逻辑：

```
conversational = 会话开关开 && conversationId 非空
retrievalQuery = conversational
    ? rewrite(question, store.get(userId, conversationId))   // 指代消解
    : rewrite(question)                                       // 单轮（与改造前完全一致）
... 检索 + 生成 ...
if (conversational) recordTurn(userId, conversationId, question, answer)  // 自动记录本轮
```

我比较满意的一点是**自动记录**：拿到 `conversationId` 且会话开着时，`ask` 在成功生成答案后会自动把 `(question, answer)` 追加进 store，下一轮就能用来指代消解。**客户端每轮只需要带同一个 conversationId**，不用额外调任何记录接口。Controller 那边也只多透传一个字段。

**历史压缩**放在 `recordTurn` 里：追加后如果累计轮数超过 `summary-threshold`，就把最旧的几轮交给 `summarizeHistory` 压成摘要，只保留最近 `history-turns` 轮原文。

配置嵌在 `query-rewrite` 下，做成分层开关：

```yaml
rag:
  query-rewrite:
    enabled: false                  # 单轮改写总开关
    conversation:
      enabled: false                # 多轮指代消解，需上面 enabled=true 作前提
      history-turns: 5              # 改写纳入 & 压缩后保留的最近轮数
      summary-threshold: 10         # 累计超过此轮数触发早期轮摘要
```

## 3. 零回归与降级

默认 `conversation.enabled=false`，`ask` 永不触碰 store，检索 query 走 `rewrite(question)`，与改造前逐字节一致。开启后任一不利条件都降级到「更弱但正确」的行为：

| 条件 | 行为 |
| --- | --- |
| 会话开关关 / 总开关关 | 回退单轮 `rewrite(question)` |
| 无 conversationId / 空历史 | 回退单轮改写（首轮天然无历史，即走此路） |
| 改写 LLM 抛异常 / 返回空 | 降级返回**原追问** |
| 摘要 LLM 抛异常 / 返回空 | 放弃本次压缩、**保留完整历史** |

有两个降级我想强调一下，因为它们体现了「宁可弱一点也别出错」的取舍：

- **改写失败返回原追问**，而不是报错中断——大不了这一轮检索差点，对话不能断。
- **摘要失败就放弃压缩、保留完整历史**。压缩本质是「删原文换摘要」，如果摘要没生成成功就把原文删了，等于凭空丢上下文。宁可让历史暂时偏长（下一轮再试压缩），也绝不丢信息。

这个降级理念和我之前的单轮改写、[Contextual Retrieval](/blog/rag-chunking-parent-contextual/) 是一脉相承的：增强类功能失败时，回退到「未增强」的正确路径。

## 4. 量化：Hit@3 从 50% 到 100%

这次我跑了**真实端点**的端到端实测，不是编的。

原来的评估集（53 题）多是单轮，量不了多轮，所以我另建了 `conversational-questions.json`——**12 组「指代追问对」**：turn-1 自包含建立实体（「病假需要提交什么材料？」），turn-2 用代词/省略追问同一实体（「那它的工资怎么算？」），期望文档是同一篇。

harness（`ConversationalRetrievalHarnessTest`）入库 51 篇真实语料后，对每组：先真实跑 turn-1 拿到答案写进会话历史，再对 turn-2 比两条检索路径的 Hit@3——

- **baseline**：turn-2 原样检索（指代没消解）；
- **treatment**：用历史做对话式改写，把指代消解成自包含 query 再检索。

结果（语料 51 篇 / 12 组 / top-K=3）：

| 路径 | turn-2 Hit@3 | 命中数 |
| --- | --- | --- |
| baseline（追问原样检索） | 50.0% | 6/12 |
| **treatment（会话改写后检索）** | **100.0%** | **12/12** |

指代消解把追问轮的检索命中率 **+50pp**。6 个 baseline 漏召的，正是代词最重的那几个追问——「那它的工资」「它需要上传什么证明」「那男员工的呢」「它需要经过谁审批」……改写成「病假期间的工资计算方式」「男员工陪产假有多少天」这种自包含 query 后，全部召回。

> **诚实标注**：① 这轮 embedding 走 DashScope `qwen3-vl-embedding`（真端点）；改写和答案的 chat 模型本来想走我默认的 relay，当时返回了 HTTP 402（无可用订阅），临时改用 DashScope 的 `qwen-plus` 跑通——换更强的模型只会更准，不影响「指代消解能提召回」的结论方向。② n=12 是小样本，演示量级，不是统计严谨的评测；想扩样只要往 json 里加追问对就行。

## 5. 写在最后

多轮会话 RAG 这件事，难点其实不在「调 LLM 改写」本身，而在想清楚几个边界：

- 历史**存原话还是存改写后的 query**？存原话——因为下一轮的指代消解需要「它」「那个」出现的真实语境，存改写后的会丢掉对话自然性。
- 历史压缩**失败了怎么办**？放弃压缩、保留完整历史，绝不为了省 token 丢上下文。
- 会话能力**默认开还是关**？默认关——每轮多一次改写调用、变长还要摘要，有成本和延迟，需要多轮体验时再开。

12 组里那 6 个从「召不回」到「召回」的追问，是我觉得这功能最直观的价值证明：检索系统终于能跟着对话「记住上一句在说什么」了。

至此这一轮 RAG 升级（分块/父块/Contextual、多模态、多轮会话）就告一段落，下一篇会写配套的**评估体系**——怎么扩评估集、补检索+生成双侧的 RAGAS 指标，让上面这些「我觉得变好了」都能用数字说话。

---
*配套代码：`QueryRewriterService` 的 `rewrite(q, history)` / `summarizeHistory`、`ConversationHistoryStore` / `ConversationHistory` / `ConversationTurn`、`RagAskService.ask(q, conversationId, debug)`、配置 `rag.query-rewrite.conversation`。实测明细见仓库 `docs/conversational-rag.md` 与 `conversational-measurement-report.md`。*
