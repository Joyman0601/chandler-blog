---
title: "微服务项目复盘：一套极简电商 demo，把微服务核心模式跑了一遍"
description: "复盘一套基于 Spring Boot 3.2 + Spring Cloud Alibaba 的极简电商微服务 demo，记录从注册发现、网关、通信、会话、限流熔断、分布式事务、消息到可观测性的完整实践与踩坑。"
pubDate: 2026-06-02
tags: ["微服务", "Spring Cloud", "Spring Cloud Alibaba", "Nacos", "Seata", "项目复盘"]
series: "ms-learn"
seriesLabel: "从单体到微服务"
---

## 项目背景

这个项目是我系统学习微服务时搭的一套学习 demo，目标不是把某个 starter 配通就算，而是**先把单体拆开，让那些原本不存在的问题自己暴露出来**，再逐个理解每个组件到底在解决哪个具体的痛。

项目源码地址：

```text
https://github.com/Joyman0601/ms-learn
```

它基于 Spring Boot 3.2.4 + Spring Cloud 2023.0.1 + Spring Cloud Alibaba 2023.0.1.0（JDK 17），用「用户 / 订单 / 库存」三个核心服务加一个网关，把微服务的核心模式从注册发现一路走到可观测性，每一步都有能跑起来的检查点和亲手验证过的实验现象。

我对这个项目的定位是：用一套**简单到一句话能说清的业务**，把注意力全部放在微服务模式本身，而不是业务复杂度上。

## 技术栈与业务主线

主线技术栈优先用 Spring Cloud Alibaba 体系，中间件全部用 Docker 起：

- Java 17 / Spring Boot 3.2.4
- Spring Cloud 2023.0.1 + Spring Cloud Alibaba 2023.0.1.0
- Nacos（注册发现 + 配置中心）
- Spring Cloud Gateway（网关）
- Feign / Dubbo（服务间通信）
- Sa-Token + Redis（分布式会话）
- Sentinel（限流熔断）
- Seata AT（分布式事务）
- RabbitMQ（事件驱动与可靠消息）
- Prometheus / Grafana / Zipkin（可观测性）

业务主线极简：一次「下单」会**扣库存、建订单、发积分事件**。模块上分成 ms-user（用户）、ms-order（订单）、ms-stock（库存）、ms-gateway（网关）和 ms-api（公共契约模块，放 DTO、Feign / Dubbo 接口、MQ 契约）。

> 入门第一个坑就是版本：**Spring Boot → Spring Cloud → Spring Cloud Alibaba 三者的版本必须按官方矩阵配套**，错配一个，启动直接崩。

## 第一阶段：注册发现与配置中心

整套 demo 有一条贯穿始终的设计：**服务靠名字存在，不靠 IP**。

每个服务在 `application.yml` 里用 `spring.application.name` 声明身份，加上 Nacos discovery 的 starter，启动就自动注册。调用方只写服务名（`http://ms-user/...` 或 `lb://ms-user`），由框架去 Nacos 解析成真实的 `ip:port`。这是微服务和单体最根本的差别之一：单体里方法调用是进程内的内存跳转，微服务里「调用」变成了跨进程、跨网络，于是「怎么找到对方」本身就成了一个需要专门组件解决的问题。

配置中心解决的是另一个痛：配置散落在每个服务里，改一次要重启一圈。把配置搬到 Nacos 后，配合 `@RefreshScope`，改完配置不重启、约 1~2 秒就能热生效。这里有个关键认知：动态刷新**不是客户端轮询，而是 Nacos 通过 gRPC 长连接主动推送**配置变更，客户端收到后销毁重建标了 `@RefreshScope` 的 Bean。

这一阶段我记下的最重要的一条经验是：**服务发现是「最终一致」的，不是实时的。** 实例挂掉后存在一个传播延迟窗口，调用方的本地缓存还没刷新，仍会把请求发给已死实例 → 连接失败。这正是后面必须有熔断兜底的原因——光靠注册发现，扛不住实例故障的那一瞬间。

## 第二阶段：网关与统一鉴权

网关把「鉴权 / 限流 / 跨域 / 日志」这些横切关注点从每个服务上提到统一入口，内部服务不直接对外暴露。

这里有个容易踩的坑：**Spring Cloud Gateway 基于 WebFlux 响应式**，绝不能再引 `spring-boot-starter-web`（Servlet），否则启动冲突；过滤器里全程返回 `Mono`，不能写阻塞代码——和前面写 Servlet 的思维完全不同。

路由用 `uri: lb://ms-user` 经 Nacos 负载均衡，`predicates: Path=/user/**` 决定哪些路径走这条路由。鉴权用全局过滤器实现，白名单放行、其余无 token 直接在网关短路返回 401，不进内网。

一个细节教训：**网关白名单路径必须和后端真实路由严格对齐**。我曾把白名单写成 `/user/greeting` 但接口实际在 `/greeting`，结果请求命中了 `/user/{id}` 把 "greeting" 当 Long 解析报 400。

## 第三阶段：服务间通信（Feign vs Dubbo）

用 Feign（声明式 HTTP）和 Dubbo（RPC）两种方式实现同一个 order→user 调用并对比，契约统一放在 ms-api 模块里。

| 维度 | Feign | Dubbo |
|------|-------|-------|
| 协议 | HTTP/1.1 + JSON（文本） | 自定义 TCP 长连接 + 二进制 |
| 编程模型 | 接口 + spring-mvc 注解 | 纯 Java 接口 + `@DubboService` / `@DubboReference` |
| 注册 | 复用 Nacos discovery（服务名） | 单独注册 dubbo 协议地址（:20880） |
| 配置量 | 少（一个注解） | 多（application / registry / protocol / scan） |
| 性能 | 一般 | 高并发、大流量、频繁调用下更优 |
| 调试 | 好（就是 HTTP，可 curl 直调） | 二进制不能直接 curl，偏 Java 生态 |

这里有个反面教训：我用 curl 各跑 30 次做了个「微基准」，Feign ~7.4ms、Dubbo ~8.5ms，单次玩具调用根本看不出 Dubbo 优势，HTTP 开销占了大头。**别用玩具级微基准下性能结论。**

## 第四阶段：分布式会话与认证

单体的 session 存进程内存即可；微服务必须把会话外置，否则请求落到不同实例 / 服务就认不出登录态。

方案是 Sa-Token + Redis：ms-user（Servlet）签发 token 写 Redis，网关（Reactive）用 `SaReactorFilter` 校验登录态。**关键在于两个服务的 `token-name` 必须一致、且指向同一个 Redis**——这才是分布式会话能共享的根本。登录由进程 A 完成、校验由进程 B 完成，两个独立进程都认这个 token，正因为共享 Redis。

## 第五阶段：限流与熔断（Sentinel）

给 ms-order 加两道保护，规则直接写在代码里便于看清机制：

- **FlowRule 限流**：管「进来的量」，超额请求抛 `BlockException` → 走 `blockHandler`。
- **DegradeRule 熔断**：管「出去的调用健不健康」，跳闸后请求被拦 → 走 `blockHandler`。

熔断的三阶段实验最能说明问题：CLOSED 时真调下游、异常时走 fallback；并发猛打使异常比例超阈值 → 跳闸 OPEN，之后请求瞬间失败、完全不碰下游；过了时间窗口进 HALF-OPEN 放一个探针试探，成功就自动恢复 CLOSED。

这一步正式补上了第一阶段埋的伏笔：注册发现解决不了「实例瞬间故障 / 下游变慢变挂」，**熔断让调用方快速失败、自我保护，并周期性探测自动恢复**。限流和熔断是正交的——一个控入口流量，一个做故障隔离，常一起用。

一个测试上的坑：顺序 curl 速率太低，1 秒统计窗口内攒不满最小请求数，熔断常常不跳闸，一度以为代码写错了。改用并发猛打制造高密度异常后，立刻稳定跳闸。**测异常比例熔断，要保证窗口内样本足够密。**

## 第六阶段：分布式事务（Seata AT）

跨服务写操作（建订单 + 扣库存，落在两个库）要么全成功、要么全回滚。用 Seata AT 模式实现，三个核心角色要先建立心智模型：

- **TC**（Transaction Coordinator）：独立的 Seata Server，全局事务的总协调者，决定最终 commit / rollback。
- **TM**（Transaction Manager）：标了 `@GlobalTransactional` 的方法所在服务（ms-order），负责发起全局事务。
- **RM**（Resource Manager）：被 Seata 数据源代理包住的服务（ms-order、ms-stock），管本地分支事务，并把反向 SQL 写进 `undo_log` 表以备回滚。

最能说明价值的是三组对照实验（都从库存 100、订单 0 起）：正常下单扣库存建单都成功；带 `@GlobalTransactional` 时人为抛异常，HTTP 返回 500，但库存被 undo_log 补回、订单不增（强一致）；不带全局事务的对照组同样 500，库存却白扣了、钱货两失（不一致）。

> 这点最关键：**事务框架不改变「失败」本身，只保证失败时数据回到一致**。实验 2 和 3 在 API 层看 HTTP 都是 500、看着一样，但数据结局天差地别，必须看库才看得出来。

这一阶段最大的坑全在环境上，不在业务代码：往官方镜像塞自定义配置时**整目录挂载会把镜像预置的其它文件全遮掉**（我曾因此把 Seata 的 logback 配置冲掉导致容器启动死循环，应改成单文件挂载）；以及 Seata 2.0.0 是 Jib 构建的镜像、没有 shell entrypoint，`SEATA_IP` 环境变量不生效，TC 注册的是不可达的容器内网 IP，客户端只能用 `registry.type=file` 直连发布端口 `127.0.0.1:8091` 绕开。

## 第七阶段：事件驱动与可靠消息（RabbitMQ）

把前面的同步调用换成异步事件：order 下单成功后只往 MQ 发一个「下单成功」事件就立即返回，不关心谁消费；ms-user 异步消费（模拟加积分）。

AMQP 的核心模型是「生产者 → Exchange → 按 routing key 路由 → Queue → 消费者 ack」。**生产者只往 Exchange 发，不知道队列存在**——这正是解耦的根本，代码层面发送时只指定交换机、从不提队列名。

异步换来了响应速度，**代价是不再强一致**（积分稍后才到账），还引入了同步 RPC 不会有的两个新问题，三者是配套的、少一个都不完整：

- **消息重复 → 幂等**：RabbitMQ 是 at-least-once，消费成功但 ack 丢失会重投。用 `orderId` 做业务唯一键，消费前 Redis SETNX，已存在就跳过但仍正常 ack，绝不能抛异常（抛了会 requeue 更糟）。
- **消费失败 → 重试 + 死信 DLQ**：listener 抛异常默认 requeue 会让毒消息无限重投。配重试上限（耗尽后不 requeue）+ 死信队列，让失败消息被隔离到 DLQ，不丢、不堵正常消息。

一个 RabbitMQ 的硬约束：队列参数（如 `x-dead-letter-exchange`）在队列创建后不可修改，必须先删旧队列再重建，且**生产者和消费者声明同一队列时参数必须完全一致**，否则任意一端启动都会 `PRECONDITION_FAILED 406`。

## 第八阶段：可观测性（Metrics / Logs / Traces）

解决「微服务出了问题怎么定位」，对应三支柱：

- **Metrics**：Spring Boot Actuator 暴露 `/actuator/prometheus`，Prometheus 定时抓取并存时序，Grafana 查询画图（导入 JVM Micrometer 看板模板 4701）。分工是 Prometheus 采集存储、Grafana 只负责画图。
- **Logs**：日志贯穿全程，链路追踪打通后日志的 MDC 里带上了 traceId-spanId。
- **Traces**：Zipkin 链路追踪。一次请求是一条 Trace（同一 traceId），每个服务处理这段是一个 Span，traceId 靠 HTTP header 跨服务透传，最后汇总成瀑布图。打通后能看到 `下单 → 调库存 → 扣减` 的三层 span 瀑布，缩进表示调用嵌套、色块长度表示耗时，一眼定位卡在哪段。

链路追踪这块踩坑很多，几个关键的：**OpenFeign 需要额外加 `feign-micrometer` 才会传播 traceId**（默认只给 RestTemplate / WebClient 埋点），否则链路在 Feign 调用处断开；**被调方必须也加 actuator** 才会生成并上报 span；以及 `micrometer-tracing-bridge-brave` 会间接引入 AWS X-Ray 传播格式顶替默认 B3，需要显式 exclude 掉，否则跨服务 traceId 不互认。

排查时还有个教训：别被 Zipkin UI 列表误导。我一度以为只上报了一个服务的 span 是上报失败，反复折腾，实际是每 15 秒一条的 Prometheus 抓取 GET span 把下单的 POST span 淹没了。**排查要用后端 API 精确查（按 serviceName + spanName 过滤），别靠肉眼翻 UI 列表。**

## 这个项目想强调的东西

如果说整个项目有一条暗线，那就是：**分布式系统里，很多在单体中理所当然的「确定性」都不再成立，你得学会和「不确定」共处。**

- 注册发现是最终一致的 → 所以需要熔断兜底。
- 配置推送有传播延迟 → 改完要一两秒才生效。
- 消息是至少投递一次 → 所以需要幂等。
- 异步解耦换来响应速度，代价是不再强一致 → 积分稍后才到账。

每加一个组件，几乎都是在为前一步埋下的某个隐患兜底。理解这条线，比记住任何一个 API 都重要。

## 当前不足与后续计划

这个项目仍然是学习和演示项目，业务故意做得极简，很多地方离生产还有距离：规则写死在代码里（Sentinel 未接 Dashboard、Seata 走 file 直连）、单机中间件无高可用、网关段的链路追踪因 WebFlux 传播未通而留作已知坑。

后续如果继续推进，方向大致是：把写死的规则接进配置中心 / Dashboard、补齐网关侧的 WebFlux 追踪传播、给中间件做高可用，以及把玩具级业务换成更接近真实的场景来压测各组件的边界。

## 总结

做完这一圈，我最大的体会是：微服务的难点几乎都不在「怎么把某个组件配通」，而在**理解每个组件是为了兜住拆开单体后冒出来的哪个具体问题**，以及**大量时间其实花在环境和中间件的坑上**（版本配套、Docker 镜像挂载、孤儿进程占端口、容器网络半坏……）。

把这套极简电商 demo 从注册发现一路跑到可观测性之后，那张「先让服务跑起来 → 再加治理 → 最后解决看不见的问题」的演进地图，才算真正从概念变成了我自己跑通过、踩过坑的东西。
