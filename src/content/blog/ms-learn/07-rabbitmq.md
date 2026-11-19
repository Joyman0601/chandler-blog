---
title: "事件驱动与可靠消息：异步解耦后冒出的新问题"
description: "把同步调用换成 MQ 异步事件，下单秒回不再等积分。但 MQ 带来同步 RPC 没有的新问题：消息重复要幂等、消费失败要重试+死信队列、生产端要确保消息真的发出去。用 RabbitMQ 把这几件配套讲透。"
pubDate: 2026-02-05
tags: ["微服务", "RabbitMQ", "事件驱动", "消息队列"]
series: "ms-learn"
seriesLabel: "从单体到微服务"
---

> 系列第 7 篇。前面几篇的调用都是同步的——调用方必须等下游返回。这一篇换思路：把同步调用改成异步事件，用 RabbitMQ 解耦。但异步不是免费的，它带来一组同步 RPC 不会有的新问题。

## 同步调用的隐藏成本

前面下单的链路是同步的：ms-order 调 ms-stock 扣库存、（将来还要）调 ms-user 加积分，每一步都得**等对方返回**才能继续。

这意味着：

- 加积分如果很慢，下单接口也跟着慢。
- 加积分服务如果挂了，下单可能直接失败。
- ms-order 和「谁来处理积分」强耦合——加个新的下游（比如发短信通知），就得改 ms-order 的代码。

但仔细想想：**下单成功后加积分，真的需要下单接口等着它完成吗？** 用户下完单，积分晚几百毫秒到账完全没关系。这种「不需要立即完成、也不影响主流程」的操作，就适合改成**异步事件**。

思路转变：ms-order 下单成功后，只往消息队列**发一个「下单成功」事件**就立即返回，**不关心谁来消费**。积分服务（ms-user）自己去订阅、异步处理。这就是**事件驱动**。

这套 demo 选 **RabbitMQ**（AMQP 协议，Exchange/Queue/Binding 模型最直观）。

## AMQP 核心模型

先建立心智模型：

```text
生产者
  │ 发布到交换机，带 routing key
  ▼
Exchange（交换机）
  │ 按 Binding 路由
  ▼
Queue（队列）
  │ 推送消息
  ▼
消费者 ──ack──▶ broker
```

消息一路往下走，ack 是反方向的：消费者处理完，回头告诉 broker「这条可以删了」。

- **Exchange（交换机）**：生产者只往它发，**不知道队列存在**——这是解耦的根本。类型有 direct（键完全匹配）、fanout（广播）、topic（通配）。
- **Queue（队列）**：消息真正堆积的地方，**没有消费者也留着**——这是削峰/异步的根本。
- **Binding（绑定）**：规则「哪个交换机 + 哪个 routing key → 哪个队列」。
- **ack（确认）**：消费者处理完回确认，broker 才删消息；如果不确认（处理中崩了）→ 消息**重新投递**——这正是后面「消息重复」的根源。

## 收发两端共享契约

和第 3 篇一样，把收发双方共用的东西放进 ms-api。事件类：

```java
// 「下单成功」事件。生产者(ms-order)发, 消费者(ms-user)收。
// 放在公共契约模块, 让收发两端用同一个类结构, 避免字段对不上导致反序列化失败。
public class OrderCreatedEvent implements Serializable {
    private Long orderId;
    private Long userId;
    private Long productId;
    private Integer count;
    private Long timestamp;
    // ... 构造器 + getter/setter
}
```

以及名字常量（交换机/队列/路由键）：

```java
// MQ 的名字常量, 收发两端共用, 避免一边写错字符串导致绑定对不上、消息收不到。
public final class MqConst {
    public static final String ORDER_EXCHANGE = "order.exchange";          // 交换机
    public static final String ORDER_CREATED_QUEUE = "order.created.queue"; // 队列
    public static final String ORDER_CREATED_KEY = "order.created";         // 路由键
}
```

## 生产者：只发给交换机，从不提队列名

ms-order 加 `spring-boot-starter-amqp`，用代码声明 MQ 拓扑：

```java
// 用 Java 代码声明 MQ 拓扑(交换机/队列/绑定)。
// Spring AMQP 启动时会自动把这些 @Bean 去 RabbitMQ 上"创建(若不存在)", 而且是幂等的。
@Configuration
public class RabbitConfig {

    @Bean
    public TopicExchange orderExchange() {
        return new TopicExchange(MqConst.ORDER_EXCHANGE, true, false);
    }

    @Bean
    public Queue orderCreatedQueue() {
        return QueueBuilder.durable(MqConst.ORDER_CREATED_QUEUE)
                .withArgument("x-dead-letter-exchange", "order.dlx.exchange")
                .withArgument("x-dead-letter-routing-key", "order.dead")
                .build();
    }

    @Bean
    public Binding orderCreatedBinding() {
        return BindingBuilder.bind(orderCreatedQueue())
            .to(orderExchange())
            .with(MqConst.ORDER_CREATED_KEY);
    }

    // 消息体用 JSON 序列化: 可读、跨语言、消费端用同名 DTO 即可还原。
    @Bean
    public MessageConverter jsonMessageConverter() {
        return new Jackson2JsonMessageConverter();
    }
}
```

这些 `@Bean` 就是「管理台手点建交换机/队列/绑定」的代码版，Spring AMQP 启动时自动去 RabbitMQ 创建（幂等，已存在就不重复建）。

下单成功后发事件：

```java
// ③ 发「下单成功」事件: 只往交换机发, 不知道谁来收 —— 这就是异步解耦。
OrderCreatedEvent event = new OrderCreatedEvent(
    orderId, userId, productId, count, System.currentTimeMillis());
rabbitTemplate.convertAndSend(MqConst.ORDER_EXCHANGE, MqConst.ORDER_CREATED_KEY, event);
```

注意 `convertAndSend` 的参数是**（交换机, 路由键, 对象）**——**全程没有队列名**。生产者只把消息扔给交换机，交换机按路由键把它投进匹配的队列。代码层面就能看出解耦：发送方不知道、也不关心队列和消费者的存在。

**验证**：下单 `/order/buy` 秒回；此时去查管理 API，`order.created.queue` 里 `messages_ready=1, consumers=0`。**没有任何消费者，订单却已下完返回，消息堆在队列里**——异步解耦成立。

## 消费者：监听队列，push 而非 poll

ms-user 也加 `spring-boot-starter-amqp`，声明队列（消费端只声明队列，拓扑由生产者负责）+ 同款 JSON 转换器，然后用 `@RabbitListener` 监听：

```java
@RabbitListener(queues = MqConst.ORDER_CREATED_QUEUE)
public void onOrderCreated(OrderCreatedEvent event) {
    int points = event.getCount() * 10;
    log.info("【积分服务】收到下单事件: orderId={} → 给用户 {} 加 {} 积分",
        event.getOrderId(), event.getUserId(), points);
}
```

`@RabbitListener` 的机制是 **push，不是 poll**：ms-user 启动时 Spring AMQP 起一个**监听容器**常驻连着队列，队列一有消息就推过来调用方法。方法参数 `OrderCreatedEvent` 由 Jackson 转换器从 JSON 自动还原——所以**消费端必须配同款转换器**，否则参数拿到的是原始 byte[]。

**验证异步解耦**：再下单，order **0.59s 秒回**（HTTP 200，库存已扣），ms-user **稍后**（隔几百毫秒）才追加「加积分」日志——下单线程根本没等积分处理。

对比第 3 篇的同步 Feign/Dubbo（调用方必须等下游返回），MQ 让 order 发完事件立即返回，积分处理在另一个进程异步发生。**好处**：order 响应快、不受积分服务慢/挂的影响（削峰 + 解耦）。**代价**：不再强一致，是最终一致（积分稍后才到），而且引入了新问题。

## 新问题之一：消息重复 → 幂等

`@RabbitListener` 抛异常默认会 requeue（重新入队），加上 RabbitMQ 是 **at-least-once（至少投递一次）**——消费成功但 ack 丢失时，broker 会重投。结果：**同一条消息可能被处理多次** → 积分翻倍。

解法是**幂等**：用业务唯一键保证「同一个订单只加一次积分」。这里用 Redis SETNX：

```java
String idempotentKey = "mq:consumed:order:" + event.getOrderId();
Boolean first = redis.opsForValue().setIfAbsent(idempotentKey, "1", 24, TimeUnit.HOURS);
if (Boolean.FALSE.equals(first)) {
    log.warn("【积分服务】重复消息已跳过(幂等): orderId={}", event.getOrderId());
    return;   // 关键: 正常返回让 ack 删掉消息, 不能抛异常(抛了会 requeue 更糟)
}
// ... 正常处理加积分
```

`setIfAbsent`（SETNX）：第一次写入返回 `true` → 正常处理；key 已存在返回 `false` → 重复消息，**跳过但正常返回**（让 ack 删掉消息）。

> 这里有个反直觉的点：发现是重复消息时，**绝对不能抛异常**。抛异常会触发 requeue，消息又被塞回队列重投，越搞越糟。正确做法是「静默跳过 + 正常返回」，让这条重复消息被正常 ack 消化掉。

TTL 设 24h 是防止幂等 key 在 Redis 里无限堆积。

**验证**：对同一个 orderId 连发两次事件 → 日志第一次「加积分」，第二次「重复消息已跳过」，队列 `ready=0`（两条都被 ack）。

### 这段写法的漏洞：处理失败会丢消息

上面的写法是「先占位、再处理」。占位成功之后，如果加积分这一步抛了异常，key 已经写进 Redis 了。接下来不管是本地重试还是 broker 重投，再进来时 `setIfAbsent` 都返回 `false`，消息被当成重复跳过、正常 ack。这条消息就丢了，也进不了死信队列。验证里只测了「成功后再来一次」，测不出这个问题。

修法有两种，各有边界。下面两段都是补充示例，`addPoints` 代表加积分的业务处理。

**做法一：处理成功后再记 key。** 先查、再处理、成功了才写 key：

```java
String key = "mq:consumed:order:" + event.getOrderId();
if (Boolean.TRUE.equals(redis.hasKey(key))) {
    return;                                       // 处理过了，跳过并正常 ack
}
addPoints(event);                                 // 抛异常 → 没记 key → 重投时还会处理
redis.opsForValue().set(key, "1", 24, TimeUnit.HOURS);
```

边界：查和写不是原子的。两条重复消息同时被两个消费者拿到，会都通过检查、都加一次积分；加完积分、写 key 之前进程崩了，重投时也会再加一次。

**做法二：先占位，失败时删 key。** 保留原子的 `setIfAbsent`，在异常路径上把占位撤掉：

```java
String key = "mq:consumed:order:" + event.getOrderId();
Boolean first = redis.opsForValue().setIfAbsent(key, "1", 24, TimeUnit.HOURS);
if (Boolean.FALSE.equals(first)) {
    return;                                       // 重复消息，跳过并正常 ack
}
try {
    addPoints(event);
} catch (RuntimeException e) {
    redis.delete(key);                            // 撤掉占位，让重试 / 重投还能处理
    throw e;                                      // 继续抛，交给重试和死信
}
```

边界：并发重复能挡住，但进程在 `setIfAbsent` 之后、处理完之前被直接杀掉时，`catch` 来不及执行，key 留在 Redis 里，重投的消息会被当成重复跳过。可以把占位的 TTL 设短一些（比如处理超时时间的几倍），处理成功后再把它改成长 TTL，缩小这个窗口。

两种做法都只是缩小窗口。要彻底可靠，把「这个订单加过积分」记进和加积分同一个数据库事务里，比如积分流水表对 `order_id` 建唯一索引：重复插入直接失败，加积分和去重一起提交、一起回滚。Redis 这层留作挡掉大部分重复的快速检查。

## 新问题之二：消费失败 → 重试 + 死信队列

另一个问题：如果有一条消息**永远处理不了**（比如数据格式不符业务规则，俗称「毒消息」），`@RabbitListener` 抛异常默认 requeue → 它会**无限重投**，死循环打满 CPU，还堵住后面的正常消息。

解法分两步。

**第一步：重试上限**（yml 配置）：

```yaml
spring:
  rabbitmq:
    listener:
      simple:
        retry:
          enabled: true
          max-attempts: 3        # 最多试 3 次
          initial-interval: 1000ms
        default-requeue-rejected: false   # 只在关掉重试时起作用，见下文
```

注意这是**消费端本地重试**——在同一个进程内重调 listener N 次，**不经过 broker**。所以日志里会看到连续 3 次异常、间隔极短。

重试耗尽后消息去哪，由 `MessageRecoverer` 决定。按 Spring Boot 文档，开了重试时默认用 `RejectAndDontRequeueRecoverer`：reject 且**不**塞回队列，消息从而进入死信路由。所以开了重试以后，`default-requeue-rejected: false` 这一行不是关键，删掉也一样进死信。它管的是另一种情况：关掉重试时，listener 一抛异常，消息默认会被重新入队、无限重投；设成 `false` 才会直接 reject 不重回队列。

**第二步：死信队列（DLQ）**（代码声明）。在消费端声明一个死信交换机（DLX）+ 死信队列（DLQ），并给主队列挂上死信出口参数：

```java
// 业务队列（带死信出口参数）
// x-dead-letter-exchange: 消息变成死信时发往哪个交换机(DLX)。
@Bean
public Queue orderCreatedQueue() {
    return QueueBuilder.durable(MqConst.ORDER_CREATED_QUEUE)
            .withArgument("x-dead-letter-exchange", ORDER_DLX)
            .withArgument("x-dead-letter-routing-key", ORDER_DEAD_KEY)
            .build();
}
```

消息 reject 后，自动从主队列流向 DLX → 落进 DLQ，被**隔离**起来。它不丢（可以后续人工排查），也不堵（不再占着主队列）。

毒消息模拟（productId=6666 直接抛异常）：

```java
if (event.getProductId() != null && event.getProductId() == 6666L) {
    log.error("【积分服务】毒消息! 无法处理 productId=6666, orderId={}", event.getOrderId());
    throw new IllegalArgumentException("productId=6666 是毒消息, 无法处理");
}
```

**验证**：发一条 productId=6666 的消息 → ms-user 日志连打 3 次「毒消息！无法处理」后**停止** → 主队列 `ready=0`，`order.created.dlq` 里 `ready=1`。不再无限重投，毒消息被乖乖隔离到死信队列。

## 一个会让你启动报错的坑：队列参数不可改

队列的死信参数（`x-dead-letter-exchange` 等）是**队列创建时写进去的元数据，之后不能修改**。

如果你先建了一个没有死信参数的 `order.created.queue`，后来想加死信参数，直接改代码重启会报 `PRECONDITION_FAILED 406`（参数不一致）。必须**先手动删掉旧队列**，让程序重新创建。

而且**生产者和消费者声明同一个队列时，参数必须完全一致**——两端的 `x-dead-letter-exchange` 配得不一样，任意一端启动都会 406。这就是为什么前面生产者和消费者的 `orderCreatedQueue()` 死信参数要对齐。

## 生产端：消息真的发出去了吗

前面讲的都是消费端。标题叫「可靠消息」，还有另一半：生产者 `convertAndSend` 返回了，不等于 broker 收下了；broker 收下了，也不等于它和数据库里的订单对得上。这一节是补充内容，demo 里没有做，示例是我另写的最小版本。

### 1. publisher confirm：确认 broker 收下了

打开 confirm 后，broker 对每条消息回 ack 或 nack；再打开 returns，交换机路由不到任何队列的消息会退回给生产者，而不是被悄悄丢掉：

```yaml
spring:
  rabbitmq:
    publisher-confirm-type: correlated   # broker 收下后异步回 ack / nack
    publisher-returns: true              # 路由不到队列时退回
    template:
      mandatory: true                    # 配合 returns，不可路由的消息退回而不是丢弃
```

```java
@Bean
public RabbitTemplateCustomizer confirmCallbacks() {
    return template -> {
        template.setConfirmCallback((correlation, ack, cause) -> {
            if (!ack) {   // broker 没收下：记下来，交给补发逻辑
                log.error("消息未被 broker 接收: id={}, cause={}",
                        correlation == null ? null : correlation.getId(), cause);
            }
        });
        template.setReturnsCallback(returned ->
                log.error("消息路由不到队列: routingKey={}", returned.getRoutingKey()));
    };
}
```

发送时带上 `CorrelationData`，回调里才知道是哪一条：`rabbitTemplate.convertAndSend(exchange, key, event, new CorrelationData(String.valueOf(orderId)))`。confirm 只说明 broker 收到了；broker 重启后消息还在不在，还要靠持久化的队列和持久化的消息（Spring AMQP 默认发的就是持久化消息）。

### 2. 事务提交之后再发

下单是「写订单表 + 发事件」两件事。如果在本地事务里直接发消息，事务后面回滚了，消息却已经发出去；消费者还可能在事务提交前就收到消息，回头查订单却查不到。Spring 的做法是事务里只发一个应用内事件，等提交后再真正发 MQ：

```java
@Transactional
public long createOrder(Long userId, Long productId, int count) {
    long orderId = orderRepository.create(userId, productId, count);
    publisher.publishEvent(new OrderCreatedEvent(          // 只是应用内事件，还没发 MQ
            orderId, userId, productId, count, System.currentTimeMillis()));
    return orderId;
}

@TransactionalEventListener(phase = TransactionPhase.AFTER_COMMIT)
public void sendAfterCommit(OrderCreatedEvent event) {    // 本地事务提交成功后才执行
    rabbitTemplate.convertAndSend(MqConst.ORDER_EXCHANGE, MqConst.ORDER_CREATED_KEY, event);
}
```

边界有两条。第一，提交之后、发送之前进程崩了，或者发送失败，消息就丢了。第二，`@TransactionalEventListener` 只认 Spring 的本地事务，不认 Seata 的全局事务。[第 6 篇](/blog/ms-learn/06-seata-at/)的下单是在 `@GlobalTransactional` 里发 MQ 的：方法后面抛异常，库存和订单被 Seata 回滚，消息却已经发出，积分照加。这种情况要等全局事务提交后再发，Seata 提供了全局事务钩子（`TransactionHookManager` 注册 `afterCommit`），或者用下面的本地消息表。

### 3. 本地消息表：发送失败也能补

把「要发的消息」当成业务数据，和订单写在同一个本地事务里。订单在，消息记录就在；再由一个定时任务把没发的消息发出去：

```sql
CREATE TABLE outbox (
  id         BIGINT PRIMARY KEY AUTO_INCREMENT,
  routing    VARCHAR(64) NOT NULL,
  payload    JSON        NOT NULL,
  sent       TINYINT     NOT NULL DEFAULT 0,       -- 0 待发 1 已发
  created_at DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

```java
@Scheduled(fixedDelay = 1000)                          // 需要 @EnableScheduling
public void relayOutbox() {
    for (OutboxRow row : outboxRepository.findUnsent(100)) {
        rabbitTemplate.convertAndSend(MqConst.ORDER_EXCHANGE, row.routing(), row.toEvent());
        outboxRepository.markSent(row.id());           // 发完再标记
    }
}
```

发完、标记之前崩了，这条会被再发一次。所以本地消息表给的是「至少发一次」，重复要靠消费端的幂等兜住，两头是配套的。更稳一点的做法是在 confirm 回调收到 ack 后再标记已发。

## 配套着用，缺一不可

最后强调：MQ 的好处和新问题是**配套**的，不能只享受好处不处理问题：

- **好处**：异步解耦（order 秒回不等下游）、削峰（消费者按自己节奏消费）。
- **新问题**（同步 RPC 不会有的）：① 消息重复 → 幂等；② 消费失败 → 重试 + DLQ；③ 消息可能没发出去，或和数据库对不上 → confirm + 提交后再发 / 本地消息表。

消费端的幂等、重试、死信队列三者一起，加上生产端的确认和补发，才构成一套可靠的消息方案。少一个都不完整。

## 小结

| 维度 | 内容 |
|------|------|
| 为什么用 MQ | 异步解耦、削峰；下单不必等积分 |
| AMQP 模型 | 生产者→Exchange→(Binding)→Queue→消费者 |
| 解耦的体现 | 生产者只发给交换机，从不提队列名 |
| 新问题1：重复 | 幂等，重复时**静默跳过不抛异常**；处理失败要撤掉占位，最稳是数据库唯一键 |
| 新问题2：失败 | 重试上限（本地重试）+ 死信队列隔离毒消息 |
| 生产端 | publisher confirm；事务提交后再发；本地消息表补发 |
| 易错坑 | 队列参数创建后不可改，两端必须完全一致 |

服务能找到彼此、能通信、能扛故障、能保证事务、能异步解耦——一套完整的微服务雏形成型了。但最后还有一个绕不开的问题：**系统这么多服务、这么多异步链路，出了问题怎么定位？** 最后一篇讲可观测性。
