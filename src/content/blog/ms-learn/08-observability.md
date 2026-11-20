---
title: "可观测性：微服务出了问题怎么定位"
description: "服务多、链路长，出了问题怎么查？用 Actuator、Prometheus + Grafana、Zipkin 落地指标、日志、链路三支柱，重点讲 Feign 处 traceId 断裂、Zipkin 列表被 GET span 淹没等坑。"
pubDate: 2026-02-11
tags: ["微服务", "可观测性", "Prometheus", "Zipkin"]
series: "ms-learn"
seriesLabel: "从单体到微服务"
---

> 系列最后一篇。前面建起了一套能跑的微服务，但服务多、链路长、还有异步消息——**一旦出问题，怎么定位？** 这一篇落地可观测性的三支柱：指标、日志、链路追踪。

## 单体好查，微服务难查

单体应用出问题，登上那台机器，翻一份日志，基本就能定位。

微服务呢？一次下单请求横跨网关 → ms-order → ms-stock，还异步触发了 ms-user 的积分处理。请求慢了、报错了，问题可能在任何一个服务、任何一段网络。你得：

- 知道**每个服务**的健康状况和性能指标（哪个服务 CPU 高了、GC 频繁了）。
- 把**一次请求**在各个服务里的足迹串起来，看它到底卡在哪一段。

这就是**可观测性（Observability）**，三个支柱：

- **Metrics（指标）**：系统的量化状态——QPS、延迟、JVM 内存、GC……用 Prometheus + Grafana。
- **Logs（日志）**：离散的事件记录——前面一直在用。
- **Traces（链路追踪）**：一次请求跨服务的完整足迹——用 Zipkin。

环境上 docker-compose 新增三个容器：Prometheus（9090）、Grafana（3000）、Zipkin（9411）。

## 第一步：Actuator 暴露指标

Spring Boot Actuator 能**自动**暴露一大堆运行时指标，一行业务代码都不用写。ms-order 加 `spring-boot-starter-actuator` + `micrometer-registry-prometheus`，配置：

```yaml
management:
  endpoints:
    web:
      exposure:
        include: "*"          # 暴露所有端点
  endpoint:
    health:
      show-details: always
  metrics:
    tags:
      application: ${spring.application.name}   # 每条指标都打上服务名标签
```

启动后能访问：

- `/actuator/health`：看到 db / rabbit / sentinel / nacos 各组件 UP。
- `/actuator/metrics`：几十条指标。
- `/actuator/prometheus`：Prometheus 文本行格式，每行带 `application="ms-order"` 标签。

> 理解 `/actuator/prometheus` 这个端点：它是一扇**被动等抓取的窗户**，只给当前快照。历史和趋势不归它管——那是 Prometheus 的活。

## 第二步：Prometheus 抓取 + Grafana 看图

**分工要分清**：Prometheus 负责**定时抓取 + 存时序数据**；Grafana 负责**查 Prometheus 画图**（它自己不采集数据）。

Prometheus 的抓取配置：

```yaml
global:
  scrape_interval: 15s      # 每 15 秒抓一次

scrape_configs:
  - job_name: 'ms-order'
    metrics_path: '/actuator/prometheus'
    static_configs:
      # host.docker.internal: Docker Desktop 提供的特殊域名, 容器内用它访问宿主机
      # ms-order 跑在宿主机 9002, 所以从容器里用这个地址抓
      - targets: ['host.docker.internal:9002']
```

注意 `host.docker.internal` 这个特殊域名：Prometheus 跑在容器里，而 ms-order 跑在宿主机上，容器要访问宿主机就得用它。

**验证**：

- `http://127.0.0.1:9090/api/v1/targets` 看到 ms-order 的 health=up。
- Grafana 加数据源 `http://ms-prometheus:9090`（容器名互通），导入看板模板 ID **4701**（JVM Micrometer 看板），发 20 次下单，就能看到 HTTP 请求、JVM 内存、GC 等曲线随负载变化。

## 第三步：链路追踪 Zipkin

这是微服务可观测性最有特色的部分。

**核心概念**：

- 一次请求 = 一条 **Trace**（同一个 traceId）。
- 每个服务处理这一段 = 一个 **Span**。
- traceId 靠 HTTP header **跨服务透传**，各服务把自己的 Span 异步上报到 Zipkin，Zipkin 汇总成一张**瀑布图**。

依赖（4 个服务都加）：`micrometer-tracing-bridge-brave` + `zipkin-reporter-brave`。配置：

```yaml
management:
  tracing:
    sampling:
      probability: 1.0   # 采样率 1.0 = 100% 全采样(学习环境用, 生产通常 0.1)
  zipkin:
    tracing:
      endpoint: http://127.0.0.1:9411/api/v2/spans
```

**验证**：直打 ms-order:9002 下单，查到完整的 3-span 瀑布（实测一条 trace 的时间线）：

```
ms-order SERVER
http post /order/buy
起+0ms，耗时~108ms
最外层，整个下单全过程
│
└─ ms-order CLIENT
   http post
   起+10.8ms，耗时~48ms
   Feign 出门调库存
   │
   └─ ms-stock SERVER
      http post /stock/deduct
      起+24.7ms，耗时~35ms
      库存服务真正扣减
```

**瀑布图怎么读**：

- **缩进 = 调用嵌套**（谁调谁，越里越下游）：`下单 → 调库存 → 扣减`，三层缩进就是调用链。
- **色块长度 = 耗时**（谁长，慢在谁）。
- **色块错位的间隙 = 串行等待**。

出问题时，一眼就能看出是卡在网络、下游服务、还是自身业务哪一段。这是日志做不到的——日志是离散的点，trace 把这些点连成了线。

## 踩坑实录：这一段排查了非常久

链路追踪的概念简单，但真正打通跨服务追踪，踩了一连串坑。这部分是这篇最有价值的内容。

### 坑 A：被 Zipkin UI 列表误导，该用后端 API 查

一开始 Zipkin UI 列表里**只看到 ms-order**，我以为是上报失败，反复折腾了很久。

实际上 ms-order 的追踪**从头就是正常的**——日志 MDC 里 `[traceId-spanId]` 俱全，span 也上报成功了。问题出在 **UI 列表被噪音淹没**：Prometheus 每 15 秒来抓一次 `/actuator/prometheus`，每次都产生一条 GET span。这些 GET span 像潮水一样涌进列表，把我下单的那条 POST span **挤得翻不到**。

现象很迷惑：按 Run Query 后能看到 post 行，过一会刷新就被新涌入的 GET 挤没了——**不是消失，是被淹**。

> 教训：① 排查可观测性问题，用**后端 API** 精确查（`/api/v2/trace/{id}`、`/api/v2/traces?serviceName=ms-order&spanName=http post /order/buy`），别靠 UI 列表肉眼翻。② 非要用 UI，先加筛选条件（serviceName + spanName）滤掉 GET 噪音。

### 坑 B：链路在 Feign 调用处断开（核心坑）

打通 ms-order 自己的 span 后，发现下单 trace **只有 ms-order 一个 span，缺 ms-stock**——链路在 Feign 调用处断了。

**根因**：`micrometer-tracing-bridge-brave` 默认给 RestTemplate / WebClient 埋点，但 **OpenFeign 需要额外的 instrumentation 才会传播 traceId**。Feign 没埋点，traceId 就没塞进请求头，ms-stock 收不到，自然另起一条 trace。

**修复**：ms-order 加 `io.github.openfeign:feign-micrometer`。

### 坑 C：被调方缺 actuator，不上报 span

加了 feign-micrometer 后，traceId 能传到 ms-stock 了，但 ms-stock **还是不生成/上报 span**。

**根因**：ms-stock **没加 `spring-boot-starter-actuator`**。Micrometer Tracing 的自动装配以 actuator 为触发条件，没有它，即使收到 traceId 也不会建 span。

**修复**：ms-stock 补上 actuator。

### 坑 D：排除 brave-propagation-aws（其实不必要）

`micrometer-tracing-bridge-brave` 会**间接引入** `io.zipkin.aws:brave-propagation-aws`。我当时认为它把默认传播格式换成了 AWS X-Ray 格式，造成跨服务 traceId 不互认，于是把它排除了。

**当时的做法**：在 `micrometer-tracing-bridge-brave` 上 `<exclusion>` 掉 `io.zipkin.aws:brave-propagation-aws`。

更正：这里原先写的是「把默认的 B3 传播格式换成了 AWS X-Ray 格式」，有两处不对。第一，Spring Boot 3 默认的传播格式是 W3C（`traceparent` 请求头），不是 B3：按 Spring Boot 3.2 的配置项文档，`management.tracing.propagation.produce` 默认是 `W3C`，`consume` 默认是 `W3C, B3, B3_MULTI`。第二，这个包只是把 AWS 格式的实现放进 classpath，要在代码里显式把它配成传播方式才会用上；Spring Boot 的自动配置只按 `management.tracing.propagation` 的取值装 W3C 或 B3，可选类型里没有 AWS。所以它在不在 classpath，都不会改变默认格式。链路真正接上，靠的是坑 B、C 的两处修复；排除这个包无害，但不必要。

### 坑 E：WebFlux（网关）的追踪没攻克

最后一个坑没解决，作为已知遗留。Spring Cloud Gateway（WebFlux）的追踪埋点 + 传播，在这个版本组合下**没生效**（没有 Brave 初始化日志），而且 `zipkin-sender-okhttp3` 从镜像源拉到了 0 字节的坏包。

**决策**：跳过网关，只修 Feign 段（ms-order → ms-stock），**直打 9002 即可看到完整的跨服务瀑布**。这一步的核心目标（跨服务 trace 串联）已经达成，网关段留作已知坑。

> 这也是一条经验：学习时不必为每个坑死磕到底。核心目标（看懂跨服务瀑布）达成后，把边角的 WebFlux 追踪问题标记为「已知遗留」，继续前进，比卡在那里耗光精力更明智。

## 把四个坑串起来看

坑 B、C 是**同一个目标的两道关卡**，坑 D 是排查时顺带查的第三个方向——目标都是让 ms-stock 的 span 出现在同一条 trace 里：

1. **B**：traceId 得先能**传过去**（Feign 埋点）。
2. **C**：被调方得**愿意建 span**（actuator）。
3. **D**：两边的**传播格式得一致**。两端都是 Spring Boot 3 的默认配置时，发的是 W3C、收的认 W3C 和 B3，天然一致，所以坑 D 的排除其实不必要。

前两关缺一，跨服务追踪就断；第三关在两端版本、配置不一致时要查。理解了这条链，再遇到「trace 断在某个调用处」就知道往这三个方向查。

## 小结

| 支柱 | 工具 | 作用 |
|------|------|------|
| Metrics | Actuator + Prometheus + Grafana | 量化状态：QPS、延迟、JVM、GC |
| Logs | （一直在用） | 离散事件记录 |
| Traces | Zipkin | 一次请求跨服务的瀑布图 |

链路追踪的坑总结：
- **A**：排查用后端 API，别靠 UI 列表肉眼翻（被 GET span 淹没）。
- **B**：Feign 要加 `feign-micrometer` 才传播 traceId。
- **C**：被调方要有 actuator 才生成 span。
- **D**：两端传播格式要一致（Spring Boot 3 默认发 W3C）；`brave-propagation-aws` 不会改默认格式，不必排除。
- **E**：WebFlux（网关）追踪是已知遗留坑，直打后端服务即可。

## 系列收尾

到这里，八篇走完了。全系列的地图、贯穿始终的那条暗线、项目的不足和后续计划，都放在[系列总览](/blog/ms-learn/00-overview/)里。
