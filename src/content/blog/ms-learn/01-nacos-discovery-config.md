---
title: "注册发现与配置中心：服务靠「名字」找到彼此"
description: "拆开单体后，A 怎么找到 B？配置散落各处怎么集中管理？用 Nacos 一次讲清服务注册发现、负载均衡、动态配置，以及「服务发现是最终一致」这个最容易踩的坑。"
pubDate: 2026-05-24
tags: ["微服务", "Nacos", "服务发现", "配置中心"]
series: "ms-learn"
seriesLabel: "从单体到微服务"
---

> 系列第 1 篇。拆开单体后冒出的第一个问题：两个独立进程，怎么找到对方？以及配置散落在每个服务里，改一次要重启一圈，怎么办？这两个问题都交给 Nacos。

## 拆开单体后，冒出的第一个问题

单体应用里，订单模块调用用户模块，就是一次普通的方法调用——同一个进程、同一块内存，JVM 直接跳过去就行。

拆成微服务后，ms-order 和 ms-user 是**两个独立的进程**，跑在不同端口（甚至不同机器）上。订单要查用户，就得发一次网络请求。问题来了：**ms-order 怎么知道 ms-user 在哪？**

最朴素的办法是把地址写死：`http://127.0.0.1:9011/user/1`。但这立刻就有麻烦：

- ms-user 换端口、换机器，所有调用方都要改。
- ms-user 起了两个实例做负载均衡，写死一个地址就用不上另一个。
- ms-user 挂了一个实例，调用方不知道，还往死实例发请求。

**服务注册与发现**就是来解决这个问题的：让服务启动时把自己的地址登记到一个中心（注册中心），调用方只报对方的「名字」，由注册中心告诉它当前有哪些可用实例。

## 服务靠「名字」存在

这套 demo 用 Nacos 作注册中心。接入只要两步：加 discovery 的 starter，然后在配置里声明自己的名字和 Nacos 地址。

```yaml
server:
  port: 9011          # 9001 被 Windows 的 svchost 占用, 改用 9011

spring:
  application:
    name: ms-user     # 服务名 = 别人调用我时用的逻辑名, 全项目靠它互相寻址, 不写 IP
  cloud:
    nacos:
      discovery:
        server-addr: 127.0.0.1:8848
```

`spring.application.name` 就是这个服务的**身份**。加上 `spring-cloud-starter-alibaba-nacos-discovery` 依赖，服务启动时**自动注册**到 Nacos，不需要写一行注册代码——这就是 starter 自动装配的威力。

启动后打开 Nacos 控制台（`http://localhost:8848/nacos`），服务列表里就会出现 `ms-user`、`ms-order`。它们现在是「在册」的了。

## 调用方只写名字：负载均衡如何发生

ms-order 调 ms-user，URL 里直接写**服务名**而不是 IP：

```java
@Configuration
public class RestConfig {

    // @LoadBalanced 是关键: 它给 RestTemplate 装上拦截器,
    // 使其能识别 http://{服务名}/... 形式的 URL, 通过 Nacos 解析成真实实例地址
    @Bean
    @LoadBalanced
    public RestTemplate restTemplate() {
        return new RestTemplate();
    }
}
```

调用时这样写：

```java
Map<String, Object> user = restTemplate.getForObject(
    "http://ms-user/user/" + userId, Map.class);
```

注意 URL 里的 `ms-user` 不是域名，是**服务名**。`@LoadBalanced` 给 RestTemplate 装的拦截器会拦下这个请求，把 `ms-user` 拿去问 Nacos 要实例列表，按轮询（round-robin）选一个，换成真实的 `ip:port` 再发出去。

> 注意：Nacos discovery **不自带**负载均衡，ms-order 需要额外加 `spring-cloud-starter-loadbalancer`，`@LoadBalanced` 才生效。

### 亲手验证负载均衡

让 ms-user 起两个实例（同名、不同端口）：

```bash
# 第二个实例
mvn -pl ms-user spring-boot:run -Dspring-boot.run.fork=false -Dspring-boot.run.arguments=--server.port=9012
```

ms-user 的接口返回里带了 `servedByPort`，标明是哪个实例响应的：

```java
@Value("${server.port}")
private String port;

@GetMapping("/{id}")
public Map<String, Object> getById(@PathVariable Long id) {
    return Map.of("id", id, "name", "user-" + id, "servedByPort", port);
}
```

连调 8 次 `/order/create?userId=1`，会看到 `servedByPort` 在 9011 和 9012 之间**完美轮询**。这就是注册发现 + 负载均衡在起作用。

## 最重要的坑：服务发现是「最终一致」的，不是实时的

这是整个系列里最值得记住的一个认知。

把 9012 实例停掉，立刻连续调用，你会看到一个奇怪的现象：**前几次调用交替成功/报错**——失败的那几次报 `Connection refused`（连 9012 被拒），过几次之后才稳定全走 9011。

为什么不是实例一停就立刻不发给它了？因为：

> **服务发现是「最终一致」的。** 实例挂掉后，存在一个「传播延迟窗口」：调用方本地缓存的实例列表还没刷新，仍会把请求发给已死的实例 → 连接失败。要等客户端缓存刷新 + Nacos 健康检查把死实例摘除后，才会自愈。

还有一种错误要和它分清楚：把**两个实例都停掉**，报的是 `IllegalStateException: No instances available for ms-user`。

- `Connection refused`：注册表里还有这个实例（缓存没刷新），但进程已经死了。
- `No instances available`：注册表已经空了，一个实例都没有。

**这个坑直接埋下了后面两篇的伏笔**：光靠注册发现，应对不了「实例瞬间故障」这个窗口期。所以后面必须有**重试 + 熔断降级**（见本系列第 5 篇 Sentinel）。注册发现解决「找得到」，但解决不了「找到的恰好是个刚死还没被摘除的」。

## 第二个问题：配置怎么集中管理

服务能互相找到了，下一个麻烦是**配置**。

单体只有一份 `application.yml`。拆成多个服务后，配置散落在每个服务里。如果有个参数要改（比如某个开关、某段文案），就得改 N 个文件、重启 N 个服务。能不能集中放一处、改了还不用重启？

这就是**配置中心**。Nacos 同时也是配置中心，接入同样简单：

```yaml
spring:
  cloud:
    nacos:
      config:
        server-addr: 127.0.0.1:8848
        file-extension: yml      # 配置内容格式
  # 启动时从 Nacos 拉取 dataId=ms-user.yml 的配置
  # optional: 表示拉不到也不阻断启动(否则 Nacos 没这个配置会启动失败)
  config:
    import:
      - optional:nacos:ms-user.yml
```

几个要点：

- `spring.config.import` 是 Spring Boot 2.4+ 引入的新方式，取代了老的 `bootstrap.yml`。
- `optional:` 前缀表示「拉不到也不阻断启动」——没这个前缀，Nacos 上还没建这个配置时服务会直接启动失败。
- dataId 默认就是 `${spring.application.name}.${file-extension}`，即 `ms-user.yml`。

## 不重启就生效：动态刷新

光集中存还不够，配置中心最香的能力是**改了不用重启**。读配置的 Bean 加上 `@RefreshScope`：

```java
// @RefreshScope: 当 Nacos 上的配置变化时, 这个 Bean 会被销毁重建,
// 重建时重新注入最新的 ${user.greeting}, 从而无需重启就能拿到新值
@RestController
@RefreshScope
public class GreetingController {

    // 冒号后是默认值: 万一 Nacos 上还没配 user.greeting, 就用这个兜底
    @Value("${user.greeting:default-greeting-from-code}")
    private String greeting;

    @GetMapping("/user/greeting")
    public Map<String, Object> greeting() {
        return Map.of("greeting", greeting);
    }
}
```

在 Nacos 控制台把 `user.greeting` 从 v1 改成 v2，**不重启** ms-user，约 1~2 秒后 `/user/greeting` 就自动返回 v2。

### 动态刷新的原理：是推送，不是轮询

很多人以为客户端是定时去问 Nacos「配置变了没」。其实不是：

> Nacos 和客户端之间维持一条 **gRPC 长连接**。配置一改 → Nacos **主动推送** `ConfigChangeNotifyRequest` → 客户端收到新内容 → Spring 的 `RefreshEventListener` 报 `Refresh keys changed: [user.greeting]` → 销毁并重建 `@RefreshScope` 标注的 Bean，注入新值。

是**服务端推送**，不是客户端轮询。这也是为什么生效那么快。

几个细节：

- 只有 `@RefreshScope`（或 `@ConfigurationProperties`）的 Bean 会热更；普通 `@Value` 注入的 Bean 不会。连接池核心参数等也未必能热更。
- 配置写入后立即回读，可能短暂提示「config data not exist」，这是写入的**传播延迟**，稍等一两秒即可——又一次印证了分布式系统里「最终一致」无处不在。

## 一个真实踩到的坑：网关白名单路径要和真实路由严格对齐

这个 greeting 接口最初放在 `/greeting`，后来挪到了 `/user/greeting`。原因和下一篇的网关有关：网关按 `/user/**` 路由，白名单也按路径放行。如果接口路径和网关配的白名单对不上，请求会被路由到错误的接口（比如 `/user/greeting` 命中了 `/user/{id}`，把 `greeting` 当成 Long 去解析，直接 400）。

教训：**网关白名单路径必须和后端真实路由严格对齐。** 这个坑下一篇还会细讲。

## 小结

| 问题 | 方案 | 关键点 |
|------|------|--------|
| A 怎么找到 B | 服务注册发现（Nacos discovery） | 服务靠 `spring.application.name` 存在，调用方只写服务名 |
| 怎么负载均衡 | `@LoadBalanced` + loadbalancer | 拦截器把服务名换成真实实例，轮询选一个 |
| 实例挂了为什么还发给它 | —— | 服务发现是**最终一致**，有传播延迟窗口 → 埋下熔断的伏笔 |
| 配置怎么集中、不重启生效 | 配置中心（Nacos config） | `@RefreshScope` + gRPC 长连接**推送**，非轮询 |

服务现在能互相找到、配置也集中管起来了。但所有请求还是直接打到各个服务上——鉴权、路由这些横切逻辑总不能每个服务都写一遍。下一篇，我们把统一入口立起来：**API 网关**。
