---
title: "大模型应用岗学习路线：从基础直觉到工程落地"
description: "一条围绕「企业知识库 RAG 系统」展开的大模型应用学习路线：从 Transformer 直觉、RAG 检索与评估，到 Agent 原理、进阶检索范式、微调部署与工程生态，每一块都落到真实项目改造上。"
pubDate: 2026-06-01
tags: ["AI", "LLM", "RAG", "Agent", "学习路线"]
series: "llm-learn"
seriesLabel: "大模型应用岗学习"
---

> 系列开篇。这是一条面向「大模型应用」方向的系统学习路线——不碰模型训练算法，而是站在后端工程的角度，把 LLM、RAG、Agent 落地到真实业务系统里。整条路线围绕一个贯穿始终的项目展开：一个企业知识库 RAG 系统，每学一块就拿它来改造，最终沉淀出带数据的优化结论，而不是堆砌名词。

## 为什么要有一条主线项目

大模型应用的知识点很容易学成「名词收集」：混合检索、重排、RAGAS、ReAct、LoRA、vLLM……每个都能说两句，但拼不成一个能落地的系统，也讲不清它们之间的取舍。

这条路线刻意反过来：**先有一个能跑的 RAG 系统，再用每个新知识点去改造它**。这样带来两个好处：

- 每个技术点都对应一次真实的代码改动和一组对比数据，知道它「有没有用、什么时候有用」。
- 学到的不是孤立概念，而是「在这个系统里，这一层解决什么问题、代价是什么」。

主线项目是一个基于 Java + Spring Boot 的企业知识库问答系统：文档上传、chunk 切分、embedding、向量检索、RAG 问答、Tool Calling、受控 Agent Loop。下面每一阶段都在它身上动刀。

## 学习路线分阶段

整条路线按「先打地基、再主攻招牌、最后扩张区分度」的顺序排列：

| 阶段 | 主题 | 定位 |
|---|---|---|
| Phase 0 | 大模型基础直觉 | 地基，能讲清直觉而非推公式 |
| Phase 1 | RAG 检索质量（Hybrid + Rerank） | 招牌，重中之重 |
| Phase 2 | RAG 评估体系（RAGAS） | 给优化提供量化结论 |
| Phase 3 | Prompt 工程与 Agent 原理 | 讲清 ReAct 与 Tool Calling 底层 |
| Phase 4 | 进阶 RAG 范式 | 了解概念、知道解决什么问题 |
| Phase 5 | 微调与本地部署 | 跳出「只会调 API」 |
| Phase 6 | 工程化与生态 | 呼应后端可观测性经验 |

### Phase 0 · 大模型基础直觉

Transformer 为什么能做大、Attention 的 QKV 到底在算什么、temperature/top-p 怎么影响输出、token 与上下文窗口、幻觉的成因与缓解全景。这一层不要求会推导，但要能脱稿讲清「为什么」。

### Phase 1 · RAG 检索质量

把「纯向量检索」升级为**混合检索（BM25 + 向量，RRF 融合）+ Cross-Encoder 重排**。核心是理解「召回」和「精排」两段式，以及为什么纯向量在编号、专名、缩写上会翻车。

### Phase 2 · RAG 评估体系

没有评估的 RAG 就是玄学。用 RAGAS 的四个指标（faithfulness / answer relevancy / context precision / context recall）给 Phase 1 的几种方案打分，得出「哪一层优化真正有用」的量化结论。

### Phase 3 · Prompt 工程与 Agent 原理

CoT 为什么能提升推理、ReAct 范式（Thought → Action → Observation）如何用外部事实治幻觉、Tool Calling 的底层机制，以及一个受控 Agent Loop 需要哪些工程护栏。

### Phase 4 · 进阶 RAG 范式

Query 改写、Multi-Query、HyDE、父子检索、上下文压缩、Self-RAG、GraphRAG——把它们组织成一个「检索侧 / Query 侧 / 文档与生成侧」的三层优化框架。

### Phase 5 · 微调与本地部署

微调谱系（预训练 → SFT → RLHF/DPO）、LoRA/QLoRA 为什么能省显存、量化（INT8/INT4/GPTQ/AWQ）、vLLM 的 PagedAttention 与 Ollama 本地部署，以及「什么时候该微调、什么时候该用 RAG」。

### Phase 6 · 工程化与生态

LangChain/LlamaIndex 解决了什么、为什么有时主动选择不用、MCP 协议的意义，以及用 Langfuse 给 RAG 链路接入可观测性，和后端的链路追踪经验直接对应。

## 三条贯穿全程的原则

1. **不脱离项目空学**：每个知识点都要落到主线项目的一次改造上。
2. **有量化才有结论**：优化前后必须有对比数据，避免盲目堆技术。
3. **每阶段输出一篇**：输出倒逼输入——这个系列本身就是路线的产物。

后面每一篇对应一个 Phase，按顺序展开。
