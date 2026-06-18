---
title: "把内存里的向量库换成 pgvector"
description: "给自己的 RAG 学习项目接上真正的向量数据库 pgvector，用一个开关在内存和 pgvector 之间切换，现有 107 个测试零改动通过。记录开关装配、SQL 权限下推、HNSW 三个我琢磨了挺久的设计点。"
pubDate: 2026-06-19
tags: ["Java", "Spring Boot", "RAG", "pgvector", "PostgreSQL", "向量检索"]
series: "rag"
seriesLabel: "RAG 项目"
---

> 一句话总结：我这个 RAG 项目的 `VectorStore` 一直只有一个 `InMemoryVectorStore`——HashMap + 线性扫描，重启就全没了。这次给它接上真正的向量数据库 **pgvector**，用一个开关在「内存」和「pgvector」之间切换，**现有 107 个测试一行没改就全过了**。代码其实没多少，真正花时间的是三个设计点：怎么不把现有测试搞挂、怎么用 SQL 表达权限、怎么让向量检索和 BM25 在新后端里继续配合。

## 0. 起因

这是我边学边搭的一个 RAG 项目。某天回头看代码，发现「向量检索」这个我一直挂在嘴边的核心能力，实现居然是这样的：

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

当 demo 跑当然没问题，但它有两个我自己都过不去的硬伤：

1. **重启即丢**——数据全在内存，进程一停，上传的所有文档和 embedding 全没了。每次重启都要重新灌一遍数据，烦。
2. **线性扫描**——每次检索都把所有向量算一遍。几百条无所谓，真到几十万条就慢得没法用了。

说白了，这根本不算「向量检索」，只是「在内存里遍历算余弦」。这块我一直想补，索性这回当成最优先的事来做。

目标我定得很克制：**只换向量库后端**，别的不动。新增一个 pgvector 实现，用开关切换，内存实现保留下来当默认值和单元测试用。我给自己定的成功标准就一条——**开关一关，一切照旧，107 个测试一个不挂**。

## 1. pgvector 是什么

PostgreSQL 大家都熟，关系型数据库。**pgvector 是它的一个扩展**，装上之后 PG 就多了一个 `vector` 数据类型和一套向量运算能力。

```sql
CREATE EXTENSION IF NOT EXISTS vector;        -- 装扩展
embedding vector(4096)                         -- 一个能存 4096 维向量的列
```

它支持三种距离运算符：

- `<=>` 余弦距离（cosine）
- `<->` 欧氏距离（L2）
- `<#>` 负内积

我用 `<=>`，因为原来的内存实现算的就是余弦相似度，得对齐语义，不然结果会对不上。

更关键的是 pgvector 支持 **ANN 索引**（近似最近邻），这正是它跟「线性扫描」的本质区别——下面第一个设计点会细讲。

为什么选 pgvector 而不是 Qdrant / Elasticsearch？主要是图省事：一个 PostgreSQL 实例，既能做向量检索，又能顺手把后面想做的 usage 持久化、文档元数据落库一起解决，不用再多引入一个组件。学习项目，能少装一个是一个。

## 2. 改了哪些东西

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

文件不多。真正让我琢磨了挺久的是接下来三个设计点，下面我尽量讲「我当时为什么这么想」，而不是干巴巴列「做了什么」。

---

## 设计点一：用开关装配，做到「零回归」

### 我担心的事

我要新增 `PgVectorStore`，但**特别不想动** `InMemoryVectorStore`。因为现有测试代码里到处直接 `new InMemoryVectorStore()`，甚至有个测试还继承了它：

```java
// RagSearchCacheTest 里
private static class CountingVectorStore extends InMemoryVectorStore { ... }
```

只要我把内存实现删了或者改了构造函数，这些测试就得跟着改一圈。改测试这种事一旦开始就停不下来，很容易越改越乱，所以我一开始就告诉自己：内存实现一个字都别动。

### Spring 怎么决定用哪个实现

先补个背景，怕后来的我自己忘了。Spring 管理一堆「Bean」（被它托管的对象）。当 `RagSearchService` 说「我需要一个 `VectorStore`」，Spring 会从所有候选实现里挑一个注入进去。

问题来了：现在有**两个** `VectorStore` 实现（内存的、pgvector 的）。Spring 默认就懵了——「俩都行，我给你哪个？」然后启动直接报错。

### 解法：@ConditionalOnProperty

我给两个实现各加一个**条件注解**，让它们「自己看配置决定要不要被启用」：

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

`@ConditionalOnProperty` 的意思就是「**只有某个配置项等于某个值时，这个 Bean 才存在**」。

- 配 `vectorstore.backend=memory`（或者干脆不配，靠 `matchIfMissing=true` 兜底）→ 只有内存实现存在。
- 配 `vectorstore.backend=pgvector` → 只有 pgvector 实现存在。

**任何时刻都只有一个 `VectorStore` 存在**，Spring 就不懵了。而 `RagSearchService` / `DocumentService` 只依赖 `VectorStore` 这个接口，它们根本不知道、也不关心背后是哪个实现——**换实现对它们完全透明**。这一点我挺满意的，写的时候没动一行业务代码。

### 为什么这样就「零回归」

- 默认值是 `memory`，所以什么都不改、直接跑测试，用的还是内存实现，行为和以前一模一样。
- 测试里的 `new InMemoryVectorStore()` 是**手动 new**，绕过了 Spring 的装配，跟开关压根没关系，照样能跑。
- pgvector 实现只在显式打开开关时才登场。

这就是「零回归」的底层逻辑：**新增而不是修改，用配置把两条路径隔开**。我跑完全量测试，107 个全过，包括那个验证「Spring 容器能正常启动」的 `ApplicationContextSmokeTest`——说明默认 memory 模式下容器装配没被我搞坏，这下放心了。

> 中途还踩了个隐藏的坑：加了数据库依赖后，Spring 默认会尝试连数据库，没 DB 就启动失败。但 memory 模式根本不该需要数据库啊。于是我在默认配置里**排除了数据库自动配置**（`DataSourceAutoConfiguration`），只在 pgvector 模式下才把它重新启用。这样 memory 模式裸启动，完全不碰数据库。

---

## 设计点二：用 SQL WHERE 表达权限过滤

这一点是我整个改造里最有意思、也最费脑子的地方。

原来的内存实现里，权限过滤是用 Java 代码一条条判断的。比如「这个 chunk 当前用户能不能看见」：

```java
// InMemoryVectorStore.canAccess（简化）
if (visibility == PRIVATE)    return userId.equals(chunk.getOwnerId());          // 私有：只有主人能看
if (visibility == DEPARTMENT) return departmentIds.contains(chunk.getDepartmentId()); // 部门：同部门能看
if (visibility == TENANT || visibility == PUBLIC) return true;                   // 租户/公开：都能看
if (visibility == CUSTOM)     return 命中 allowedUserIds 或 allowedRoleIds;        // 自定义：白名单
```

它的逻辑是：**先把所有 chunk 拉进内存，再用这些 if 一个个过滤掉没权限的**。

但到了 pgvector，数据在数据库里，我总不能把几十万条全拉进内存再过滤吧——那数据库不就白用了。正确的做法是：**把这套权限逻辑翻译成 SQL 的 WHERE 条件，让数据库在检索时就只返回有权限的数据。** 这个「翻译」过程我前前后后改了好几版才对齐。

### 翻译后长这样

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

几个我自己觉得有点东西的细节：

**1）`1 - (embedding <=> ?::vector) AS score`**
`<=>` 算的是余弦**距离**（越小越像，范围 0~2），而原代码用的是余弦**相似度**（越大越像，范围 -1~1）。`相似度 = 1 - 距离`，加这一步换算，是为了让新后端返回的 score 和老实现语义完全一致，上层那套「分数阈值过滤」就不用动了。一开始我忘了换算，结果排序全反了，debug 了好一会儿才反应过来。

**2）数组运算符 `@>` 和 `&&`**
CUSTOM 可见性有两个白名单：允许的用户列表、允许的角色列表，在 PG 里存成数组类型 `text[]`。

- `allowed_user_ids @> ARRAY['user_001']`：「这个数组**包含** user_001 吗」——判断用户在不在白名单。
- `allowed_role_ids && ['finance','hr']`：「两个数组**有没有交集**」——判断用户的角色和白名单角色有没有重叠。

这俩是 PostgreSQL 数组的原生运算符，配合 GIN 索引能走索引、很快。第一次用，挺惊喜的。

**3）参数化查询，不是拼字符串**
所有用户传进来的值（userId、部门、角色）都用 `?` 占位、用参数传进去，**绝不直接拼进 SQL 字符串**。这是防 SQL 注入的基本功——要是把 userId 直接拼进去，别人传个 `' OR 1=1 --` 就能绕过所有权限了。

### 为什么我觉得这步值得

把权限过滤「下推到数据库」，是真实系统里该有的做法。写完之后我自己想通了两件以前模模糊糊的事：

- 为什么不能把数据全捞出来在应用层过滤——又慢又有安全隐患，数据多了直接拖垮内存。
- 租户隔离、行级权限这些事，SQL 天然就能做，而且能做得又快又安全，不用自己在 Java 里堆 if。

把 visibility 的五种可见性翻译成 SQL 的 OR 分支、租户隔离放 WHERE 第一条、CUSTOM 白名单用数组运算符配 GIN 索引——这套东西真正写一遍，比看十篇博客都记得牢。

---

## 设计点三：向量检索走 HNSW，BM25 留在应用层

### 先讲 HNSW——「线性扫描」的解药

回到最开始的痛点：内存实现每次检索都把**所有**向量算一遍余弦相似度，这叫**暴力检索（brute-force）**，复杂度 O(N)，N 是文档数。十万条就是十万次计算，慢。

**ANN（Approximate Nearest Neighbor，近似最近邻）** 是解法：不追求「绝对找到最像的那个」，而是「极大概率找到最像的那几个」，用一点点精度换巨大的速度。

**HNSW（Hierarchical Navigable Small World，分层可导航小世界）** 是现在最主流的 ANN 索引。我自己理解的时候打了个比方：

> 想象你要在一座城市找离你最近的咖啡店。暴力法是挨家挨户量遍全城。HNSW 像是「先看高速路网，快速跳到大概区域；再看城市主干道，缩小到那个街区；最后走街串巷精确定位」。它把向量组织成**多层图**：上层稀疏、跳得远，下层密集、找得准。查询时从上往下逐层逼近，跳过绝大多数无关向量。

建索引的 SQL：

```sql
CREATE INDEX ON document_chunk USING hnsw (embedding vector_cosine_ops)
    WITH (m = 16, ef_construction = 64);
```

- `vector_cosine_ops`：告诉索引「我用余弦距离」（要和查询用的 `<=>` 对应）。
- `m = 16`：每个节点在图里连多少条边。越大越准，但索引越大、建得越慢。
- `ef_construction = 64`：建索引时每步考察多少候选。越大越准，建得越慢。

这俩参数本质都在调同一个跷跷板：**召回率 vs 延迟**。数据量真上来以后，把 O(N) 的暴力扫描换成接近 O(log N) 的 HNSW，再根据召回要求调 m / ef_search，是个能一直往下抠的方向。

### 那 BM25 呢？为什么留在应用层

我这项目是**混合检索**：向量检索（找语义相似）+ BM25 关键词检索（找字面精确匹配，比如订单号 A12345）+ RRF 融合。

向量检索好办，交给 pgvector 的 HNSW。但 BM25 怎么办？我想了两条路：

1. **用 PG 的全文检索**（`to_tsvector` / `ts_rank`）。但中文分词得额外装 `zhparser` / `pg_jieba` 扩展，装起来麻烦，而且跟我原来手写的 BM25 行为不一定一致。
2. **BM25 继续在应用层算**：先用 SQL（带上面那套权限 WHERE）把候选 chunk 捞出来，再在 Java 内存里跑原来那套 BM25 打分。

我选了 **2**。理由：

- 改动最小，**行为和内存实现完全一致**（用的就是同一份 BM25 代码）。
- 大语料下加了个候选上限（`LIMIT 2000`）兜底，不会把全表拉进内存。
- 整体也说得通：稠密召回走 HNSW 索引，关键词召回在应用层用 BM25，两路结果再 RRF 融合。

折腾全文检索的中文分词，对一个学习项目来说收益不大，留个 TODO 以后真有需要再说。

### 顺手做的一个小重构：抽出 Bm25Scorer

原来 BM25 的分词和打分逻辑（约 80 行）写死在 `InMemoryVectorStore` 里，是私有方法。现在两个后端都要用它，我把它抽成了一个独立的工具类 `Bm25Scorer`：

```java
public final class Bm25Scorer {
    // 内存和 pgvector 两个后端共用这一份打分逻辑，保证混合检索行为一致
    public static List<VectorSearchResult> score(String queryText, List<DocumentChunk> corpus, int topK) { ... }
}
```

两个实现都调它，**不重复代码、行为天然一致**。这也是为什么 `keywordSearch` 相关的测试不用改——逻辑搬了个家，但算出来的分数一模一样。

---

## 3. 怎么验证的

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

# 3. 想看索引到底有没有生效，连进去 EXPLAIN ANALYZE 看执行计划是否命中 HNSW
```

集成测试 `PgVectorStoreIT` 我故意做成「只在设了 `PG_URL` 时才运行」，没有 PG 的环境自动跳过，不影响默认全绿。它覆盖的场景和内存实现的单元测试一一对应：权限过滤、版本过滤、私有/部门/自定义可见性、关键词检索、向量 round-trip——就是为了确认 SQL 翻译之后的行为，和内存语义真的完全一致。

## 4. 写在最后

这次改造对我来说其实是一条挺完整的小闭环：

1. **先发现问题**：嘴上说「向量检索」，实现是内存线性扫描，重启还会丢数据。
2. **再想清楚怎么改**：开关装配保零回归、SQL WHERE 表达权限、HNSW 管向量 + BM25 留应用层。
3. **最后验证**：memory 默认 107 测试零回归，pgvector 真路径有 env-gated 集成测试覆盖。

代码量不大，但每一处我都能说清楚「当时为什么这么选」。对我来说，这种把一个 demo 级实现踏踏实实改成像样东西的过程，比再学一个新框架收获大多了。

下一步想把 usage 用量也落进同一个 PG（建表时 DDL 已经预留了 `usage_record` 表），让成本记录也从内存升级成能持久化、能查的——就是下一篇 [《把 usage 用量从内存搬进 PostgreSQL》](/blog/rag-usage-persistence/) 的内容。

---
*配套代码：开关 `vectorstore.backend`、pgvector 实现 `PgVectorStore`、共享打分 `Bm25Scorer`、建表 `db/init/01_schema.sql`、集成测试 `PgVectorStoreIT`。*
