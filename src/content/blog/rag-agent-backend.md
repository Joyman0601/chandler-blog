---
title: "企业知识库 RAG + Agent 项目：系列导读"
description: "一个 Java 17 + Spring Boot 的 RAG + Agent 学习项目的系列导读：现在的架构是什么样、每项能力在哪篇文章里讲、建议的阅读顺序，以及最初提纲里还没做的部分。"
pubDate: 2026-05-12
tags: ["Java", "Spring Boot", "RAG", "Agent", "LLM"]
series: "rag"
seriesLabel: "RAG 项目"
---

> 一句话总结：这个项目从一个全内存的 RAG + Agent 后端起步，后来接上了 pgvector 和 PostgreSQL，补了混合检索、分块、多模态、多轮改写、Prompt Caching 和评估，最后用 Docker Compose 部署成公网演示环境，配了限流、配额和自建 Langfuse。这篇是 RAG 系列的导读：先讲现在的架构，再按能力列出对应的文章。

## 0. 这个项目是什么

这是我从 Java 后端转向大模型应用开发时搭的学习项目。目标不是把用户问题转发给大模型，而是模拟企业场景里落地 RAG 和 Agent 会遇到的问题：知识从哪来、能不能追溯、谁能看到什么、模型能调哪些工具、花了多少钱。

项目源码地址：

```text
https://github.com/Joyman0601/RAG
```

本文最早是 05-12 写的项目提纲，那时文档、向量、会话都还在内存里。后面的改造各写成了一篇，这里改成导读，提纲里已经做完的部分换成了链接。

## 1. 现在的架构

按一次请求经过的层次列：

- **接口层**：Java 17 + Spring Boot 3.3，提供问答、文档管理、Agent 和用量查询接口。
- **入库**：上传 → 分块（固定窗口、按 Markdown 标题、按语义三种策略）→ 可选给子块加上下文前缀 → Embedding（图片走多模态端点）→ 写进 PostgreSQL + pgvector。
- **检索**：向量检索走 pgvector，BM25 在应用层算，两路用 RRF 融合，可选再精排；问题可以先做单轮或对话式改写；权限条件写在 SQL 的 WHERE 里。
- **生成**：DashScope 的 Qwen（OpenAI 兼容接口），开关打开时 system 前缀走显式缓存；回答里的 sources 由后端生成。
- **Agent**：模型只提出工具调用，后端统一校验、裁决、执行；循环有步数、时间和重复调用限制。
- **治理**：用量落 PostgreSQL；LLM 调用按天限额；Token 过滤器；Nginx 按 IP 限流；上传接口可关。
- **观测与评估**：自建 Langfuse 记录 trace；Java 侧采集问答结果，Python 侧用 RAGAS 判官打分。
- **部署**：Docker Compose 起三个容器：pgvector、Spring Boot 应用、Nginx 前端。

几个存储和开关都是「内存默认 + 配置切换」：不开 pgvector 时，整个项目仍能纯内存跑，单元测试不依赖数据库。

## 2. 按能力找文章

建议按表里的顺序读，后一篇大多建立在前一篇的改动上。

| 能力 | 文章 |
|---|---|
| 向量库从内存换到 pgvector | [把内存里的向量库换成 pgvector](/blog/rag-pgvector-migration/) |
| 用量记录持久化 | [把 usage 用量从内存搬进 PostgreSQL](/blog/rag-usage-persistence/) |
| Prompt Caching | [给 RAG Agent 接 Prompt Caching](/blog/rag-prompt-caching/) |
| 分块、父块、Contextual Retrieval | [RAG 检索召回升级](/blog/rag-chunking-parent-contextual/) |
| 图片和 PDF 里的图 | [多模态 RAG 踩坑](/blog/rag-multimodal/) |
| 多轮追问的指代消解 | [多轮会话 RAG](/blog/rag-conversational/) |
| 评估集和 RAGAS 指标 | [给 RAG 搭评估](/blog/rag-evaluation/) |
| Docker Compose 上云 | [把 RAG 项目部署上云](/blog/rag-deploy-compose-pitfalls/) |
| 公网演示的防刷 | [演示环境的四道防线](/blog/rag-demo-hardening/) |
| 自建观测 | [自建 Langfuse 反代到公网](/blog/rag-langfuse-selfhost/) |
| 上线前彩排 | [录屏前的彩排](/blog/rag-demo-rehearsal-bugs/) |

混合检索和精排的原理在另一个系列里：[RAG 检索质量：从纯向量到混合检索 + 重排](/blog/llm-learn/02-rag-retrieval-quality/)。

## 3. 几条贯穿始终的设计原则

我在学习过程中形成的一个重要认知是：LLM 不是后端逻辑的替代品，它只是一个外部智能服务。后端仍然要负责参数校验、权限控制、异常处理、业务流程、日志和成本边界。

落到这个项目里，是下面几条：

- **sources 由后端生成**。返回给用户的引用来自实际进入 context 的 chunk，不让模型自己编。
- **文档有 version 和 status**。解析失败、更新中的文档不参与检索，旧版本 chunk 不会被召回。
- **权限过滤在检索阶段完成**。不先把无权访问的 chunk 放进 prompt 再指望模型不说出来；pgvector 篇讲了怎么把它写成 SQL。
- **工具调用由后端裁决**。`userId`、`tenantId`、`topK`、`scoreThreshold` 这类参数不交给模型决定；高风险工具先建确认单，用户确认后才执行。
- **Agent 是受控的工作流**。限制步数和时间，记录每一步的模型调用、工具调用和停止原因，检测重复调用。
- **增强功能失败就降级**。改写、Contextual 前缀、观测上报失败时，回到「未增强」的正确路径，不让主链路报错。

## 4. 还没做的

最初提纲里列的后续计划，已经做了的：

- 存储接 PostgreSQL、向量库接 pgvector：见 [pgvector 篇](/blog/rag-pgvector-migration/) 和 [usage 篇](/blog/rag-usage-persistence/)。
- query 改写、混合检索、精排、离线评测：见 [多轮会话 RAG](/blog/rag-conversational/)、[RAG 检索质量](/blog/llm-learn/02-rag-retrieval-quality/) 和 [评估篇](/blog/rag-evaluation/)。

后面各篇还没写到的：

1. 确认单、审计日志、会话状态持久化。对话历史目前仍是内存 store。
2. 用户身份从 mock 换成 Spring Security + JWT。
3. 文档入库改成 MQ 异步任务，补失败重试和削峰。
4. 缓存和限流接 Redis（演示环境刻意没用，理由见 [加固篇](/blog/rag-demo-hardening/)）。
5. 指标接 Micrometer + Prometheus + Grafana。
6. 引用片段高亮。
7. Agent 侧的幂等控制、人工接管、失败补偿和更多安全回归测试。
8. 评估篇里待跑的部分：53 题全量、context_recall 和 answer_correctness 两个指标、三种分块方案的对比。

## 收尾

RAG 解决知识从哪里来，Tool Calling 解决模型如何连接业务系统，Agent Loop 解决多步任务编排。这些能力都要被后端的权限、参数校验、风险确认、日志和成本控制约束住。

我的设计原则可以概括成一句话：

> 模型可以理解意图，但不能拥有最终执行权；真正的业务边界必须在后端。
