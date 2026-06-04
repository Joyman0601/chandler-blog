---
title: "限流与熔断：下游病了，怎么不被拖死"
description: "注册发现解决不了「实例瞬间故障」。用 Sentinel 给服务加两道保护：限流控住入口流量、熔断隔离生病的下游。讲清 FlowRule/DegradeRule、fallback/blockHandler 的分工，以及熔断没触发其实是请求密度不够的坑。"
pubDate: 2026-01-24
tags: ["微服务", "Sentinel", "限流", "熔断"]
series: "ms-learn"
seriesLabel: "从单体到微服务"
---

> 系列第 5 篇，正式回收第 1 篇的伏笔。服务发现是最终一致的，应对不了「下游实例瞬间故障/变慢变挂」。这一篇用 Sentinel 给服务加两道保护：限流和熔断。

## 第 1 篇埋的伏笔

还记得第 1 篇的核心结论吗？**服务发现是「最终一致」的**——实例挂了，调用方的本地缓存还没刷新，仍会把请求发给死实例，于是连接失败。注册发现解决「找得到」，但解决不了「找到的恰好是个刚死、或正在变慢的」。

更现实的场景是：下游服务**没死，但生病了**——响应越来越慢，或者大面积报错。这时候如果调用方还傻乎乎地一直调它、一直等它，会发生什么？

- 调用方的线程都阻塞在等下游响应上，线程池被占满。
- 新请求进不来，调用方自己也开始变慢、甚至崩溃。
- 故障从下游**蔓延**到上游——这就是雪崩。

光靠注册发现兜不住这个瞬间。我们需要两样东西：**限流**（控住进来的量）和**熔断**（隔离生病的下游）。这套 demo 用 Sentinel 实现，给 ms-order 加这两道保护。规则直接写在代码里（不接 Dashboard），便于看清机制。

## Sentinel 的核心模型

记住一个公式：**资源（Resource）+ 规则（Rule）+ 兜底**。

- **资源**：一段被保护的代码（用 `@SentinelResource` 标注，给它起个名字）。
- **规则**：对这个资源的约束（限流规则 / 熔断规则）。
- **兜底**：触发约束时走的备用逻辑。

两类规则、两个兜底，分工一定要记牢，这是最容易混的地方：

| | 管什么 | 触发后 |
|---|--------|--------|
| **FlowRule 限流** | 进来的量（保护自己别被打爆） | 超额请求抛 `BlockException` → 走 `blockHandler` |
| **DegradeRule 熔断** | 出去的调用健不健康（别被病了的下游拖垮） | 跳闸后请求被拦（`DegradeException`，是 `BlockException` 子类）→ 走 `blockHandler` |

`@SentinelResource` 的两个兜底参数：

- **`fallback`**：处理**原方法抛出的业务异常**（下游真报错时走这里）。
- **`blockHandler`**：处理 **`BlockException`**（限流/熔断拦截时走这里）。

两个都配，才能在输出里清楚区分「下游报错」和「被 Sentinel 拦截」这两种不同情况。

## 规则怎么定义

ms-order 加 `spring-cloud-starter-alibaba-sentinel`，然后用 `@PostConstruct` 在启动时把规则加载到内存：

```java
@Configuration
public class SentinelConfig {

    // 资源名: 后面在 @SentinelResource(value=...) 里用同一个名字, 二者必须一致
    public static final String RES_FLOW = "order-flow-test";
    public static final String RES_DEGRADE = "order-call-unstable";

    @PostConstruct
    public void initRules() {
        // ---- 流控规则 (限流) ----
        FlowRule flow = new FlowRule();
        flow.setResource(RES_FLOW);                  // 对哪个资源限流
        flow.setGrade(RuleConstant.FLOW_GRADE_QPS);  // 按 QPS 限 (另一种是按并发线程数)
        flow.setCount(2);                            // 阈值: 每秒最多 2 次, 第 3 次起这一秒内被拒
        FlowRuleManager.loadRules(List.of(flow));

        // ---- 降级规则 (熔断) ----
        DegradeRule degrade = new DegradeRule();
        degrade.setResource(RES_DEGRADE);
        // 熔断策略: 按"异常比例"。另有 慢调用比例 / 异常数 两种
        degrade.setGrade(RuleConstant.DEGRADE_GRADE_EXCEPTION_RATIO);
        degrade.setCount(0.5);             // 阈值: 异常比例 > 50% 就跳闸
        degrade.setStatIntervalMs(1000);   // 统计窗口: 1 秒
        degrade.setMinRequestAmount(5);    // 窗口内至少 5 个请求才开始判定(样本太少不熔断)
        degrade.setTimeWindow(5);          // 跳闸后保持 OPEN 5 秒, 期间直接拒绝; 然后进入半开试探
        DegradeRuleManager.loadRules(List.of(degrade));
    }
}
```

> 真实项目里规则一般放在 Sentinel Dashboard 或 Nacos 里动态下发，这里写死在代码里是为了看清机制。

## 限流：保护自己别被打爆

限流资源 `order-flow-test`，QPS 阈值设 2：

```java
@GetMapping("/flow-test")
@SentinelResource(value = SentinelConfig.RES_FLOW, blockHandler = "flowTestBlocked")
public Map<String, Object> flowTest() {
    return Map.of("via", "flow-test", "result", "ok", "ts", System.currentTimeMillis());
}

// 被限流时走这里。真实场景可返回排队提示、降级数据等
public Map<String, Object> flowTestBlocked(BlockException ex) {
    return Map.of("via", "flow-test", "result", "blocked",
        "msg", "请求太快, 被限流了 (QPS>2)", "ts", System.currentTimeMillis());
}
```

注意 `blockHandler` 方法的**签名要求**：返回类型和参数要和原方法一致，末尾**多一个 `BlockException` 参数**，而且默认要和原方法**在同一个类里**。

**验证**：并发打 `/order/flow-test` 10 个请求，同一秒内只放行 2 个（`result:ok`），其余 8 个返回 `blocked`（走了 blockHandler，**业务根本没执行**）。下一秒配额刷新，再放行 2 个。

## 熔断：隔离生病的下游

先在 ms-user 造一个「生病的下游」——约 70% 概率抛异常：

```java
// 模拟一个"不稳定的下游": 约 70% 概率抛异常 → HTTP 500。
@GetMapping("/unstable")
public Map<String, Object> unstable() {
    if (ThreadLocalRandom.current().nextInt(100) < 70) {
        throw new RuntimeException("ms-user unstable: boom");
    }
    return Map.of("result", "ok", "servedByPort", port);
}
```

ms-order 调它，同时配 `fallback` 和 `blockHandler`，把熔断的不同阶段区分开：

```java
@GetMapping("/unstable")
@SentinelResource(value = SentinelConfig.RES_DEGRADE,
    fallback = "unstableFallback", blockHandler = "unstableBlocked")
public Map<String, Object> unstable() {
    @SuppressWarnings("unchecked")
    Map<String, Object> r = restTemplate.getForObject("http://ms-user/user/unstable", Map.class);
    return Map.of("via", "unstable", "result", "ok", "downstream", r);
}

// 下游真的报错时走这里(熔断器还没跳闸的阶段): 真调了下游, 但失败 → 返回兜底
public Map<String, Object> unstableFallback(Throwable t) {
    return Map.of("via", "unstable", "result", "degraded",
        "reason", "下游异常, 走fallback兜底", "err", t.getClass().getSimpleName());
}

// 熔断器已 OPEN 时走这里: 没调下游, 直接被拒
public Map<String, Object> unstableBlocked(BlockException ex) {
    return Map.of("via", "unstable", "result", "circuit-open",
        "reason", "熔断器跳闸, 直接拒绝, 未调用下游", "block", ex.getClass().getSimpleName());
}
```

### 熔断器的三个状态

并发猛打 `/order/unstable`，能观察到熔断器在三个状态之间转换：

1. **CLOSED（闭合，正常）**：真调下游，约 70% 失败 → 每次失败走 `fallback`，返回 `degraded`。这个阶段每个请求都真的打到了下游。
2. **OPEN（跳闸）**：1 秒窗口内异常比例稳超 50% → 熔断器跳闸。之后请求**瞬间**返回 `circuit-open`、**完全不碰下游**。这就是「隔离」——不再去打扰那个生病的服务。
3. **HALF-OPEN（半开试探）**：跳闸保持 5 秒（`timeWindow`）后，放**一个**探针请求去试下游。本例下游仍 70% 坏 → 探针多半失败 → 立即重新 OPEN，如此反复。如果下游恢复健康，某次探针成功，熔断器就自动回到 CLOSED。

**关键收获**：熔断让调用方**快速失败、自我保护**，并周期性探测、自动恢复——不需要人工干预。这正是注册发现给不了的能力。

## 最值得讲的坑：熔断没触发，其实是请求密度不够

这个坑我排查了很久，一度以为代码写错了。

现象：按熔断规则，异常比例超 50% 就该跳闸，可顺序 curl 打 `/order/unstable`，**熔断器死活不跳**，每次都走 fallback，看不到 `circuit-open`。

真相：**顺序 curl 速率太低**。每次 curl 都是新进程 + 新连接，开销大、间隔长。而熔断规则要求 1 秒统计窗口内至少有 `minRequestAmount=5` 个请求才开始判定。顺序 curl 在 1 秒内根本攒不满 5 个样本，或者比例上下抖动，就是不跳闸。

解法是**并发猛打**，制造足够高的请求密度：

```bash
for i in $(seq 20); do curl -s --noproxy '*' http://127.0.0.1:9002/order/unstable & done; wait
```

这样 1 秒窗口内样本足够密、异常比例稳定超过 50%，熔断器立刻稳定跳闸。

> 教训：**测异常比例熔断，必须保证统计窗口内样本足够密集。** 否则你会以为是配置错了或代码 bug，其实只是请求太稀疏，攒不满判定所需的样本量。这个坑很坑人，因为表面看「规则配了、就是不生效」。

## 限流 vs 熔断：两个正交的概念

最后理清这两个常被混淆的概念：

- **限流**：控**入口流量**——「我不想接这么多请求」。保护的是**自己**。
- **熔断**：做**故障隔离**——「下游病了，先别去找它」。保护的是**自己不被下游拖垮**。

两者**正交**，常一起用：限流挡住外部洪峰，熔断隔离内部故障。一个管「进来多少」，一个管「出去的调用健不健康」。

## 小结

| 概念 | 作用 | 触发后 |
|------|------|--------|
| FlowRule 限流 | 控入口流量，保护自己 | 超额 → blockHandler，业务不执行 |
| DegradeRule 熔断 | 隔离生病下游 | 跳闸 → 瞬间拒绝，不碰下游 |
| fallback | 下游真报错（CLOSED 阶段） | 真调了，失败兜底 |
| blockHandler | 被 Sentinel 拦截（OPEN 阶段） | 没调下游，直接拒 |
| 熔断三状态 | CLOSED → OPEN → HALF-OPEN | 自动跳闸、自动试探恢复 |

服务现在能扛住下游故障了。但还有一类问题没碰过：**跨服务的写操作**。下单要扣库存（ms-stock）+ 建订单（ms-order），这是两个库的两次写。如果扣完库存、建单失败，库存就白扣了。下一篇：分布式事务，怎么保证「要么全成、要么全滚」。
