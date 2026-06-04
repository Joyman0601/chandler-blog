---
title: "服务间通信：Feign 与 Dubbo 两种姿势对比"
description: "跨进程调用有几种姿势？用同一个 order→user 调用，分别用 RestTemplate、Feign、Dubbo 实现并对比，讲清声明式 HTTP 和 RPC 的区别，以及别用玩具基准下性能结论的教训。"
pubDate: 2026-01-03
tags: ["微服务", "Feign", "Dubbo", "RPC"]
series: "ms-learn"
seriesLabel: "从单体到微服务"
---

> 系列第 3 篇。前面用 RestTemplate 拼 URL 调用，能跑但很原始。这一篇把服务间通信讲透：声明式 HTTP（Feign）和 RPC（Dubbo）两种主流姿势，用同一个调用并排对比。

## 拆开单体后，「方法调用」变成了什么

单体里 `userService.getById(1)` 是一次内存跳转，毫秒都算不上。拆开后，这次调用要跨进程、跨网络。前两篇我们用的是最原始的方式——RestTemplate 手写 URL：

```java
// 【方式1: RestTemplate】手写 URL, 手动指定返回类型
@GetMapping("/create")
public Map<String, Object> create(@RequestParam Long userId) {
    @SuppressWarnings("unchecked")
    Map<String, Object> user = restTemplate.getForObject(
        "http://ms-user/user/" + userId, Map.class);
    return Map.of("via", "RestTemplate", "orderId", System.currentTimeMillis(),
        "userId", userId, "userFromRemote", user);
}
```

能用，但有几个不爽的地方：要手拼 URL 字符串（容易写错）、要手动指定返回类型（`Map.class`，拿不到强类型）、调用代码和「远程」这件事强耦合。

有没有办法让远程调用**像调本地方法一样**？这就引出了 Feign 和 Dubbo。

## 公共契约模块：ms-api

在讲两种方式之前，先说一个设计：新增一个 `ms-api` **公共契约模块**，里面放调用双方共享的东西——DTO、Feign 接口、Dubbo 接口。

为什么要单独抽一个模块？因为调用方和被调方需要**对同一份接口定义达成一致**。把契约放在公共模块，两边都依赖它，就不会出现「一方改了字段、另一方不知道」的问题。

## 方式二：Feign —— 声明式 HTTP

Feign 的核心思想是：**你只声明「接口长什么样」，Feign 在运行期自动帮你生成实现。**

在 ms-api 里声明一个接口：

```java
// 声明式 HTTP 客户端: 只写"接口长什么样", Feign 在运行期自动生成实现。
// name = 目标服务名(ms-user), Feign 会结合 Nacos + 负载均衡解析真实地址。
// 方法上的 @GetMapping("/user/{id}") 必须与 ms-user 的真实接口一致。
@FeignClient(name = "ms-user")
public interface UserFeignClient {

    @GetMapping("/user/{id}")
    UserDTO getById(@PathVariable("id") Long id);
}
```

ms-order 加 `@EnableFeignClients`，注入这个接口，调用就像调本地方法——而且是**强类型**的（返回 `UserDTO` 而不是 `Map`）：

```java
// 【方式2: Feign】像调本地方法一样, 无需拼 URL、无需指定返回类型
@GetMapping("/create-feign")
public Map<String, Object> createFeign(@RequestParam Long userId) {
    UserDTO user = userFeignClient.getById(userId);
    return Map.of("via", "Feign", "orderId", System.currentTimeMillis(),
        "userId", userId, "userFromRemote", user);
}
```

底层 Feign 还是发 HTTP 请求，但它**复用了 Nacos 服务发现 + 负载均衡**：`@FeignClient(name = "ms-user")` 里写的也是服务名。对比 RestTemplate，Feign 把「拼 URL、选实例、反序列化」全藏起来了，调用代码干净很多。

## 方式三：Dubbo —— RPC

Dubbo 是另一条路：不走 HTTP，而是用自定义的 **TCP 长连接 + 二进制协议**做 RPC（远程过程调用）。

Dubbo 接口也放 ms-api，但它是**纯 Java 接口、不带任何注解**：

```java
// Dubbo RPC 接口: 纯 Java 接口, 不带任何注解。
// provider(ms-user) 实现它并用 @DubboService 暴露; consumer(ms-order) 用 @DubboReference 注入调用。
// 接口本身不依赖 dubbo 包, 所以 ms-api 无需引入 dubbo。
public interface UserDubboService {
    UserDTO getById(Long id);
}
```

**provider 端（ms-user）** 实现它，用 `@DubboService`（注意是 `org.apache.dubbo` 的注解，不是 Spring 的 `@Service`）暴露：

```java
// @DubboService: 把这个实现注册为可被远程调用的 Dubbo 服务, 并注册到 Nacos。
@DubboService
public class UserDubboServiceImpl implements UserDubboService {

    @Value("${server.port}")
    private String port;

    @Override
    public UserDTO getById(Long id) {
        // 这段逻辑运行在 ms-user 进程里; servedByPort 用来证明确实是远程执行
        return new UserDTO(id, "user-" + id, port);
    }
}
```

**consumer 端（ms-order）** 用 `@DubboReference` 注入——注入的是 Dubbo 生成的远程代理，调用时实际走 RPC：

```java
// @DubboReference: 注入的是 Dubbo 生成的远程代理, 调用时实际走 RPC 到 ms-user
@DubboReference
private UserDubboService userDubboService;

@GetMapping("/create-dubbo")
public Map<String, Object> createDubbo(@RequestParam Long userId) {
    UserDTO user = userDubboService.getById(userId);
    return Map.of("via", "Dubbo", "orderId", System.currentTimeMillis(),
        "userId", userId, "userFromRemote", user);
}
```

Dubbo 配置比 Feign 多。provider 端 yml：

```yaml
dubbo:
  application:
    name: ms-user-dubbo
  registry:
    # Dubbo 也用 Nacos 作注册中心, 与服务发现同一个 Nacos
    address: nacos://127.0.0.1:8848
  protocol:
    name: dubbo
    port: -1          # -1 表示自动分配可用端口
  scan:
    base-packages: com.example.user   # 扫描 @DubboService
```

注意 Dubbo 是**单独**用 dubbo 协议端口（默认 20880 这类）注册到 Nacos 的，和 HTTP 服务发现是两套注册信息。consumer 端还要配 `dubbo.consumer.check=false`，启动时不检查 provider 是否就绪，避免启动顺序依赖。

## 三种方式并存，对比看差异

这套 demo 让三种方式同时存在，都返回同一份 user 数据（`servedByPort` 证明确实是远程执行）：

- `/order/create` —— RestTemplate（手写 URL）
- `/order/create-feign` —— Feign（声明接口，像调本地方法）
- `/order/create-dubbo` —— Dubbo（RPC）

| 维度 | Feign | Dubbo |
|------|-------|-------|
| 协议 | HTTP/1.1 + JSON（文本） | 自定义 TCP 长连接 + 二进制（hessian2/fastjson2） |
| 编程模型 | 接口 + spring-mvc 注解（`@GetMapping` 等） | 纯 Java 接口 + `@DubboService`/`@DubboReference` |
| 注册 | 复用 Nacos discovery（服务名） | 单独注册 dubbo 协议地址到 Nacos |
| 配置量 | 少（一个注解） | 多（application/registry/protocol/scan） |
| 性能 | 一般（HTTP + JSON 开销） | 高并发/大流量/频繁调用下更优（长连接 + 二进制） |
| 跨语言/调试 | 好（就是 HTTP，可 curl/浏览器直调） | 二进制不能直接 curl；偏 Java 生态（Triple 协议可跨语言） |
| 生态 | Spring Cloud 标配 | Spring Cloud Alibaba / Dubbo 体系 |

简单说：**Feign 胜在简单、通用、好调试，是 Spring Cloud 的默认选择；Dubbo 胜在高并发场景的性能，但配置重、偏 Java 生态。**

## 重要教训：别用玩具级基准下性能结论

我做了个小测试：用 curl 各跑 30 次，量平均延迟。结果是 Feign ~7.4ms、Dubbo ~8.5ms——**Dubbo 居然还慢一点？**

这个结果**不能说明任何问题**，原因有二：

1. 测量里**混进了 curl 自身的进程启动 + 连接开销**，这部分占了大头，把真正的调用差异淹没了。
2. 单次玩具调用根本体现不出 Dubbo 的优势——Dubbo 的长连接 + 二进制序列化，是在**高并发、大流量、频繁调用**下才显出价值的。冷启动单发一次，HTTP 的开销占比太高。

> 教训：**别用玩具级微基准去给性能下结论。** 要测出 Dubbo vs Feign 的真实差距，得用专业压测工具，在高并发持续负载下测吞吐和 P99 延迟，而不是 curl 跑几十次取平均。这个 demo 里的数字仅供「感性认识调用确实发生了」，绝不能拿去做选型依据。

## 踩坑：单模块构建依赖本地仓库

用 `mvn -pl ms-order` 单独构建某个模块时，可能报 `Could not find artifact com.example:ms-learn:pom` 或找不到 `ms-api`。

原因：单模块构建会去**本地 Maven 仓库**找父 pom 和依赖模块。解决办法：

```bash
mvn -N install            # 先把父 pom 装进本地仓库
mvn -pl ms-api install    # 再把契约模块装进本地仓库
```

而且 **ms-api 每次改动后都要重新 `install`**，否则依赖它的服务拿到的还是旧契约。或者改用 `mvn -pl ms-order -am ...`（`-am` 会同时构建依赖的模块）。

另外，Dubbo 启动时会有 `Received empty url address list ... error code: 1-37` 的 WARN，这是 configurators 订阅的无害提示，不影响调用，不用管。

## 小结

| 方式 | 一句话 | 适用 |
|------|--------|------|
| RestTemplate | 手拼 URL，最原始 | 临时/简单场景 |
| Feign | 声明接口，运行期生成实现，像调本地方法 | **大多数场景的默认选择** |
| Dubbo | RPC，长连接 + 二进制 | 高并发、性能敏感、Java 生态 |

服务间能优雅通信了。但你应该注意到了：第 2 篇网关说「校验 token」，token 又是 ms-user 签发的。**两个进程怎么共享登录态？** 下一篇解决这个悬念——分布式会话。
