---
title: "分布式事务：跨服务写操作怎么「要么全成要么全滚」"
description: "下单扣库存跨两个库两次写，扣完库存建单失败就钱货两失。用 Seata AT 模式 + Feign 实现全局事务，讲清 TC/TM/RM 三角色、undo_log 反向补偿，以及把人折磨很久的镜像挂载和 SEATA_IP 坑。"
pubDate: 2026-05-29
tags: ["微服务", "Seata", "分布式事务", "AT模式"]
series: "ms-learn"
seriesLabel: "从单体到微服务"
---

> 系列第 6 篇。前面都是「读」或「单点写」，这一篇直面分布式系统最硬的骨头：**跨服务的写操作**。下单要扣库存 + 建订单，分属两个库。怎么保证它们要么全成功、要么全回滚？用 Seata AT 模式。

## 拆开单体后，事务没了

单体应用里，「下单扣库存 + 建订单」是同一个数据库的两次写，包在一个 `@Transactional` 里——要么一起提交，要么一起回滚，数据库帮你保证。

拆成微服务后：

- 扣库存是 **ms-stock** 干的，写 `ms_stock` 库。
- 建订单是 **ms-order** 干的，写 `ms_order` 库。

**两个不同的库、两个不同的进程**。本地事务管不了跨库——ms-stock 提交了扣库存，ms-order 这边建单失败，结果就是**库存白扣、订单没建**，钱货两失，数据不一致。

我们需要一个**全局事务**：协调多个服务的本地事务，让它们「同生共死」。这就是分布式事务，这套 demo 用 **Seata AT 模式**实现。

## 先建立心智模型：AT 模式的三个角色

Seata AT 模式有三个角色，理解了它们，整个机制就通了：

- **TC（Transaction Coordinator，事务协调者）**：独立的 Seata Server，全局事务的总指挥，最终决定 commit 还是 rollback。是一个单独的容器。
- **TM（Transaction Manager，事务管理者）**：全局事务的**发起方**——标了 `@GlobalTransactional` 的那个方法所在的服务（这里是 ms-order）。负责向 TC 注册全局事务、最后报告该提交还是回滚。
- **RM（Resource Manager，资源管理者）**：每个被 Seata 数据源代理包住的服务（ms-order、ms-stock）。负责管自己的本地分支事务，并把「反向 SQL」写进 `undo_log` 表以备回滚。

**AT 模式的核心机制**：每个写操作执行前后，RM 都把数据的**前镜像和后镜像**记进一张 `undo_log` 表。如果全局事务要回滚，就用 undo_log 里的前镜像生成「补偿 SQL」，把数据还原。所以每个业务库都要建一张 `undo_log` 表。

## 业务代码：一个注解搞定

先看最终效果。ms-order 的下单逻辑，加一个 `@GlobalTransactional` 注解就接入了全局事务：

```java
// @GlobalTransactional: ms-order 是 TM, 进方法即向 TC 开启全局事务拿到 XID;
// Feign 调用自动透传 XID, ms-stock 作为同一 XID 下的分支执行。方法正常返回则全局提交;
// 抛异常逃出本方法 → TM 通知 TC 全局回滚 → 各 RM 按 undo_log 反向补偿(库存补回、订单删除)。
@GlobalTransactional(rollbackFor = Exception.class)
@PostMapping("/buy")
public Map<String, Object> buy(@RequestParam Long userId,
                               @RequestParam Long productId,
                               @RequestParam Integer count,
                               @RequestParam(defaultValue = "false") boolean boom) {
    return doBuy(userId, productId, count, boom);
}
```

`doBuy` 里先 Feign 调 ms-stock 扣库存，再本地建订单：

```java
private Map<String, Object> doBuy(Long userId, Long productId, Integer count, boolean boom) {
    StockDTO stock = stockFeignClient.deduct(productId, count);   // ① 远程扣库存(已写 undo_log)
    if (boom) {
        // 扣完库存后崩。带全局事务 → 这个已扣的库存会被回滚补回; 不带 → 库存白扣。
        throw new RuntimeException("模拟扣库存后异常, 触发全局回滚");
    }
    long orderId = orderRepository.create(userId, productId, count); // ② 本地建订单
    // ...（建单后还会发 MQ 事件，那是下一篇的事）
}
```

注意 `boom=true` 是故意在「扣完库存、建单之前」抛异常，用来演示回滚。

## XID 怎么跨服务传播

这是 AT 模式最精妙的地方。ms-order 作为 TM，进入 `@GlobalTransactional` 方法时，就向 TC 开启全局事务、拿到一个全局事务 ID（**XID**）。

接下来 ms-order 用 Feign 调 ms-stock。`spring-cloud-starter-alibaba-seata` 会让 Feign 调用**自动把 XID 放进请求头**。ms-stock 收到后识别出这个 XID，就把自己的扣库存操作作为**同一个 XID 下的分支**来执行，并写自己的 undo_log。

正因为两个服务的操作挂在同一个 XID 下，回滚时 TC 才能驱动**所有**分支一起撤销。如果 XID 传不过去，ms-stock 就成了一个独立事务，回滚也回滚不到它。

## 被代理的数据源：写 SQL 自动记 undo_log

为什么业务代码只加一个注解，undo_log 就自动写了？因为 **Seata 自动代理了数据源**。

两个服务都加 `spring-cloud-starter-alibaba-seata`，`seata-spring-boot-starter` 默认 `enable-auto-data-source-proxy=true`，会自动把你的 `DataSource` 包成 `DataSourceProxy`，**无需手写任何 `@Bean`**。代理之后，业务 SQL 在全局事务中执行时，会自动在执行前后记录前/后镜像到 undo_log。

ms-stock 的扣库存 SQL（普通的 JdbcTemplate，没有任何 Seata 痕迹）：

```java
// 扣库存: 只在剩余 >= count 时才扣, 返回受影响行数(0 表示库存不足)。
// 这条 UPDATE 被 Seata 代理后, 会在执行前后把 t_stock 的前/后镜像写进 undo_log, 供全局回滚。
public int deduct(Long productId, int count) {
    return jdbc.update(
        "UPDATE t_stock SET count = count - ? WHERE product_id = ? AND count >= ?",
        count, productId, count);
}
```

> 顺带一提：这里故意用 JdbcTemplate 而不是 MyBatis，是想说明 **AT 模式靠代理 DataSource 实现，和 ORM 无关**——用什么持久层框架都行。

## 客户端配置：直连 TC，绕开注册中心

两个服务的 Seata 客户端配置（以 ms-order 为例）：

```yaml
seata:
  enabled: true
  application-id: ms-order
  # 事务组名: 同一全局事务的所有服务必须一致(ms-order/ms-stock 都用 default_tx_group)
  tx-service-group: default_tx_group
  service:
    vgroup-mapping:
      default_tx_group: default      # 事务组 -> 集群名
    grouplist:
      default: 127.0.0.1:8091        # 集群名 -> TC 地址（直连发布端口）
  registry:
    type: file
  config:
    type: file
```

几个关键点：

- **`tx-service-group` 两服务必须一致**（都是 `default_tx_group`），否则加入不了同一个全局事务。
- `registry.type: file` + `grouplist` 直连 `127.0.0.1:8091`——**不走 Nacos 查 TC 地址，直接连 TC 的发布端口**。这是为了绕开下面要讲的一个大坑。

## 三个实验：看清「失败时数据回到哪」

都从库存=100、订单=0 起跑，对照三组：

| 实验 | 端点 | HTTP | 库存 | 订单 |
|------|------|------|------|------|
| 1 正常提交 | `/buy` | 200 | 100→95 | +1 |
| 2 全局回滚 | `/buy?boom=true` | 500 | 仍 95（undo_log 补回） | 不增 |
| 3 无事务对照 | `/buy-notx?boom=true` | 500 | 95→90（白扣） | 不增 |

`/buy-notx` 是去掉了 `@GlobalTransactional` 的对照组。

**最值得品的是实验 2 vs 3**：两者 HTTP 都返回 500，从 API 层看**一模一样**。但数据结局天差地别——

- 实验 2 有全局事务：扣库存的操作被 undo_log **补回**了，库存没变（强一致）。
- 实验 3 没有全局事务：库存已经在 ms-stock 里独立提交了，异常只让订单没建成，**库存白扣**（不一致）。

> 核心收获：**事务框架不改变「失败」本身，只保证失败时数据回到一致状态。** HTTP 还是 500，业务还是失败了，但带事务的那个，数据是干净的。而这一点**在 API 层完全看不出来，必须去查数据库**才知道差别。

AT 模式的回滚链路：TM 抛异常 → 通知 TC 全局回滚 → TC 驱动各 RM 按 undo_log 反向补偿。整个过程业务代码只加了一个注解，跨服务的补偿对业务完全透明。

## 真正折磨人的坑：全在环境

Step 7 业务接入本身很轻（加 starter + 配事务组 + 一个注解），但环境坑排查了非常久。这里讲两个最典型的。

### 坑一：整目录挂载冲掉镜像自带文件

起 Seata Server 容器时，反复 `Restarting`，日志报 `Could not resolve placeholder 'logging.file.path'`。

排查方向一度跑偏：以为是挂载没生效、或 Seata 2.0 配置目录不对。但实测挂载是生效的、文件内容也对、编码也没问题（纯 LF、无 BOM）。

**真因**：docker-compose 里写的是 `volumes: ./seata-config:/seata-server/resources`，这是**整目录替换**——把镜像自带的 `logback-spring.xml` 等文件**一并冲掉了**。logback 配置没了，logging 初始化链路断掉，`logging.file.path` 进不了 Environment，启动就崩。

**决定性证据**：原镜像裸跑成功时，日志是自定义的 logback 格式 `[seata.server.ServerApplication]`；而崩溃的容器日志退化成了 Spring Boot 默认格式 `io.seata.server.ServerApplication`——说明 logback-spring.xml 确实没加载。

**修复**：改成**单文件挂载**，只替换 application.yml，保留镜像其它文件：

```yaml
volumes:
  # 只覆盖单个 application.yml, 不整目录替换(否则会冲掉镜像自带的 logback-spring.xml 等)
  - ./seata-config/application.yml:/seata-server/resources/application.yml
```

> 教训：**往官方镜像塞自定义配置，优先单文件挂载，别整目录挂载**——目录挂载会把镜像在该目录预置的其它文件全遮掉。排错时用「原镜像裸跑 vs 改后」对比日志格式/行为，能快速定位是不是自带文件被冲掉。

### 坑二：Seata 2.0.0 的 SEATA_IP 不生效

设了 `SEATA_IP=127.0.0.1`（env 确实进了容器），但 Seata 仍把自己注册成容器内网 IP `172.20.0.4:8091`。

**原因**：旧版 Seata 镜像靠 shell 启动脚本把 `SEATA_IP` 翻译进配置；但 2.0.0 是 **Jib 构建的镜像，没有 shell entrypoint**，这些 env 不再被处理。

**影响**：业务服务跑在**宿主机**上（用 mvn 启动），从 Nacos 拿到的是 `172.20.0.4:8091` 这个容器内网地址——宿主机**连不上**这个地址（但能连 `127.0.0.1:8091` 这个发布端口）。

**对策**就是前面客户端配置里那招：客户端用 `registry.type=file` + `grouplist=127.0.0.1:8091` **直连发布端口**，不查 Nacos。Server 端仍保留 `registry.type=nacos`，这样控制台能看到 TC（方便教学可视化），客户端走直连。这是本地「宿主机 + 容器」混布时的常见真实做法。

## 怎么确认 Seata 真的连上了

一个反直觉的点：**下单成功本身不能证明 Seata 连上了**。因为没有全局事务时，两次写库本来就各自独立成功。要确认 Seata 生效，必须看 **TC 日志里的注册记录**：

```
TM register success ... applicationId=ms-order
RM register success ... applicationId=ms-stock, resourceIds=jdbc:.../ms_stock
transactionServiceGroup=default_tx_group, client version:2.0.0
```

看到 TM/RM register success，才说明服务真的和 TC 建立了连接。

## 小结

| 问题 | 方案 | 关键点 |
|------|------|--------|
| 跨库写操作没有事务 | Seata AT 全局事务 | 一个 `@GlobalTransactional` 注解接入 |
| 三个角色 | TC / TM / RM | TC 协调、TM 发起、RM 管分支 + 写 undo_log |
| 怎么回滚 | undo_log 前镜像反向补偿 | 失败时数据还原，**API 层看不出，要查库** |
| 跨服务怎么串起来 | XID 经 Feign 头自动传播 | 各分支挂同一 XID，TC 才能统一驱动 |
| 最大的坑 | 镜像挂载 + SEATA_IP | 单文件挂载；客户端直连 8091 绕开 Nacos |

到这里，跨服务的强一致写操作也搞定了。但你有没有想过——下单非要**同步等**着扣库存、发积分吗？如果积分服务很慢，下单也得跟着慢。下一篇我们换个思路：把同步调用改成**异步事件**，用消息队列解耦，同时直面它带来的新问题（消息重复、消费失败）。
