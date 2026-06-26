---
title: "RAG 检索召回升级：可插拔分块、独立父块、Contextual Retrieval"
description: "原来分块只有「固定 600 字 + 100 overlap」一条路走到黑。这次把它重构成可插拔策略（FIXED / MARKDOWN / SEMANTIC），落地 Parent-Document 独立父块，又借鉴 Anthropic 的 Contextual Retrieval 给子块加上下文前缀再 embedding。三件事都围绕一个目标：让小子块召回得准、又不丢全局语境。默认全关，现有测试零回归。"
pubDate: 2026-06-26
tags: ["Java", "Spring Boot", "RAG", "分块", "向量检索", "Contextual Retrieval"]
series: "rag"
seriesLabel: "RAG 项目"
---

> 一句话总结：我这个 RAG 项目的分块一直只有一种——「固定 600 字 + 100 overlap」，逐字符切，切到哪算哪。这次围绕「召回」做了三件连贯的事：**分块策略可插拔**（FIXED / MARKDOWN / SEMANTIC）、**独立父块 Parent-Document**（检索用小块、喂 LLM 用大块）、**Contextual Retrieval**（embedding 前给子块补一句全局定位）。它们解决的是同一个矛盾：子块切小了检索准、但语义残缺；切大了语义全、但检索糊。默认全关，现有测试零回归。

## 0. 起因：召回质量七分在分块

边学边搭的 RAG 项目，之前一直把精力花在「混合检索 + 精排」上。某天回头看入库那一端，发现分块实现还是最朴素的样子：

```java
// 固定窗口：chunkSize=600, overlap=100，逐字符往前推
while (start < text.length()) {
    int end = Math.min(start + chunkSize, text.length());
    chunks.add(text.substring(start, end));
    start = end - overlap;
}
```

demo 跑没问题，但它有两个我自己都过不去的硬伤：

1. **切碎语义结构**。一篇 Markdown FAQ，标题 `## 退款政策` 和它的正文，很可能被切进两个不同的 chunk。检索命中了正文那块，却丢了「这段是在讲退款政策」这个关键上下文。
2. **粒度两难**。chunk 切小，向量检索精度高（query 和 chunk 都聚焦），但喂给 LLM 时上下文不完整；chunk 切大，上下文完整，但检索精度下降——一个大块里混了好几个话题，向量被稀释了。

这一轮就是奔着这两个问题去的。下面三个设计点，其实是一条线：**用结构化分块解决「切碎」，用父块解决「粒度两难」，用 Contextual 给小块补回被切掉的语境。**

## 1. 分块策略可插拔

第一步先把「只有一种分块」改成「可以换」。新建 `com.yhl.rag.chunk` 包，核心是一个接口：

```java
public interface TextSplitter {
    ChunkStrategy strategy();
    ChunkResult split(String documentId, String filename, String text, ChunkConfig config);
}
```

`ChunkResult` 同时返回 `List<DocumentChunk> children`（子块）和 `List<ParentBlock> parents`（父块）。三个实现：

- **`FixedWindowSplitter`**：把原来那段 while 循环**原样搬过来**，行为逐字节不变、chunkId 稳定可复算（增量索引去重依赖它）。无父块。这是默认值，保证「什么都不开，行为和以前一模一样」。
- **`MarkdownSplitter`**：按 `#` / `##` / … 标题切 section，每个有正文的 section 当成一个独立父块；子块在 section 内按固定窗口切，并在正文前加**标题面包屑**（`标题：安装 > 环境要求\n<正文>`）帮助检索定位。
- **`SemanticSplitter`**：句子切分 → 逐句 embedding → 相邻句 cosine 跌破阈值处断块，让语义连续的句子留在同一子块。

`ChunkingService` 按 `config.strategy()` 取对应 splitter，新增策略只要注册一处。配置：

```yaml
rag:
  chunk:
    strategy: FIXED            # FIXED | MARKDOWN | SEMANTIC
    parent-document:
      enabled: false           # 开启后检索回填父块
    semantic:
      threshold: 0.6           # 相邻句断块阈值，仅 SEMANTIC
```

这里有个我比较在意的细节：**公开的 `chunkText(...)` API 永远走 FIXED，不读 strategy**。因为有存量调用方和测试直接调它，我不想让它的行为随配置漂移——策略切换只在入库主链路里生效。

## 2. 独立父块（Parent-Document）：检索用小块、喂 LLM 用大块

这是本轮最核心的决策，专门治「粒度两难」。

Parent-Document 的思路很直接：**检索时命中小子块（保精度），但喂给 LLM 时回填它所属的大父块（保完整）**。小块负责「被找到」，大块负责「讲清楚」。

存储有两种流派，我纠结了一下：

- **反贴**：把父块正文复制进每个子块。简单，但冗余——一个父块切 N 个子块，正文就存 N 份。
- **独立父块存储**（我选的）：子块只存一个 `parentId`，父块正文放在独立的 store 里；检索命中后按 `parentId` 回查父块。无冗余，父块更新也只动一处。

选独立存储，是觉得它更像「教科书里的 ParentDocumentRetriever」，数据模型干净，面试也好讲。落地：

- `ParentBlock`：parentId / documentId / content / version + 和子块对齐的租户、权限元数据。
- `ParentStore` 接口，两套实现按 `vectorstore.backend` 装配，跟之前 [pgvector 那篇](/blog/rag-pgvector-migration/) 里 `VectorStore` 的开关装配是同一套路：
  - `InMemoryParentStore`（默认）；
  - `JdbcParentStore`（pgvector），新建 `document_parent` 表，权限列对齐 `document_chunk`，方便复用同样的 SQL 过滤。
- `document_chunk` 加一个 `parent_id` 列，让子块的 parentId 在 pgvector 后端也能往返（回填时要用）。
- 入库时父块写 store、子块带 parentId；删除 / 换版本时同步删父块，不留孤儿。

回填发生在问答的 `buildContext`：

```
命中子块 c1（parentId=p1）、c2（parentId=p1）、c3（无父块）
        ↓
上下文 = 父块 p1 正文（出现一次，按 parentId 去重）+ c3 原文
sources = [c1, c3]   ← 仍指向命中的子块，可追溯到精确命中点
```

两个我自己觉得想清楚了的点：**父块按 parentId 去重**（c1、c2 同属 p1，p1 正文只拼一次，不浪费上下文预算）；**sources 仍指向子块**（父块正文只进 LLM 上下文、不进引用列表，用户点开 source 看到的还是精确命中的那一小段）。

## 3. Contextual Retrieval：给小块补回被切掉的语境

分块换来了检索精度，但小子块还有个老问题没解决：**脱离上下文后语义残缺**。举两个真会翻车的例子：

- 子块正文是「需要 JDK 17 及以上。」——这属于「安装 / 环境要求」还是「升级 / 兼容性」？光看这一句，向量里分不出来，query「安装前要准备什么」可能就召不回它。
- 子块正文是「点击右上角『申请』按钮提交。」——申请什么？请假、报销还是离职？指代信息在父块标题里，子块自己丢了。

Anthropic 2024 的《Contextual Retrieval》给了个办法：**embedding 之前**，让 LLM 看着整篇文档（或它的父级章节），为这个子块补一句定位说明（如「本片段说明请假流程中的提交步骤」），**前置**到子块文本再做 embedding。这样向量里就同时编码了「局部内容 + 全局定位」，召回率能明显提上来。

我新建了一个 `ContextualEnricher`，职责单一：

```java
// 返回待 embedding 文本：成功时为「定位前缀 + \n + 原文」，否则原文不变
String buildEmbeddingText(String content, String contextSource);
```

调 LLM 的方式我刻意贴合了之前 [Prompt Caching 那篇](/blog/rag-prompt-caching/) 的机制：

```
system (instructions) ← 固定任务说明 + contextSource（父块/全文）  ← cache_control 注入在这块
user   (input)        ← 该子块正文
output                ← ≤50 字定位说明
```

把 `contextSource` 放进 system，是因为 `LlmClient` 在缓存开启时正是对 system 块注入 `cache_control`。于是**同一父块/全文的多个子块，system 内容完全一致 → 命中缓存**：第 1 个子块付全价写缓存，后面的子块那段父块/全文就按缓存价计费。一篇文档切 N 个子块，本来要把全文重读 N 遍，现在只读 1 遍。这一点把「Contextual 给每个子块加一次 LLM 调用」的成本压了下来。

两个我守得很死的约束：

- **只改 embedding 的输入，不改展示**。`embeddingText` 是个临时变量，不落库；`chunk.content` 保持原文。回填给 LLM、返回给前端的 source，都是干净的原文——前缀只为向量服务，绝不污染内容。所以我连 `DocumentChunk` 的字段都没加。
- **失败就降级**。开关关 / 没有 client / 子块或上下文为空 / LLM 抛异常 / 返回空串，全部回退成「不加前缀、直接用原文」，绝不让一次 LLM 抖动卡死整个入库。这个降级理念和我之前的单轮 query 改写是一致的。

## 4. 怎么做到零回归

这轮一口气加了三个功能，我给自己定的底线还是那条：**默认什么都不开，现有测试一个不挂。**

- 三个开关默认都是关 / FIXED：`strategy=FIXED`、`parent-document.enabled=false`、`contextual.enabled=false`。默认配置下，入库链路逐字节等同改造前。
- 新功能全部是「新增类 + 新增接口实现」，没去改老类的行为；构造器都保留了无依赖的重载，存量测试一行不用动。
- 每个功能先 TDD 写测试再实现：FixedWindow 行为/ID 稳定、Markdown 标题切分 + 面包屑 + 超长 section 回退、Semantic 断块（用假 EmbeddingClient 注入，不依赖真端点）、父块回填 + 去重、Contextual 前缀拼接 + 缓存前缀注入 + 失败降级……

跑下来分块 +17、Contextual +8 个测试，全量 **135 通过 / 0 失败**（加上后面多模态、多轮两轮，最终到 167）。

## 5. 量化：诚实说，严格对比还没跑

可量化的指标是 **FIXED vs MARKDOWN+parent vs +contextual** 的 **Hit@K / context precision / recall**。但我这轮先把「能力 + 零回归」做实了，**严格的 eval 对比留到评估集扩展之后再跑**——原来的评估集只有 26 题、还是弱标注（只有关键词、没有标准答案），拿它得出的数字我自己都不信。所以这块我没编数字，复现配方写在了项目 `docs/eval-metrics.md` 里：同一评估集、同一检索模式，只切对应开关跑两遍 harness 对照即可。

单测级已经确证的行为：MARKDOWN 对 `# 安装 / ## 环境要求 / ## 下载` 切出 3 个有正文的 section → 3 父块 3 子块、子块带面包屑、parentId 正确；超长 section 回退为多子块共享同一父块；SEMANTIC 在相似度跌破阈值处断块；回填按 parentId 去重、sources 指向子块；MARKDOWN 入库后 parentId 能在 ParentStore 查到、删文档时父块同步清除。

## 6. 写在最后

这三件事拆开看是三个功能，连起来其实是一条完整的思路：

1. **结构化分块**（MARKDOWN）解决「标题和正文被切散」；
2. **独立父块**解决「检索要小块、生成要大块」的粒度矛盾；
3. **Contextual Retrieval** 给被切小的子块补回全局语境，并用 Prompt Caching 把成本压住。

代码量不算大，但每一处我都能讲清楚「当时为什么这么选」——独立父块为什么不反贴、前缀为什么不存进 content、为什么默认全关。对我来说，把一个朴素分块踏踏实实改成一套讲得通的检索召回方案，比再囫囵学一个新框架收获大得多。

下一篇想写**多模态**：让图片和 PDF 里的图也能被文本 query 召回——以及我在「真多模态 vs 伪多模态」上踩的一个挺典型的坑。

---
*配套代码：`com.yhl.rag.chunk` 包（TextSplitter 三实现 + ChunkingService）、`ParentStore` / `InMemoryParentStore` / `JdbcParentStore`、`ContextualEnricher`、配置 `rag.chunk` / `rag.contextual`。设计细节见仓库 `docs/chunking-strategy.md`、`docs/contextual-retrieval.md`。*
