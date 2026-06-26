---
title: "多模态 RAG 踩坑：4096 维的「VL embedding」其实分不清红图和蓝图"
description: "想让图片和 PDF 里的图也能被文本 query 召回，于是给 RAG 接 VL embedding。结果发现一个挺反直觉的坑：同样叫『Qwen3-VL-Embedding』，走 OpenAI 兼容的 /v1/embeddings 端点是伪多模态——它把图片当成 base64 字符串 embedding，连红图蓝图都分不开；走 DashScope 原生多模态端点才是真的。记录这个区别，以及真多模态向量空间怎么落地。"
pubDate: 2026-06-26
tags: ["Java", "Spring Boot", "RAG", "多模态", "Embedding", "Qwen-VL", "PDFBox"]
series: "rag"
seriesLabel: "RAG 项目"
---

> 一句话总结：想让图片和 PDF 里的图也能被文本 query 召回，给 RAG 接了 VL embedding。本来以为是「换个模型」的小事，结果踩到一个挺典型的坑——**同样是 Qwen3-VL-Embedding，走 OpenAI 兼容的 `/v1/embeddings` 是伪多模态**（把图片当 base64 字符串 embed，红图蓝图都分不开），**走 DashScope 原生多模态端点才是真的**。这篇记录这个区别，以及真·多模态向量空间是怎么落地的。开关默认关，纯文本路径零回归。

## 0. 真多模态 vs 伪多模态

把图片接进 RAG，有两条路，差别很大：

1. **图转文再 embedding**（伪多模态）：先用一个 caption / OCR 模型把图描述成文字，再对那段文字做普通文本 embedding。检索时其实是「文字 query × 文字描述」——图片信息在「描述」那一步就被有损压扁了，描述里没提到的视觉细节，永远召不回。
2. **真·多模态向量空间**（我想做的）：用 VL embedding 模型直接对**图像本身**打向量，让它落在和文本 embedding **同一个**向量空间里。文本 query 的向量和图像向量直接算 cosine，「文字找图」就是一次普通的同空间近邻检索。

我想走第 2 条。前提是有一个能**同时**吃文本和图片、输出同维向量的 VL embedding 端点。我简历技术栈里写的是 `Qwen3-VL-Embedding-8B`，4096 维——听起来正合适。结果一上手就翻车了。

## 1. 坑：4096 维的向量，连红图和蓝图都分不开

我先用手头的 SiliconFlow `Qwen/Qwen3-VL-Embedding-8B`，它是 OpenAI 兼容的 `/v1/embeddings` 端点。我的 `embedImage` 实现很直觉：把图片编码成 data URL，丢进 `input` 字段。

```java
// 把图片当成一个字符串塞进 OpenAI /v1/embeddings 的 input
embedImage(bytes, mime) -> POST /v1/embeddings { "input": "data:image/png;base64,iVBORw0..." }
```

返回了 4096 维向量，HTTP 200，看着一切正常。但我写了个最朴素的验证：造一张**纯红** 64×64 图、一张**纯蓝**图，再造对应的中英文文本「红色」「蓝色」，算 cosine 看看「红色文本」是不是离红图更近。

结果离谱：

| | 红色文本 · 红图 | 红色文本 · 蓝图 |
| --- | --- | --- |
| SiliconFlow `/v1/embeddings` | 0.302 | **0.354** ← 反而离蓝图更近 |

红色文本居然离蓝图更近。原因想通之后挺哭笑不得：**OpenAI 的 `/v1/embeddings` 的 `input` 只认字符串**。我传进去的 data URL，它根本没当图片解码，而是把那一长串 base64 文本当普通字符串 embed 了。返回的 4096 维向量编码的是「base64 字符串的文本特征」，跟图像内容毫无关系——颜色当然分不开。

这就是**伪多模态**：模型名字带 VL、维度也对、调用也成功，但这个 API 形状根本喂不进图像。

## 2. 解：换成 DashScope 原生多模态端点

真正能吃图的，是 **DashScope 的原生多模态 embedding 端点** `qwen3-vl-embedding`。区别在 **API 形状**——它把图片作为结构化的 content 项，而不是字符串：

```java
// DashScope 原生：文本和图像都走结构化 contents 数组，同一模型同一空间
embed(text)            -> { "input": { "contents": [ { "text":  text } ] } }
embedImage(bytes,mime) -> { "input": { "contents": [ { "image": "data:...;base64,..." } ] } }
// 响应取 output.embeddings[0].embedding，文本和图像同为 2560 维，可直接 cosine
```

换上它再跑同一个红蓝测试：

| | 匹配（同色） | 不匹配（异色） |
| --- | --- | --- |
| 红色文本 · 图 | **0.738**（红图） | 0.433（蓝图） |
| 蓝色文本 · 图 | **0.683**（蓝图） | 0.443（红图） |

颜色匹配的「文本 × 图片」相似度，明显高于不匹配的。**纯文本 query 召回正确图片**，这才是真多模态。

所以我在 `EmbeddingClient` 里加了一个 `llm.embedding-style` 开关：

- `openai`（默认，零回归）：文本走 `/v1/embeddings`，图片也当字符串走同端点——**只有当端点真能吃图时才是真多模态**，像 SiliconFlow 这种就是伪的；
- `dashscope-multimodal`：文本和图像都走 DashScope 原生端点，图像作为结构化 `image` content 投出，对图像本身打向量——真多模态的落点。

> 给后来人也给我自己的提醒：别看到「VL」「多模态模型」就以为接上就能图文检索。**先用红蓝图这种最笨的办法验一下「文字能不能找到对的图」**，再往上搭。一个返回了正确维度、HTTP 200 的端点，完全可能在干一件和你以为的完全不同的事。

## 3. 真多模态落地：数据流

确认端点真能吃图之后，剩下的就是把图片接进入库链路。

```
上传 png/jpg ──────────────► 整张图 = 1 个 IMAGE chunk
上传 pdf ──► PDFBox 解析 ─┬─► 正文文本 ──► 现有文本分块链路 = TEXT chunk
                          └─► 内嵌图片对象 ──► 每张图 = 1 个 IMAGE chunk
上传 txt/md ──────────────► 现有文本链路（完全不变）

TEXT chunk  ──► EmbeddingClient.embed(text)        ┐
IMAGE chunk ──► EmbeddingClient.embedImage(bytes)  ┴─► 同一向量空间 ──► VectorStore
```

**检索链路完全不用动**：query 文本 embedding 后在同一向量空间里做近邻（vector / hybrid / rerank 都照旧），命中的 IMAGE chunk 和 TEXT chunk 一起按分数排序返回。这是「同一向量空间」最大的好处——多模态不是另起一套检索，而是让图像 chunk 混进现有检索里一起排。

几个组件：

- **`PdfParser`**（PDFBox，手写不引框架）：`PDFTextStripper` 抽正文走文本链路；遍历每页 XObject，把 `PDImageXObject` 渲染成 PNG 字节。我特意选**抽内嵌图片对象**而非整页渲染——只 embed 文档里真实存在的图，免得纯文字页也产出一张图污染召回。单张图解码失败只跳过、不中断整篇。
- **`ImageStore`**（demo 内存实现）：IMAGE chunk 不把图片字节塞进向量库，只存一个 `imageRef`，字节由 ImageStore 按 ref 持有，供展示/回填取回。生产里整体换成对象存储就行，`imageRef` 就是 objectKey 的占位，调用方不用改。
- **`DocumentChunk` 加 `modality`（TEXT 默认 / IMAGE）+ `imageRef`**：入库时按 modality 分派走 `embed` 还是 `embedImage`。IMAGE chunk 的 `content` 存一句展示用说明（如 `[图片] org-chart.png`），向量来自图像本身，content 只供 source 预览和 BM25 命中。

## 4. 零回归

老规矩，新功能不许动老路径：

- `rag.multimodal.enabled` 默认 **false**：关时上传仍只收 txt/md/markdown，一律按 UTF-8 文本走，和功能引入前逐字节一致。
- `modality` 列默认 `TEXT`，pgvector schema 加 `modality` / `image_ref` 两列（默认 TEXT / null），旧数据无需迁移。
- 构造器保留无 `PdfParser` / `ImageStore` 的重载，存量测试零改动。

测试先 TDD，新增 14 个：data URL 构造、DashScope 请求体构造、PDF 抽文本+图、ImageStore 增删查、图片上传建 IMAGE chunk 且走 `embedImage`（不走 `embed`）、纯文本零回归、开关开关行为、**图文混排小语料里纯文本 query 召回 IMAGE chunk**，再加一个 env-gated 的真实 DashScope 集成测试（就是上面红蓝图那个，用来挡伪多模态端点）。全量 **149 通过 / 0 失败**。

## 5. 写在最后

这个功能本身代码不多，但那个「4096 维却分不清红蓝」的坑，是我这轮收获最大的一个认知：

- **模型名字、向量维度、HTTP 200，三者都对，也不代表它在做你以为的事。** API 的「形状」（input 收字符串还是结构化 content）才决定了图像到底有没有被喂进去。
- **验证要用最笨、最不可能蒙对的办法。** 红图蓝图 + 颜色文本，是我能想到的最小可证伪实验——如果连这个都分不开，后面搭再多都是空中楼阁。

也因为这个坑，我把简历和文档里都标清楚了：文本 embedding 那 4096 维（SiliconFlow）属实，但**图像召回走的是 DashScope 的 2560 维**，两者别混为一谈。诚实标注比含糊带过让我踏实。

下一篇写**多轮会话 RAG**：怎么让「它的价格呢」这种带指代的追问，也能被检索正确理解。

---
*配套代码：`EmbeddingClient`（`embedImage` + `llm.embedding-style` 两风格）、`PdfParser`、`ImageStore`、`DocumentChunk.modality`、`EmbeddingClientLiveIT`（红蓝图真实端点验证）。设计与实测见仓库 `docs/multimodal-rag.md`。*
