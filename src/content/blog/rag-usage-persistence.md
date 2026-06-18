---
title: "把 usage 用量从内存搬进 PostgreSQL"
description: "把每次 LLM 调用的 token/成本从一个内存 List 落到 PostgreSQL 的 usage_record 表，再加一个按租户、时间窗聚合的只读接口。沿用上一篇内存默认+开关切换的模式，110 个测试零回归。"
pubDate: 2026-06-20
tags: ["Java", "Spring Boot", "RAG", "PostgreSQL", "成本治理"]
series: "rag"
seriesLabel: "RAG 项目"
---

> 一句话总结：我这个 RAG 项目原本把每次 LLM 调用的 token / 成本记录塞在一个内存 List 里——重启就没，也没法查。这次把它落到 PostgreSQL 的 `usage_record` 表，再加了一个按租户、时间窗聚合的查询接口 `GET /api/usage/summary`，让「成本能算清、能回溯」从一句空话变成真能跑的接口。沿用上一篇 pgvector 改造的同一套「内存默认 + 开关切换」模式，**110 个测试零回归**。
>
> 建议先读 [《把内存里的向量库换成 pgvector》](/blog/rag-pgvector-migration/)，本篇的开关装配思路就是它的延续。

## 0. 起因

项目里其实早就有一套「成本记录」：每次调大模型，都会记一条 `UsageRecord`——谁调的（user/tenant）、调的哪个接口、哪个模型、花了多少 token（含缓存命中的 cachedTokens）、估算成本、延迟、成功还是失败。字段看着挺全。但存储是这样的：

```java
// 改造前的 UsageRecordService：一个进程内的 List
private final List<UsageRecord> records = new CopyOnWriteArrayList<>();

public void record(UsageRecord r) { records.add(r); }
public List<UsageRecord> list()   { return List.copyOf(records); }
```

我自己用着用着就觉得不对劲，两个问题：

1. **重启即丢**——所有用量记录在内存里，进程一停全没了。想看「这个月一共花了多少」，根本无从谈起。
2. **没法查**——只有一个「把所有记录全列出来」的 `list()`，没有「按租户、按时间段、按模型汇总」的能力。想知道「A 租户这个月花了多少」？做不到。

所以这套「成本记录」其实只是个临时缓冲，谈不上真能用。上一篇把向量库换成 pgvector 之后，既然 PG 已经在那儿了，顺手把这块也补上。

这回的目标也很清楚：**usage 落 PG 表 + 一个按租户/时间查汇总的只读接口**。还是老规矩，零回归。

## 1. 改了哪些东西

```
cost/UsageRecordRepository.java              新：存储抽象接口
cost/InMemoryUsageRecordRepository.java      新：内存实现（默认）
cost/JdbcUsageRecordRepository.java          新：JDBC 实现（pgvector 开关下启用）
cost/UsageRecordService.java                 改：从“自己存”改成“委托给 Repository”
cost/UsageSummaryRow.java                    新：汇总结果的一行
cost/UsageSummaryResponse.java               新：汇总接口的响应体
cost/UsageController.java                     新：GET /api/usage/summary 只读接口
db/init/01_schema.sql                         usage_record 表从“预留”转正 + 加索引
cost/InMemoryUsageRecordRepositoryTest.java   新：聚合逻辑单测（恒跑）
cost/JdbcUsageRecordRepositoryIT.java         新：连真 PG 的集成测试（env-gated）
```

下面讲三个设计点。第一点是上一篇的延续，会快一些；后两点是这次新琢磨的。

---

## 设计点一：保留无参构造，零回归（复用上一篇那套）

### 我担心的事

跟上次一模一样：我想把存储换成「内存 / 数据库」两种可切换的后端，但**不想破坏现有代码**。这次的麻烦更具体——项目里有 **5 处**直接 `new UsageRecordService()`，生产代码和测试都有：

```java
// 测试里直接 new，还断言 list() 的内容
UsageRecordService usageRecordService = new UsageRecordService();
service.recordUsage(...);
assertThat(usageRecordService.list()).hasSize(2);   // 必须还能这么用
```

要是我把 `UsageRecordService` 改成「必须注入一个 Repository 才能 new」，这 5 处全得跟着改。又是那个老问题：一改就停不下来。

### 解法：委托 + 无参构造兜底

我把 `UsageRecordService` 从「自己拿 List 存」改成「**委托给一个 Repository**」，但**保留一个无参构造**，里头默认 new 一个内存 Repository：

```java
@Service
public class UsageRecordService {

    private final UsageRecordRepository repository;

    @Autowired                                              // Spring 走这个：注入开关选出的实现
    public UsageRecordService(UsageRecordRepository repository) {
        this.repository = repository;
    }

    public UsageRecordService() {                           // 手动 new 走这个：默认内存，行为不变
        this(new InMemoryUsageRecordRepository());
    }

    public void record(UsageRecord r) { repository.save(r); }
    public List<UsageRecord> list()   { return repository.findAll(); }
}
```

- 测试和老代码里的 `new UsageRecordService()` → 走无参构造 → 内部是内存实现 → `list()` 行为和以前**完全一样**。
- Spring 启动时 → 走带 `@Autowired` 的构造 → 注入「开关选出来的」Repository（内存或 JDBC）。

两个 Repository 实现用的还是上一篇那套**开关注解**：

```java
@Repository
@ConditionalOnProperty(name = "vectorstore.backend", havingValue = "memory", matchIfMissing = true)
public class InMemoryUsageRecordRepository implements UsageRecordRepository { ... }

@Repository
@ConditionalOnProperty(name = "vectorstore.backend", havingValue = "pgvector")
public class JdbcUsageRecordRepository implements UsageRecordRepository { ... }
```

> 这里我直接复用了 `vectorstore.backend` 这个开关——向量库和 usage 持久化反正是「同一个 PG 实例」，干脆同一个开关一起切，不用各管各的，配置也清爽。

零回归的全部秘密就这一句：**新增 Repository 抽象，老入口靠无参构造保持原样，新能力靠 Spring 注入。**

---

## 设计点二：聚合查询——两种后端，同一份语义

### 这才是这次真正新增的能力

光「存下来」不够，得能**按租户、时间段、模型汇总**，才算真能查账。我在 Repository 接口上加了：

```java
// 按 (model, interfaceName) 分组聚合 token 和成本，可选按租户和时间窗过滤
List<UsageSummaryRow> summarize(String tenantId, Instant from, Instant to);
```

返回的每一行 `UsageSummaryRow`，是一个 (模型, 接口) 维度的统计：调用次数、各类 token 合计、成本合计。

麻烦的地方在于：**内存和数据库两种实现，得算出完全一样的结果。**

### 数据库实现：交给 SQL 的 GROUP BY

数据库最擅长聚合，一条 SQL 就搞定：

```sql
SELECT model, interface_name,
       COUNT(*)                        AS calls,
       COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
       COALESCE(SUM(total_tokens), 0)  AS total_tokens,
       COALESCE(SUM(cached_tokens), 0) AS cached_tokens,
       COALESCE(SUM(estimated_cost), 0) AS estimated_cost
FROM usage_record
WHERE tenant_id = ? AND created_at >= ? AND created_at <= ?   -- 过滤条件按需拼接
GROUP BY model, interface_name
ORDER BY model, interface_name
```

- `GROUP BY model, interface_name`：按这两个维度分组。
- `SUM(...)`：每组内把 token、成本加起来。
- `COALESCE(SUM(x), 0)`：某组要是全是 NULL，SUM 会返回 NULL，用 `COALESCE` 兜成 0，免得返回空值。
- `WHERE` 里的 tenant / 时间条件是**按需拼接**的——传了 tenantId 才加 `tenant_id = ?`，全程参数化防注入。
- 这个查询会命中 `(tenant_id, created_at)` 索引（建表时专门加的），按租户+时间段查很快。

### 内存实现：用 Java 的 Map 手动分组

内存模式下没有 SQL，得用 Java 把同样的逻辑复刻一遍：遍历记录，拿一个 `Map` 以 `model+interface` 为 key 累加：

```java
for (UsageRecord r : records) {
    if (!matches(r, tenantId, from, to)) continue;     // 等价于 SQL 的 WHERE
    String key = r.getModel() + " " + r.getInterfaceName();   // 等价于 GROUP BY
    long[] agg = tokens.computeIfAbsent(key, k -> new long[5]);
    agg[0] += 1;                       // calls，等价于 COUNT(*)
    agg[3] += r.getTotalTokens();      // 等价于 SUM(total_tokens)
    // ...
}
```

### 为什么两套都写，还非得保证一致

这就是「内存默认 + 开关切换」这套模式的代价：每个能力都得在两个后端各实现一遍。为了确认它们**算出来的结果真的一样**，我给两边写了**断言完全相同**的测试：

- `InMemoryUsageRecordRepositoryTest`（恒跑，不需要数据库）
- `JdbcUsageRecordRepositoryIT`（env-gated，连真 PG 才跑）

两个测试喂一样的数据、断一样的结果（比如「INTENT 接口 2 次调用、9 个 token、成本 0.09」）。只要两边都绿，就说明换后端没换语义。这种「对称测试」是我这次最喜欢的一招：内存实现和 SQL 实现行为是不是等价，不靠脑补，靠两份一样的断言钉死。

---

## 设计点三：只读查询接口，数据来源对调用方透明

汇总能力得能被外面用上，于是加了个只读 REST 接口：

```java
@RestController
@RequestMapping("/api/usage")
public class UsageController {
    private final UsageRecordService usageRecordService;   // 不关心背后是内存还是 PG

    @GetMapping("/summary")
    public UsageSummaryResponse summary(
            @RequestParam(required = false) String tenantId,
            @RequestParam(required = false) String from,    // ISO-8601 时间，如 2026-06-18T00:00:00Z
            @RequestParam(required = false) String to) {
        List<UsageSummaryRow> rows = usageRecordService.summarize(tenantId, parse(from), parse(to));
        // 在明细之上再算一个全量合计，方便前端直接展示
        return new UsageSummaryResponse(tenantId, from, to, totalCalls, totalTokens, ..., rows);
    }
}
```

几个我做的取舍：

- **只读、无副作用**：用 `@GetMapping`，参数走 query string。查账这种操作不该改任何状态。
- **参数全可选**：不传 tenantId 就是全租户、不传时间就是全时段，随便组合。
- **时间格式校验前置**：`from`/`to` 解析失败就直接返回 400 + 友好提示，而不是抛个 500 让调用方去猜哪儿错了。
- **响应包含明细 + 合计**：`rows` 是按 (模型,接口) 的明细，外层再给一个总调用数 / 总 token / 总成本，前端不用自己再加一遍。
- **数据来源透明**：Controller 只调 `usageRecordService.summarize(...)`，pgvector 模式下读的是 PG 表（持久、跨重启），内存模式下读的是进程内记录——接口行为一致，调用方完全无感。

一个调用示例：

```
GET /api/usage/summary?tenantId=tenant-a&from=2026-06-01T00:00:00Z&to=2026-06-30T23:59:59Z
```

返回 tenant-a 六月份按模型/接口分组的 token 与成本明细，再带上全月合计。到这一步，「能查账」才算落到了实处。

---

## 2. 怎么验证的

**默认 memory 模式（不需要数据库）：**

```bash
mvn test    # 110 passed（107 原有 + 3 个新增内存聚合测试），0 failed —— 零回归
```

其中 `ApplicationContextSmokeTest` 能过很关键：它说明新增的两个 `@Repository` Bean 和 `UsageController`，在默认 memory 模式下能正常装配、而且**不需要数据库**就能启动。

**pgvector 真路径：**

```bash
docker compose -f docker-compose.pgvector.yml up -d     # usage_record 表随初始化 SQL 一起建好
PG_URL=jdbc:postgresql://localhost:5432/rag PG_USER=rag PG_PASSWORD=rag \
  mvn test -Dtest=JdbcUsageRecordRepositoryIT            # 验证写入 + 聚合查询
```

## 3. 写在最后

这次的小闭环：

1. **发现问题**：成本记录塞在内存 List 里，重启就丢、也没法按租户/时间汇总，所谓「能算清成本」其实名不副实。
2. **想清楚怎么改**：复用「内存默认 + 开关切换」模式（保留无参构造保零回归）；聚合能力两套实现用对称测试保证语义一致；加一个只读汇总接口，数据来源对调用方透明。
3. **验证**：memory 默认 110 测试零回归；pgvector 真路径有 env-gated 集成测试覆盖写入与聚合。

到这儿，向量检索和成本记录两块都从「demo 级内存态」变成了能持久化、能查的东西。回头看，这两篇连起来其实是同一件事：把一个跑得起来的 demo，一点点改成自己用着踏实的样子。

---
*配套代码：开关 `vectorstore.backend`、存储抽象 `UsageRecordRepository`、JDBC 实现 `JdbcUsageRecordRepository`、汇总接口 `GET /api/usage/summary`、建表 `db/init/01_schema.sql`。*
