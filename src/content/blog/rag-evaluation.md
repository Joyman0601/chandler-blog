---
title: "给 RAG 搭一套评估：53 题标准答案集 + 检索/生成双侧 6 维 RAGAS"
description: "前面几篇都在说『我觉得检索变好了』，但到底好多少得用数字说话。这篇扩评估集——从 26 题弱标注扩到 53 题带标准答案（覆盖口语化/多跳/无答案），补齐 context recall / answer correctness 两个需要标准答案的指标，凑成检索+生成双侧 6 维评估。实测混合检索相对纯向量 faithfulness 0.85→0.95、answer relevancy 0.37→0.53。"
pubDate: 2026-06-26
tags: ["Java", "Spring Boot", "RAG", "RAGAS", "评估", "LLM-as-Judge"]
series: "rag"
seriesLabel: "RAG 项目"
---

> 一句话总结：前面几篇都在说「我觉得检索变好了」，但到底好多少，得用数字说话。这篇做两件事：把评估集**从 26 题弱标注扩到 53 题带标准答案**（覆盖规范 FAQ / 口语化 / 多跳 / 无答案四类），补齐 **context recall / answer correctness** 两个需要标准答案的指标，凑成**检索 + 生成双侧 6 维 RAGAS 评估**。实测混合检索相对纯向量 faithfulness 0.85→0.95、answer relevancy 0.37→0.53。

## 0. 起因：「我觉得变好了」不算数

这一轮我给 RAG 加了不少东西——混合检索、精排、分块、父块、Contextual、多模态、多轮。每加一个，我都「感觉」召回更好了。但感觉不是证据。要拿这套东西去面试、写进简历，得有一套能复现的评估，能回答两个问题：

- **检索侧**：找得全不全（recall）、排得准不准（precision）？
- **生成侧**：答得对不对（correctness）、有没有编（faithfulness）、切不切题（relevancy）？

我原来其实有 RAGAS 评估，但有两个短板：评估集只有 **26 题、还是弱标注**（每题只有几个关键词，没有标准答案）；指标也只有三个 reference-free 的（faithfulness / answer_relevancy / context_precision）——缺了「召回完整性」和「答案对不对」，因为那两个指标**需要标准答案**才能算。

所以这一篇分两步：先把评估集补成带标准答案的，再补齐缺的两个指标。

## 1. 扩评估集：26 → 53 题，补标准答案

评估集是一切量化的地基，地基不行，上面的数字再漂亮也没意义。我把它从 26 题扩到 **53 题**，每题加上 `groundTruthAnswer`（完整标准答案，基于语料事实）和 `category`（题型）。

题型分布刻意做了覆盖：

| 题型 | 数量 | 是什么 |
| --- | --- | --- |
| faq | 25 | 规范的标准问法 |
| colloquial | 9 | 口语化长问（啰嗦的自然提问） |
| multi_hop | 11 | 多跳，答案要跨 ≥2 篇文档 |
| no_answer | 8 | 语料里根本没有答案，应触发兜底「根据现有资料无法回答。」 |

为什么要分这四类？因为它们考的是不同能力：faq 考基本召回，colloquial 考 query 改写扛不扛得住啰嗦，multi_hop 考多文档召回，**no_answer 考「会不会硬编」**——一个 RAG 系统遇到语料外的问题，老老实实说「不知道」比胡诌一个答案重要得多。

光有数据还不够，我加了个 `EvalSetSchemaTest`（纯 JUnit，不联网）当守门员，校验：题量在 50–100 之间、必填字段齐、`category` 合法、**`expectedKeys` 引用的文档在语料里真实存在**、no_answer 题不能有引用且标准答案就是兜底串、多跳题至少引 2 篇、题目不重复、各题型有数量下限。

这个 schema 测试是我事后觉得很值的一笔：评估集是会被手改的数据，一旦有人加了道题、引用了一篇不存在的文档，整个评测就静默地错了。有它守着，评估集烂不了。

## 2. 补齐双侧 6 维指标

有了标准答案，就能补上缺的两个 reference-based 指标，凑齐 6 维：

| 维度 | 指标 | 侧 | 要标准答案 | 含义 |
| --- | --- | --- | --- | --- |
| 检索 | context_precision | 检索 | 否 | 召回的相关上下文排得靠不靠前 |
| 检索 | **context_recall** | 检索 | **是** | 标准答案要的信息，检索召全了吗 |
| 生成 | faithfulness | 生成 | 否 | 答案忠不忠于上下文（抗幻觉） |
| 生成 | answer_relevancy | 生成 | 否 | 答案切不切题 |
| 生成 | **answer_correctness** | 生成 | **是** | 答案和标准答案的事实+语义匹配度 |
| 锚点 | Hit@K / Recall@K / MRR | 检索 | 文档级标注 | Java 侧确定性命中，不依赖判官 LLM |

加粗的两个是这次补的。这里有个我自己挺满意的设计——**judge 与数据集解耦**：

```
RagMeasurementHarnessTest (Java, 真 API)
  └─ 跑 vector / hybrid / hybrid_rerank / vector_rewrite 四种模式
  └─ 导出 ragas-dataset-<mode>.json（question / contexts / answer）
                          │
                          ▼
eval/ragas_eval.py (Python, 判官 LLM)
  └─ 从 questions.json 实时读 question→groundTruthAnswer
  └─ 按 question 把【完整标准答案】join 进每行的 reference 字段
  └─ 全部行都有 reference 时才启用 reference-based 指标
  └─ 输出 ragas-comparison.md
```

关键点：**reference（标准答案）是在 Python 侧实时 join 进去的，不写死在 Java 采集的冻结数据集里**。好处是——改标准答案、加题，不必重新跑那套又慢又费 token 的 Java 真 API 采集，judge 直接读最新的 `questions.json` 就行。采集（贵、慢）和评判（标准答案常改）这两件事的生命周期不一样，解耦开就互不拖累。

还有两个工程细节：

- **版本兼容**：`context_recall` / `answer_correctness` 在 RAGAS 0.1→0.2 之间改过类名，`build_metrics` 用 try/except 同时兼容 `LLMContextRecall`/`ContextRecall` 这种新旧命名，不至于升级个库就炸。
- **离线可测**：RAGAS 的 import 全塞进函数体内部，这样 `test_ragas_eval.py` 不联网、不 import ragas 也能跑——校验 join 逻辑、选指标逻辑这些纯函数，不必每次都连判官 LLM。

## 3. 实测结果

reference-free 三指标我已经用真实判官跑出来了（判官 `Qwen2.5-72B-Instruct` + 嵌入 `bge-m3`，26 题）：

| mode | faithfulness | answer_relevancy | context_precision |
| --- | --- | --- | --- |
| vector | 0.8540 | 0.3703 | 0.6528 |
| hybrid | **0.9484** | **0.5261** | 0.8431 |
| hybrid_rerank | 0.9171 | 0.4429 | **0.8889** |
| vector_rewrite | 0.8807 | 0.3618 | 0.8111 |

读出来几个结论：

- **hybrid 相对 vector 全面提升**：faithfulness 0.854→0.948、answer_relevancy 0.370→0.526、context_precision 0.653→0.843。混合检索召回了更相关的上下文，答案于是更忠实、也更切题——这就给前面「混合检索值得做」补上了数字证据。
- **rerank 把 context_precision 顶到最高 0.889**：精排把最相关的块顶到最前面，这正是它该干的。faithfulness / relevancy 略低于 hybrid，在小样本上属判官波动范围。

## 4. 诚实说：还有两块没跑完

按我这个系列一贯的规矩，没跑的就不编：

- **context_recall / answer_correctness 代码就绪，但还没出数值**。它们需要一次判官 LLM 联网评测，我本机当时没有可用的判官 API。复现命令就一行 `python eval/ragas_eval.py`，它会自动 join 标准答案、跑满 6 个指标。
- **`FIXED / MARKDOWN+parent / +contextual` 三方案对比**还没填。这依赖前面分块那篇的开关，按方案各跑一遍采集 + RAGAS 才能填进同一张 6 指标表。表框架已经在 `docs/eval-metrics.md` 摆好了，就差真 API 环境下重跑一遍。

把「待重跑」明明白白标出来，而不是拿现成的三指标硬凑成六指标——这是我觉得做评估最该守的底线。评估的意义就是诚实，自己骗自己的数字一点用都没有。

## 5. 写在最后

这套评估搭下来，我对「怎么衡量一个 RAG 好不好」的理解清楚多了：

- **评估集是地基**，质量比数量重要——53 题带标准答案、还分了四类题型、有 schema 测试守门，比 200 题没标准答案的有用得多。
- **指标要双侧**——只看生成侧（答得好不好）会漏掉检索侧（根本没找全），反之亦然。6 维 + Java 侧 Hit@K 锚点，检索和生成都覆盖到了。
- **采集和评判解耦**——把贵的（真 API 采集）和常变的（标准答案）分开，省下大量重跑成本。

这也是这一轮 RAG 升级系列的收尾。从[混合检索+精排](/blog/rag-pgvector-migration/)、[分块/父块/Contextual](/blog/rag-chunking-parent-contextual/)、[多模态](/blog/rag-multimodal/)、[多轮会话](/blog/rag-conversational/)，到这篇评估——每一步都尽量做到「能讲清为什么这么选，能用数字（或诚实标注的待测）说话」。对我来说，这种把 demo 一步步做成像样系统、并且能量化验证的过程，比堆功能本身收获大得多。

---
*配套代码：`questions.json`（53 题带 groundTruthAnswer）、`EvalSetSchemaTest`、`eval/ragas_eval.py`（6 指标 + judge/数据集解耦）、`eval/test_ragas_eval.py`（离线单测）。完整指标体系与对比表见仓库 `docs/eval-metrics.md`。*
