---
title: "让 usage 用量从内存落到 PostgreSQL：一次「让成本可审计」的持久化改造"
description: "把每次 LLM 调用的 token/成本从内存 List 落到 PostgreSQL 的 usage_record 表，并加一个按租户、时间窗聚合的只读接口，沿用内存默认+开关切换模式，110 个测试零回归。"
pubDate: 2026-06-20
tags: ["Java", "Spring Boot", "RAG", "PostgreSQL", "成本治理"]
series: "rag"
seriesLabel: "RAG 项目"
---

> 一句话总结：项目原本把每次 LLM 调用的 token / 成本记录塞在一个内存 List 里——重启即丢，也没法查。这次把它落到 PostgreSQL 的 `usage_record` 表，并加了一个按租户、时间窗聚合的查询接口 `GET /api/usage/summary`，让「成本治理可审计 / 能出账单」从一句口号变成能跑的接口。沿用上一篇 pgvector 改造的同一套「内存默认 + 开关切换」模式，**110 个测试零回归**。
>
> 建议先读 [《把内存向量库换成 pgvector》](/blog/rag-pgvector-migration/)，本篇的开关装配思路是它的延续。

## 0. 为什么要做这件事

项目里早有一套「成本治理」：每次调用大模型，都会记一条 `UsageRecord`——谁(user/tenant)、调的哪个接口、哪个模型、花了多少 token（含缓存命中的 cachedTokens）、估算成本、延迟、成功与否。听起来挺完整。但存储是这样的：

```java
// 改造前的 UsageRecordService：一个进程内的 List
private final List<UsageRecord> records = new CopyOnWriteArrayList<>();

public void record(UsageRecord r) { records.add(r); }
public List<UsageRecord> list()   { return List.copyOf(records); }
```

两个问题：

1. **重启即丢**——所有用量记录在内存里，进程一停全没了。没法做月度账单、没法追溯历史。
2. **没法查**——只有一个「把所有记录全列出来」的 `list()`，没有「按租户、按时间段、按模型汇总」的能力。想知道「A 租户这个月花了多少」？做不到。

简历写「成本治理」「token 用量返回」，但底层是个易失的内存 List。面试官问「用量数据存哪？怎么按租户出账单？」——答不上来。这是上一篇 P0 之后顺手要补的一块（范围 B）。

目标（最终选的范围）：**usage 落 PG 表 + 一个按租户/时间查汇总的只读接口**。同样要求零回归。

## 1. 改造的全貌

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

下面讲三个关键设计点。第一点是上一篇的延续，会快一些；后两点是这次新的。

---

## 设计点一：保留无参构造，零回归（pgvector 那套的复用）

### 问题

和上次一模一样：我要把存储换成「内存 / 数据库」两种可切换的后端，但**不能破坏现有代码**。这次的难点更具体——项目里有 **5 处**直接 `new UsageRecordService()`，包括生产代码和测试：

```java
// 测试里直接 new，还断言 list() 的内容
UsageRecordService usageRecordService = new UsageRecordService();
service.recordUsage(...);
assertThat(usageRecordService.list()).hasSize(2);   // 必须还能这么用
```

如果我把 `UsageRecordService` 改成「必须注入一个 Repository 才能 new」，这 5 处全得改。

### 解法：委托 + 无参构造兜底

我把 `UsageRecordService` 从「自己用 List 存」改成「**委托给一个 Repository**」，但**保留一个无参构造函数**，内部默认 new 一个内存 Repository：

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

> 复用了 `vectorstore.backend` 这个开关——向量库和 usage 持久化是「同一个 PG 实例、同一个开关」一起切换，不用各管各的，配置更简单。

这就是零回归的全部秘密：**新增 Repository 抽象，老入口靠无参构造保持原样，新能力靠 Spring 注入。**

---

## 设计点二：聚合查询——两种后端，同一份语义

### 这是范围 B 真正新增的能力

光「存下来」不够，要能**按租户、时间段、模型汇总**，才叫「能出账单」。我在 Repository 接口上加了：

```java
// 按 (model, interfaceName) 分组聚合 token 和成本，可选按租户和时间窗过滤
List<UsageSummaryRow> summarize(String tenantId, Instant from, Instant to);
```

返回的每一行 `UsageSummaryRow` 是一个 (模型, 接口) 维度的统计：调用次数、各类 token 合计、成本合计。

难点在于：**内存和数据库两种实现，要算出完全一样的结果**。

### 数据库实现：交给 SQL 的 GROUP BY

数据库最擅长聚合，一条 SQL 搞定：

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
- `COALESCE(SUM(x), 0)`：某组若全是 NULL，SUM 会返回 NULL，用 `COALESCE` 兜成 0，避免空值。
- `WHERE` 里的 tenant / 时间条件是**按需拼接**的——传了 tenantId 才加 `tenant_id = ?`，全程参数化防注入。
- 这个查询会命中 `(tenant_id, created_at)` 索引（建表时专门加的），按租户+时间段查很快。

### 内存实现：用 Java 的 Map 手动分组

内存模式下没有 SQL，得用 Java 复刻同样的逻辑：遍历记录，用一个 `Map` 以 `model+interface` 为 key 累加：

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

### 为什么要两套都写，还要保证一致

这正是「内存默认 + 开关切换」模式的代价：每个能力都要在两个后端各实现一遍。为确保它们**算出来的结果一致**，我给两边写了**断言完全相同**的测试：

- `InMemoryUsageRecordRepositoryTest`（恒跑，无需数据库）
- `JdbcUsageRecordRepositoryIT`（env-gated，连真 PG 才跑）

两个测试喂同样的数据、断同样的结果（比如「INTENT 接口 2 次调用、9 个 token、成本 0.09」）。只要两边都绿，就证明「换后端不换语义」。这是面试可以讲的点：**「我用对称的测试保证内存实现和 SQL 实现行为等价，换存储后端对调用方透明。」**

---

## 设计点三：只读查询接口，数据来源对调用方透明

汇总能力要能被外部用，于是加了个只读 REST 接口：

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

几个设计取舍：

- **只读、无副作用**：用 `@GetMapping`，参数走 query string。查账单这种操作不该改任何状态。
- **参数全可选**：不传 tenantId 就是全租户、不传时间就是全时段，灵活组合。
- **时间格式校验前置**：`from`/`to` 解析失败直接返回 400 + 友好提示，而不是抛个 500 让调用方猜。
- **响应包含明细 + 合计**：`rows` 是按 (模型,接口) 的明细，外层再给一个总调用数 / 总 token / 总成本，前端不用自己再加一遍。
- **数据来源透明**：Controller 只调 `usageRecordService.summarize(...)`，pgvector 模式下读的是 PG 表（持久、跨重启），内存模式下读的是进程内记录——**接口行为一致，调用方无感**。

一个调用示例：

```
GET /api/usage/summary?tenantId=tenant-a&from=2026-06-01T00:00:00Z&to=2026-06-30T23:59:59Z
```

返回 tenant-a 六月份按模型/接口分组的 token 与成本明细，外加全月合计。这就是「能出账单」的具象化。

---

## 2. 怎么验证

**默认 memory 模式（不需要数据库）：**

```bash
mvn test    # 110 passed（107 原有 + 3 个新增内存聚合测试），0 failed —— 零回归
```

其中 `ApplicationContextSmokeTest` 通过很关键：它证明新增的两个 `@Repository` Bean 和 `UsageController` 在默认 memory 模式下能正常装配、且**不需要数据库**就能启动。

**pgvector 真路径：**

```bash
docker compose -f docker-compose.pgvector.yml up -d     # usage_record 表随初始化 SQL 一起建好
PG_URL=jdbc:postgresql://localhost:5432/rag PG_USER=rag PG_PASSWORD=rag \
  mvn test -Dtest=JdbcUsageRecordRepositoryIT            # 验证写入 + 聚合查询
```

## 3. 小结

范围 B 的工程叙事：

1. **诊断**：成本记录在内存 List 里，重启即丢、无法按租户/时间汇总，「成本可审计」名不副实。
2. **设计**：复用「内存默认 + 开关切换」模式（保留无参构造保零回归）；聚合能力两套实现用对称测试保证语义一致；加只读汇总接口，数据来源对调用方透明。
3. **验证**：memory 默认 110 测试零回归；pgvector 真路径有 env-gated 集成测试覆盖写入与聚合。

到这里，向量检索和成本治理两块都从「demo 级内存态」升级成了「可持久化、可审计」——简历里的「企业知识库」「成本治理」开始名副其实。

---
*配套代码：开关 `vectorstore.backend`、存储抽象 `UsageRecordRepository`、JDBC 实现 `JdbcUsageRecordRepository`、汇总接口 `GET /api/usage/summary`、建表 `db/init/01_schema.sql`。*
