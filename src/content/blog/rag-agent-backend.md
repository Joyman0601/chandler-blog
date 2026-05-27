---
title: "企业知识库 RAG + Agent 助手项目复盘"
description: "复盘一个基于 Java 17 和 Spring Boot 的 RAG + Agent 后端项目，记录从 LLM API、RAG 检索到工具调用和安全治理的实践思路。"
pubDate: 2026-05-27
tags: ["Java", "Spring Boot", "RAG", "Agent", "LLM"]
---

## 项目背景

这个项目是我在从 Java 后端转向大模型应用开发过程中搭建的一个学习项目，目标不是简单把用户问题转发给大模型，而是模拟企业场景里真正落地 RAG 和 Agent 时会遇到的问题。

项目源码地址：

```text
https://github.com/Joyman0601/RAG
```

它基于 Java 17 和 Spring Boot 3.3，实现了 LLM 对话、流式输出、意图识别、文档上传、chunk 切分、embedding、向量检索、RAG 问答、sources 引用、Tool Calling、受控 Agent Loop、高风险确认、安全自检和基础可观测能力。

我对这个项目的定位是：用后端工程能力把大模型接入真实业务系统，而不是只做一个聊天 Demo。

## 技术栈

项目主线技术栈比较克制，优先使用我熟悉的 Java 后端体系：

- Java 17
- Spring Boot 3.3
- Maven
- Spring Web / Validation
- JDK HttpClient / Spring RestClient
- Jackson
- JUnit 5 / Mockito / AssertJ
- OpenAI-compatible text generation API
- OpenAI-compatible embedding API
- 内存存储实现文档、chunk、embedding、会话状态和确认单

当前版本很多基础设施仍然是内存实现，比如向量存储、会话状态、确认单和指标统计。这样做的目的不是追求生产可用，而是先把核心边界和完整链路跑通。后续再替换成数据库、Redis、MQ、真实向量库和监控系统。

## 第一阶段：LLM 接入层

第一步是把模型调用从业务逻辑里抽出来，封装成统一的 `LlmClient` 和 `EmbeddingClient`。

这一层主要解决几个问题：

- 模型配置：API Key、Base URL、model、temperature、timeout。
- 输入限制：控制用户输入长度，避免上下文过长。
- 输出限制：配置最大输出 token，控制成本。
- 异常分类：区分配置缺失、认证失败、HTTP 错误、超时、空响应、结构异常。
- 用量记录：保留 token usage，为后续成本统计做准备。
- 流式输出：支持 SSE 风格的流式响应。

我在学习过程中形成的一个重要认知是：LLM 不是后端逻辑的替代品，它只是一个外部智能服务。后端仍然要负责参数校验、权限控制、异常处理、业务流程、日志和成本边界。

## 第二阶段：RAG 知识库链路

RAG 是这个项目的核心。它解决的是：模型如何基于企业内部文档回答问题，并且让回答可追溯。

离线入库流程大致是：

```text
上传 txt / markdown 文档
-> 校验文件类型并读取文本
-> 保存文档 metadata
-> 按 chunk size 和 overlap 切分文本
-> 为每个 chunk 生成 contentHash
-> 调用 embedding API 生成向量
-> 保存 chunk 与 embedding
```

在线问答流程是：

```text
用户提问
-> 对问题生成 embedding
-> 按文档状态、版本和权限过滤可检索 chunk
-> 计算 cosine similarity 并取 topK
-> 按 score threshold 过滤低分结果
-> 构造编号 context
-> 调用 LLM 生成答案
-> 返回 answer 和后端生成的 sources
```

这里有几个我认为比较关键的设计点。

第一，sources 必须由后端生成。模型可以基于上下文回答，但不能让模型自己编引用来源。正式返回给用户的 sources 应该来自实际进入 context 的 chunk，包括 documentId、filename、chunkId、score 和内容预览。

第二，文档需要有 version 和 status。文档从上传到可检索不是瞬间完成的，中间可能解析失败、embedding 失败或者被更新。如果旧版本 chunk 还参与检索，就可能让模型基于过期资料回答。

第三，权限过滤要下推到检索阶段。不能先把用户无权访问的 chunk 放进 prompt，再指望模型不说出来。用户身份、部门、角色、文档可见性这些条件，应该在检索前就参与过滤。

## 第三阶段：Tool Calling

Tool Calling 是从普通问答走向 Agent 的关键一步。

我的设计原则是：模型只能提出工具调用意图，不能直接执行工具。

项目里抽象了三个核心角色：

- `ToolExecutor<T>`：具体工具的实现协议。
- `ToolRegistry`：工具注册中心，根据工具名查找定义和执行器。
- `ToolExecutionService`：统一工具执行入口，负责安全校验和执行裁决。

所有工具调用都必须经过后端统一入口。后端会检查工具是否存在、参数结构是否正确、必填参数是否完整、当前用户是否有权限、风险等级是否需要确认，以及是否包含禁止由模型传入的字段。

比如 `userId`、`tenantId`、`topK`、`scoreThreshold` 这些参数不能交给模型决定。真实用户身份来自后端上下文，检索范围和阈值也应该由后端策略控制。

这个设计背后的原因很简单：模型输出不可信。用户可能通过 prompt injection 诱导模型调用高风险工具，或者让模型伪造参数扩大访问范围。最终执行权必须留在后端。

## 第四阶段：受控 Agent Loop

在 Tool Calling 之上，项目继续实现了受控 Agent Loop。

Agent 不是完全自由行动，而是在明确边界内执行有限步骤：

- 限制最大步骤数，比如最多 3 步。
- 限制最大执行时间。
- 记录每一步模型调用、工具调用、工具结果和停止原因。
- 检测重复 toolName + arguments，避免无限循环。
- 高风险工具必须先创建确认单，用户确认后才能执行。

这里我更倾向于把 Agent 看成一个后端工作流，而不是一个完全自治的黑盒。模型可以理解用户意图，可以选择工具，但每一步都应该被记录、限制和审计。

## 第五阶段：安全和治理

大模型应用上线后的难点不只是“能不能回答”，还包括成本、稳定性、安全和可观测性。

这个项目里我整理了一些基础治理点：

- requestId：为每次请求生成或透传追踪 ID。
- 错误码：统一表达 LLM、RAG、Tool、Agent 不同失败原因。
- 审计日志：记录确认创建、确认执行和高风险操作。
- 成本控制：记录输入长度、输出 token、调用耗时和调用次数。
- 限流和预算：为后续租户额度、用户额度和接口限制预留位置。
- 安全自检：检查工具定义、风险等级、权限码和 Agent 配置。
- Shadow Mode：新工具上线前只记录模型决策，不真实执行。

这些能力看起来不像 RAG 或 Agent 的“核心功能”，但它们决定了系统能不能从 Demo 走向可维护的后端服务。

## 这个项目和普通聊天套壳的区别

普通聊天套壳主要是把用户输入发给模型，再把模型输出返回给用户。

这个项目更关注后端系统边界：

- RAG 负责知识来源和可追溯。
- sources 由后端生成，避免模型编造引用。
- version/status 管理文档生命周期，避免旧资料被召回。
- 权限过滤在检索阶段完成，避免越权内容进入 prompt。
- Tool Calling 由后端统一裁决，模型不能直接执行业务。
- 高风险操作需要二次确认。
- Agent Loop 有步骤、时间和重复调用限制。
- requestId、错误码、日志、评估和成本统计服务于排查和治理。

我认为这也是 Java 后端转大模型应用开发时最值得强调的能力：不是只会调用模型接口，而是能把模型能力放进一个受控、可追踪、可扩展的业务系统里。

## 当前不足

这个项目目前仍然是学习和展示项目，还有很多生产化工作没有完成：

- 文档、chunk、embedding、会话状态和确认单还是内存存储。
- 用户身份和权限上下文是 mock 实现。
- 向量检索使用内存余弦相似度，不适合大规模数据。
- 文档入库 worker 还没有接入 MQ。
- 缓存、限流、额度统计还没有接 Redis。
- 指标还没有接 Micrometer、Prometheus 和 Grafana。
- RAG 评估还只是基础版本，没有形成完整指标看板。
- 高风险确认单没有持久化，也没有审批流或通知机制。

这些不足也正好构成后续优化路线。

## 后续计划

后续我会按后端工程化的顺序继续推进：

1. 存储层接入 MySQL 或 PostgreSQL，保存文档元数据、确认单、审计日志和会话状态。
2. 向量库接入 pgvector、Milvus、Elasticsearch dense vector 或 OpenSearch。
3. 权限系统接入 Spring Security + JWT，替换 mock 用户上下文。
4. 文档入库改造成 MQ 异步任务，增强失败重试和削峰能力。
5. 缓存和限流接入 Redis。
6. 指标接入 Micrometer + Prometheus + Grafana。
7. RAG 质量继续补 query rewrite、rerank、hybrid search、引用片段高亮和离线评测。
8. Agent 侧继续补幂等控制、人工接管、失败补偿和更多安全回归测试。

## 总结

做完这个项目后，我最大的体会是：大模型应用开发并不是把模型接进来就结束了。

RAG 解决知识从哪里来，Tool Calling 解决模型如何连接业务系统，Agent Loop 解决多步任务编排。但这些能力都必须被后端的权限、参数校验、风险确认、状态机、日志、指标和成本控制约束住。

我的设计原则可以概括成一句话：

> 模型可以理解意图，但不能拥有最终执行权；真正的业务边界必须在后端。

