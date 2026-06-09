---
title: "Prompt 工程与 Agent 原理：从 CoT 到受控的 ReAct 循环"
description: "讲清 Prompt 四范式与 CoT 的底层机制、ReAct 范式为什么能用外部事实治幻觉、Tool Calling 的真实流程，以及一个生产级 Agent Loop 需要哪些工程护栏：硬上限、去重、Human-in-the-Loop 与安全边界。"
pubDate: 2026-06-05
tags: ["Agent", "ReAct", "Prompt", "Tool Calling"]
series: "llm-learn"
seriesLabel: "大模型应用岗学习"
---

> 系列第 4 篇。Agent 不是什么魔法，本质就是一个 ReAct 循环加上一圈工程护栏。这一篇从 Prompt 工程的几个范式讲起，一路到 Tool Calling 的底层机制和「怎么让 Agent 不跑飞」。

## Prompt 工程四范式

- **Zero-shot**：直接问，不给例子。
- **Few-shot**：给几对「输入 → 输出」示范，模型靠 in-context learning 就地模仿。在分类、抽取任务里，它**最主要的价值是锁死输出格式**（要注意覆盖每个类别，避免 label bias）。
- **CoT（思维链）**：让模型先想再答。
- **Self-Consistency**：CoT 跑多条独立采样，再多数投票，用 N 倍成本换稳定性。

### CoT 为什么能提升推理：token 是唯一的计算介质

这是个值得讲透的点。**模型没有隐藏的草稿纸，所有「思考」都必须发生在它实际吐出来的 token 上。**

不用 CoT 时，模型要在一个 token 的位置直接押对一个复杂答案，很容易出错。CoT 把推理过程外化成一串 token，模型可以「看着自己刚写下的中间结果」接着往下算——等于把一道难题拆成了几道简单题。

> 一句话：token 是模型唯一的计算介质，CoT 就是给它更多「演算空间」。

### 一个易错点：Few-shot ≠ 输出格式约束

给模型一段「只有输出侧的空模板」（比如要求按某个 JSON 结构回复），这叫**输出格式约束**，不是 Few-shot。Few-shot 是给完整的「输入 → 输出」配对示范。两者经常被混为一谈。

## ReAct 范式

Agent 的核心就是 ReAct，公式是：

```text
Thought → Action → Observation → Thought → … → Final Answer
```

模型先 **Thought**（推理出还缺什么信息），然后 **Action**（调一个工具），拿到 **Observation**（工具返回的真实结果）追加进上下文，再进入下一轮推理，直到能给出 **Final Answer**。

### 为什么 ReAct 能治幻觉

纯 CoT 的推理锚点是模型的参数知识——不知道就只能编。而 ReAct 每一次 Thought 都建立在上一步 Observation 的**真实外部数据**之上。

> 关键：ReAct 治幻觉的根本不是「分步推理」本身，而是**推理锚点从「内部记忆」换成了「外部事实」**。

## Tool Calling 的底层机制

很多人以为模型自己「执行」了工具，其实不是。更准确的说法是 **Function Requesting**：

1. 把工具的 JSON Schema 塞进 prompt。
2. 模型输出一段「我想调这个工具、参数是这些」的 JSON——它只是**提议**。
3. **后端代码真正解析并执行**这个工具。
4. 执行结果追加进 messages，作为下一轮的 Observation。

**模型怎么决定调哪个工具**：不是「先分类再查表」，而是直接看 prompt 里全量工具的 Schema，靠每个工具的 description 做语义匹配，一步同时完成「要不要用工具」和「用哪个」。

### messages 是多轮记忆的全部秘密

每一轮都往 messages 里追加「assistant 的决策 + 工具结果」。这串不断增长的 messages 就是 Agent 的工作记忆。

代价是它越来越长。**如果不做截断/压缩，迟早撞上上下文窗口上限，API 直接拒绝，Agent 崩掉**——注意，后果是崩溃，不是答案跑偏。所以生产级 Agent 必须有对话压缩策略。

## 一个受控 Agent Loop 需要的护栏

让 Agent 能用是一回事，让它在生产环境里不出事是另一回事。核心是三层可控性设计：

1. **硬上限**：最大步数、最大耗时、最大 LLM 调用次数。任何一个触顶就强制结束——防无限循环和成本失控。
2. **重复调用去重**：对工具调用做签名检测，发现模型在反复调同一个工具就拦下——防它「卡碟」。
3. **Human-in-the-Loop**：高风险工具（比如取消订单、退款）不直接执行，而是走「存档-重启」的异步模式——后端拦截这次调用，存进一个待确认记录并带上 confirmationId 直接返回；用户确认后，前端带着 confirmationId 发第二次请求，后端凭 id 找到存档再执行。

> 注意：Human-in-the-Loop 是「存档-重启」的异步模式，不是同步挂起等待。这样 HTTP 请求能正常结束，不需要维持长连接。

## 安全边界在代码层，不信任模型输入

一个容易被忽视但很关键的点：**用户真实身份（userId / tenantId）绝不能让模型来填**。

应该在 prompt 里明确禁止模型输出这些字段，真实身份只在后端的执行上下文里注入。这样即使有人通过 Prompt Injection 诱导模型硬写一个别人的 userId，后端也会忽略模型给的值——**安全边界落在代码层，永远不信任模型输入**。

## 小结

Agent = ReAct 循环（Thought/Action/Observation 用外部事实锚定推理）+ Tool Calling（模型提议、后端执行）+ 一圈工程护栏（硬上限、去重、Human-in-the-Loop、安全边界）。把这套拆开看，它一点都不神秘。下一篇进入进阶 RAG 范式，看看检索还能怎么玩。
