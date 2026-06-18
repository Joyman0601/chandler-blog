---
title: "把内存向量库换成 pgvector：一次「守住简历声称」的工程改造"
description: "给 RAG 项目接上真·向量数据库 pgvector，用一个开关在内存与 pgvector 间切换，107 个测试零改动通过，复盘开关装配、SQL 权限下推、HNSW 三个设计决策。"
pubDate: 2026-06-19
tags: ["Java", "Spring Boot", "RAG", "pgvector", "PostgreSQL", "向量检索"]
series: "rag"
seriesLabel: "RAG 项目"
---

> 一句话总结：项目原本的 `VectorStore` 只有一个 `InMemoryVectorStore`——HashMap + 线性扫描，重启即丢。这次给它接上**真·向量数据库 pgvector**，用一个开关在「内存」和「pgvector」之间切换，**现有 107 个测试零改动通过**。改造的关键不是写多少代码，而是三个设计决策：怎么不破坏现有测试、怎么用 SQL 表达权限、怎么让向量检索和 BM25 在新后端里继续协同。

## 0. 为什么要做这件事

简历上写着「企业知识库 RAG」「向量检索」。但翻开代码，向量检索的唯一实现是这样的：

```java
// InMemoryVectorStore：把所有 chunk 塞进一个 HashMap
private final ConcurrentMap<String, Entry> entries = new ConcurrentHashMap<>();

// 检索时：遍历全部 entry，逐个算余弦相似度，排序取 topK
entries.values().stream()
        .filter(entry -> matchesFilter(entry.chunk(), request))
        .map(entry -> toSearchResult(entry, queryVector, ...))
        .sorted(...)
        .limit(request.getTopK())
```

这有两个硬伤：

1. **重启即丢**——数据全在内存，进程一停，上传的所有文档和 embedding 全没了。
2. **线性扫描**——每次检索都把所有向量算一遍。几百条没事，几十万条就慢得没法用。

面试官只要问一句「你这向量库怎么选型的？百万级文档检索多久？索引怎么建的？」——线性扫描答不上来。这是简历最大的可信度缺口，所以优先级最高（我们内部叫它 P0）。

目标定得很克制：**只换向量库后端**，不动其他。新增一个 pgvector 实现，用开关切换，保留内存实现做默认值和单元测试。成功的标准是——**开关一关，一切照旧，107 个测试一个不挂**。

## 1. pgvector 是什么

PostgreSQL 大家都熟，它是关系型数据库。**pgvector 是 PostgreSQL 的一个扩展**，装上之后，PG 就多了一个 `vector` 数据类型和一套向量运算能力。

```sql
CREATE EXTENSION IF NOT EXISTS vector;        -- 装扩展
embedding vector(4096)                         -- 一个能存 4096 维向量的列
```

它支持三种距离运算符：

- `<=>` 余弦距离（cosine）
- `<->` 欧氏距离（L2）
- `<#>` 负内积

我们用 `<=>`，因为原内存实现算的就是余弦相似度，要对齐语义。

更关键的是 pgvector 支持 **ANN 索引**（近似最近邻），这正是它和「线性扫描」的本质区别——下面第一个设计点会细讲。

选 pgvector 而不是 Qdrant / Elasticsearch 的理由：一个 PostgreSQL 实例，既能做向量检索，又能顺手把后续要做的 usage 持久化、文档元数据落库一起解决，不用引入第二个组件。

## 2. 改造的全貌

```
pom.xml                          +spring-boot-starter-jdbc, postgresql
db/init/01_schema.sql            建表 + HNSW 索引 + 预留 usage 表
docker-compose.pgvector.yml      一键起 pgvector 容器
vector/PgVectorStore.java        新：pgvector 后端实现（核心）
vector/Bm25Scorer.java           新：抽出共享的 BM25 打分逻辑
vector/InMemoryVectorStore.java  改：加一行开关注解，逻辑不动
application.yml                  加开关 + datasource 配置
vector/PgVectorStoreIT.java      新：连真 PG 的集成测试
```

代码不多。真正花心思的是接下来三个设计点。下面我尽量从「为什么这么做」讲起，而不是「做了什么」。

---

## 设计点一：用开关装配，做到「零回归」

### 问题

我要新增 `PgVectorStore`，但**绝对不能动** `InMemoryVectorStore`，原因是：现有测试代码里到处直接 `new InMemoryVectorStore()`，甚至有个测试还继承了它：

```java
// RagSearchCacheTest 里
private static class CountingVectorStore extends InMemoryVectorStore { ... }
```

如果我把内存实现删了或改了构造函数，这些测试全得跟着改——这就违背了「零回归」。

### Spring 是怎么决定用哪个实现的

先补个背景。Spring 管理一堆「Bean」（被框架托管的对象）。当 `RagSearchService` 说「我需要一个 `VectorStore`」，Spring 会去所有候选实现里挑一个注入进去。

问题来了：现在有**两个** `VectorStore` 实现（内存的、pgvector 的）。Spring 默认会困惑——「两个都行，我该给你哪个？」然后启动报错。

### 解法：@ConditionalOnProperty

我给两个实现各加一个**条件注解**，让它们「按配置开关决定自己要不要被启用」：

```java
// 内存实现：当 vectorstore.backend=memory 时启用；没配置时也默认启用（matchIfMissing）
@Component
@ConditionalOnProperty(name = "vectorstore.backend", havingValue = "memory", matchIfMissing = true)
public class InMemoryVectorStore implements VectorStore { ... }

// pgvector 实现：只有当 vectorstore.backend=pgvector 时才启用
@Component
@ConditionalOnProperty(name = "vectorstore.backend", havingValue = "pgvector")
public class PgVectorStore implements VectorStore { ... }
```

`@ConditionalOnProperty` 的意思是「**只有当某个配置项等于某个值时，这个 Bean 才存在**」。

- 配置 `vectorstore.backend=memory`（或干脆不配，靠 `matchIfMissing=true` 兜底）→ 只有内存实现存在。
- 配置 `vectorstore.backend=pgvector` → 只有 pgvector 实现存在。

**任何时刻只有一个 `VectorStore` 存在**，Spring 不再困惑。而 `RagSearchService` / `DocumentService` 只依赖 `VectorStore` 这个接口，它们根本不知道也不关心背后是哪个实现——**换实现对它们完全透明**。

### 为什么这样就「零回归」

- 默认值是 `memory`，所以你什么都不改、直接跑测试时，用的还是内存实现，行为和以前一模一样。
- 测试代码里 `new InMemoryVectorStore()` 是**手动 new**，绕过了 Spring 的装配，跟开关无关，照样能跑。
- pgvector 实现只在你显式打开开关时才登场。

这就是「零回归」的底层逻辑：**新增而非修改，用配置隔离两条路径**。我跑完全量测试，107 个全过，包括那个验证「Spring 容器能正常启动」的 `ApplicationContextSmokeTest`——证明默认 memory 模式下容器装配没被我搞坏。

> 还有个隐藏的坑：加了数据库依赖后，Spring 默认会尝试连数据库，没有 DB 就启动失败。但 memory 模式不该需要数据库。所以我在默认配置里**排除了数据库自动配置**（`DataSourceAutoConfiguration`），只在 pgvector 模式下才重新启用它。这样 memory 模式下裸启动，完全不碰数据库。

---

## 设计点二：用 SQL WHERE 表达权限过滤

这是这次改造最有「含金量」的一点。

原内存实现里，权限过滤是用 Java 代码一条条判断的。比如「这个 chunk 当前用户能不能看见」：

```java
// InMemoryVectorStore.canAccess（简化）
if (visibility == PRIVATE)    return userId.equals(chunk.getOwnerId());          // 私有：只有主人能看
if (visibility == DEPARTMENT) return departmentIds.contains(chunk.getDepartmentId()); // 部门：同部门能看
if (visibility == TENANT || visibility == PUBLIC) return true;                   // 租户/公开：都能看
if (visibility == CUSTOM)     return 命中 allowedUserIds 或 allowedRoleIds;        // 自定义：白名单
```

它的工作方式是：**先把所有 chunk 拉进内存，再用这些 if 一个个过滤掉没权限的**。

到了 pgvector，数据在数据库里，我不可能把几十万条全拉进内存再过滤——那就白用数据库了。正确做法是：**把这套权限逻辑翻译成 SQL 的 WHERE 条件，让数据库在检索时就只返回有权限的数据。**

### 翻译后长什么样

```sql
SELECT *, 1 - (embedding <=> ?::vector) AS score
FROM document_chunk
WHERE tenant_id = ?                              -- 租户隔离：只看自己租户的
  AND status = ? AND document_status = ?         -- 状态过滤：只看 ACTIVE/READY 的
  AND (                                           -- 权限分支（对应上面那些 if）：
        visibility IN ('TENANT', 'PUBLIC')                          -- 租户/公开
     OR (visibility = 'PRIVATE'    AND owner_id = ?)                -- 私有：是我的
     OR (visibility = 'DEPARTMENT' AND department_id IN (?, ?))     -- 部门：我的部门
     OR (visibility = 'CUSTOM'     AND (                            -- 自定义白名单：
            allowed_user_ids @> ARRAY[?]::text[]                    --   用户白名单含我
         OR allowed_role_ids && ?::text[]                           --   或角色白名单和我有交集
        ))
      )
ORDER BY embedding <=> ?::vector                  -- 按余弦距离排序（最像的在前）
LIMIT ?                                            -- 取 topK
```

几个值得讲的细节：

**1）`1 - (embedding <=> ?::vector) AS score`**
`<=>` 算的是余弦**距离**（越小越像，范围 0~2），而原代码用的是余弦**相似度**（越大越像，范围 -1~1）。`相似度 = 1 - 距离`，这一步换算是为了让新后端返回的 score 和老实现语义完全一致，上层的「分数阈值过滤」逻辑才不用改。

**2）数组运算符 `@>` 和 `&&`**
CUSTOM 可见性有两个白名单：允许的用户列表、允许的角色列表，在 PG 里存成数组类型 `text[]`。

- `allowed_user_ids @> ARRAY['user_001']`：「这个数组**包含** user_001 吗」——判断用户在不在白名单。
- `allowed_role_ids && ['finance','hr']`：「两个数组**有没有交集**」——判断用户的角色和白名单角色有没有重叠。

这两个是 PostgreSQL 数组的原生运算符，配合 GIN 索引能走索引、很快。

**3）参数化查询，不是拼字符串**
所有用户传入的值（userId、部门、角色）都用 `?` 占位、用参数传进去，**绝不直接拼进 SQL 字符串**。这是防 SQL 注入的基本功——如果把 userId 直接拼进去，攻击者传个 `' OR 1=1 --` 就能绕过所有权限。

### 为什么这是个好卖点

「权限过滤下推到数据库」是企业级检索系统的标准做法，它体现两件事：

- 你理解**为什么不能把数据全捞出来在应用层过滤**（性能 + 安全）。
- 你知道**租户隔离、行级权限这些事 SQL 天然能做**，而且能做得又快又安全。

面试时这一段可以讲：「我把 visibility 的五种可见性翻译成 SQL 的 OR 分支，租户隔离是 WHERE 第一条，CUSTOM 白名单用 PG 数组的包含/交集运算符配 GIN 索引，全程参数化防注入。」——这比「我做了权限隔离」具体得多。

---

## 设计点三：向量检索走 HNSW，BM25 留在应用层

### 先讲 HNSW——这是「线性扫描」的解药

回到最开始的痛点：内存实现每次检索都把**所有**向量算一遍余弦相似度，这叫**暴力检索（brute-force）**，复杂度是 O(N)，N 是文档数。十万条就是十万次计算，慢。

**ANN（Approximate Nearest Neighbor，近似最近邻）** 是解法：不追求「绝对找到最像的」，而是「极大概率找到最像的几个」，用一点点精度换巨大的速度提升。

**HNSW（Hierarchical Navigable Small World，分层可导航小世界）** 是目前最主流的 ANN 索引。打个比方：

> 想象你要在一座城市找离你最近的咖啡店。暴力法是挨个量遍全城每家店的距离。HNSW 的做法像「先看高速公路网，快速跳到大概区域；再看城市主干道，缩小到那个街区；最后走街串巷，精确定位」。它把向量组织成**多层图**：上层稀疏、跳得远，下层密集、找得准。查询时从上往下逐层逼近，跳过绝大多数无关向量。

建索引的 SQL：

```sql
CREATE INDEX ON document_chunk USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);
```

- `vector_cosine_ops`：告诉索引「我用余弦距离」（要和查询用的 `<=>` 对应）。
- `m = 16`：每个节点在图里连多少条边。越大越准、但索引越大越慢建。
- `ef_construction = 64`：建索引时每步考察多少候选。越大越准、建得越慢。

这就是「**召回率 vs 延迟**」的权衡——HNSW 的所有参数本质都在调这个跷跷板。面试问「百万级怎么办」，答案就是「建 HNSW 索引，O(N) 暴力扫描降到接近 O(log N)，再根据召回率要求调 m / ef_search」。

### 那 BM25 呢？为什么留在应用层

我的项目是**混合检索**：向量检索（找语义相似）+ BM25 关键词检索（找字面精确匹配，比如订单号 A12345）+ RRF 融合。

向量检索好办，交给 pgvector 的 HNSW。但 BM25 怎么办？有两条路：

1. **用 PG 的全文检索**（`to_tsvector` / `ts_rank`）。但中文分词要额外装 `zhparser` / `pg_jieba` 扩展，装起来麻烦，而且和原来手写的 BM25 行为不一定一致。
2. **BM25 继续在应用层算**：先用 SQL（带上面那套权限 WHERE）把候选 chunk 捞出来，再在 Java 内存里跑原来那套 BM25 打分。

我选了 **2**。理由：

- 改动最小，**行为和内存实现完全一致**（用的是同一份 BM25 代码）。
- 大语料下加了个候选上限（`LIMIT 2000`）兜底，不会把全表拉进内存。
- 面试照样讲得通：「稠密召回走 HNSW 索引，关键词召回在应用层用 BM25，两路结果再 RRF 融合。」

### 顺手做的一个小重构：抽出 Bm25Scorer

原来 BM25 的分词和打分逻辑（约 80 行）写死在 `InMemoryVectorStore` 里、是私有方法。现在两个后端都要用它，我把它抽成一个独立的工具类 `Bm25Scorer`：

```java
public final class Bm25Scorer {
    // 内存和 pgvector 两个后端共用这一份打分逻辑，保证混合检索行为一致
    public static List<VectorSearchResult> score(String queryText, List<DocumentChunk> corpus, int topK) { ... }
}
```

内存实现和 pgvector 实现都调它，**不重复代码、行为天然一致**。这也是为什么 `keywordSearch` 相关的测试不用改——逻辑搬了家，但算出来的分数一模一样。

---

## 3. 怎么验证

**默认 memory 模式（不需要数据库）：**

```bash
mvn test    # 107 passed, 0 failed —— 证明零回归
```

**pgvector 真路径：**

```bash
# 1. 一键起带 pgvector 的 PostgreSQL，初始化 SQL 自动执行
docker compose -f docker-compose.pgvector.yml up -d

# 2. 跑连真库的集成测试（默认禁用，设了 PG_URL 才跑）
PG_URL=jdbc:postgresql://localhost:5432/rag PG_USER=rag PG_PASSWORD=rag \
  mvn test -Dtest=PgVectorStoreIT

# 3. 想看索引有没有生效，连进去 EXPLAIN ANALYZE 看执行计划是否命中 HNSW
```

集成测试 `PgVectorStoreIT` 故意做成「只在设了 `PG_URL` 时才运行」，没有 PG 的环境（比如 CI）自动跳过，不影响默认全绿。它覆盖的场景和内存实现的单元测试一一对应：权限过滤、版本过滤、私有/部门/自定义可见性、关键词检索、向量 round-trip——**确保 SQL 翻译后的行为和内存语义完全一致**。

## 4. 小结

这次改造的「工程叙事」是：

1. **诊断**：简历声称「向量检索」，但实现是内存线性扫描，扛不住面试追问。
2. **设计**：三个关键决策——开关装配保零回归、SQL WHERE 表达权限、HNSW 管向量 + BM25 留应用层。
3. **验证**：memory 默认 107 测试零回归，pgvector 真路径有 env-gated 集成测试覆盖。

代码量不大，但每一处都能在面试里讲出「为什么」。比堆一个新框架更能体现工程判断力。

下一步可以做：把 usage 用量也落进同一个 PG（DDL 已经预留了 `usage_record` 表），让「成本治理可审计」也从内存升级成持久化——这就是下一篇 [《让 usage 用量从内存落到 PostgreSQL》](/blog/rag-usage-persistence/) 的内容。

---
*配套代码：开关 `vectorstore.backend`、pgvector 实现 `PgVectorStore`、共享打分 `Bm25Scorer`、建表 `db/init/01_schema.sql`、集成测试 `PgVectorStoreIT`。*
