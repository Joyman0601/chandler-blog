---
title: "API 网关与统一鉴权：把横切关注点提到入口"
description: "服务拆开后，鉴权/路由/跨域这些横切逻辑难道每个服务都写一遍？用 Spring Cloud Gateway 立一个统一入口，并讲清 WebFlux 响应式编程不能引 servlet 的坑。"
pubDate: 2025-12-27
tags: ["微服务", "网关", "Spring Cloud Gateway", "WebFlux"]
series: "ms-learn"
seriesLabel: "从单体到微服务"
---

> 系列第 2 篇。服务能互相找到了，但外部请求还是直接打到每个服务上。鉴权、路由、跨域、日志这些**横切关注点**，总不能每个服务复制一遍。本篇用 Spring Cloud Gateway 立一个统一入口。

## 拆开单体后，鉴权要写几遍？

单体应用只有一个入口，鉴权、跨域、日志这些拦截器配一次就管全局。

拆成微服务后，ms-user、ms-order、ms-stock 各自是独立进程、各自有端口。如果让外部请求直接打到每个服务：

- **鉴权逻辑要在每个服务里写一遍**——而且还要保证写法一致，改一次改 N 处。
- 每个服务都直接暴露在外网，攻击面大。
- 跨域、限流、日志这些横切逻辑同样要重复 N 遍。

**API 网关**就是来收口的：所有外部请求先经过唯一入口，网关统一做路由 + 鉴权 + 跨域等横切处理，内部服务**不直接对外暴露**。

这套 demo 新增了 `ms-gateway` 模块，端口 8888（8080 被 svchost 占用），作为整个系统的统一入口。

## 路由：把请求按路径转发到对应服务

网关第一职责是路由——根据请求路径，把它转发到正确的后端服务：

```yaml
spring:
  cloud:
    gateway:
      routes:
        # 路由1: /user/** 转发到 ms-user 服务 (lb=经 Nacos 负载均衡)
        - id: ms-user
          uri: lb://ms-user
          predicates:
            - Path=/user/**
        # 路由2: /order/** 转发到 ms-order 服务
        - id: ms-order
          uri: lb://ms-order
          predicates:
            - Path=/order/**
      # 路径与后端接口一致(都是 /user/** /order/**), 故无需 StripPrefix
```

两个关键点：

- `uri: lb://ms-user` 里的 `lb://` 表示**经 Nacos 负载均衡**转发到该服务。又一次印证了上一篇的「服务靠名字寻址」——网关也不写 IP，只写服务名。
- `predicates: Path=/user/**` 是**断言**，决定哪些路径走这条路由。后端接口本来就是 `/user`、`/order` 前缀，所以不需要 `StripPrefix` 去剥路径。

## 统一鉴权：在入口处短路，不进内网

网关的第二职责是把鉴权这个横切关注点收到入口。Step3 先用一个「假鉴权」过滤器演示机制（真正的 token 校验留到第 4 篇 Sa-Token）：实现 `GlobalFilter + Ordered`，白名单放行，其余无 `Authorization` 头的请求直接 401。

这里有个关键认知——**鉴权失败要在网关短路返回，不让请求进内网**。`getOrder()` 数值越小越先执行，所以鉴权过滤器设一个很靠前的 order（比如 -100），让它在路由之前就拦下非法请求。

到了第 4 篇，这个假鉴权会被 Sa-Token 的真实校验替换掉，代码长这样（先剧透一下网关侧的形态）：

```java
@Bean
public SaReactorFilter getSaReactorFilter() {
    return new SaReactorFilter()
        // 拦截所有路径
        .addInclude("/**")
        // 放行白名单(登录、公开接口)
        .addExclude("/user/login")
        .addExclude("/user/greeting")
        // 鉴权逻辑: 除白名单外都要求已登录
        .setAuth(obj -> {
            SaRouter.match("/**")
                    .notMatch("/user/login", "/user/greeting")
                    .check(r -> StpUtil.checkLogin());
        })
        // 校验失败的返回
        .setError(e -> SaResult.error("blocked by gateway: " + e.getMessage()).setCode(401));
}
```

`addExclude` 配的就是白名单，`/user/login`（要先登录才能拿 token）和 `/user/greeting`（公开接口）放行，其余路径都要求 `StpUtil.checkLogin()` 通过。

## 核心坑：网关是 WebFlux 响应式，绝不能引 servlet

这是接入网关时最容易栽的一个坑，必须单独拎出来讲。

**Spring Cloud Gateway 基于 WebFlux 响应式模型**，依赖 `spring-cloud-starter-gateway`。它和前面那些基于 Servlet（`spring-boot-starter-web`）的服务**编程模型完全不同**：

- **绝对不能引 `spring-boot-starter-web`**。Servlet 容器和 WebFlux 的响应式容器会冲突，一起引入会导致**启动直接失败**。
- 过滤器里**全程返回 `Mono`**（响应式的异步类型），不能写阻塞代码。和前面 Servlet 里「拿到请求、同步处理、返回结果」的直觉不一样，要切换到「声明一条异步处理链」的思维。

如果你习惯了 Servlet 的写法，到网关这里第一反应往往是想引 web starter、想写同步逻辑——这都会出问题。记住：**网关是响应式的另一个世界**。

校验通过后，网关还能把用户信息透传给下游：用 `request.mutate().header(...)` 往请求头里塞解析出的用户身份，下游服务直接读 header 即可，无需再次解析 token。

## 亲手验证三个场景

网关跑起来后，所有请求都经 8888 入口：

1. **带 token 访问受保护接口**：`/user/1`、`/order/create` 正常路由到后端（order 还会级联调 user）。
2. **白名单无 token 放行**：`/user/greeting` 不带 token 也能访问。
3. **受保护接口无 token**：`/user/1` 不带 token → 网关直接返回自定义的 `401 {"code":401,"msg":"missing token, blocked by gateway"}`，请求根本没进到 ms-user。

第 3 个场景最能体现网关的价值：**非法请求在入口就被短路，内网服务完全不用操心鉴权。**

## 踩坑：白名单路径必须和后端真实路由严格对齐

这个坑上一篇提过，这里是它的「案发现场」。

最初 greeting 接口在 `/greeting`，但网关白名单写的是 `/user/greeting`。结果访问 `8888/user/greeting` 时，它命中了 `/user/{id}` 这条路由，网关把 `greeting` 这个字符串当成 `{id}`（Long 类型）传给后端 → 解析失败 → 400。

> 教训：**网关白名单/路由的路径，必须和后端真实接口路径严格对齐。** 一旦对不上，请求可能被错误地匹配到别的路由，产生莫名其妙的报错。后来把接口挪到 `/user/greeting` 才修正。

## 网关的代价：单点入口必须高可用

网关把横切关注点（鉴权/限流/跨域/日志）从每个服务上提到了统一入口，内部服务也不再直接对外暴露——这是巨大的收益。

但天下没有免费的午餐：**网关现在是整个系统的单点入口**。它一挂，所有外部流量全断。所以生产环境里网关必须高可用（多实例 + 前置负载均衡）。这是用「集中」换来的新责任。

## 小结

| 问题 | 方案 | 关键点 |
|------|------|--------|
| 鉴权/路由要写 N 遍 | API 网关统一入口 | 横切关注点收口，内部服务不对外暴露 |
| 怎么路由到对应服务 | `uri: lb://服务名` + `Path` 断言 | 仍靠服务名寻址，不写 IP |
| 非法请求怎么挡 | 鉴权过滤器靠前执行 + 短路返回 401 | 在入口拦下，不进内网 |
| 网关编程模型 | WebFlux 响应式 | **绝不能引 servlet web starter**，过滤器返回 Mono |
| 新增的风险 | —— | 网关是单点入口，必须高可用 |

入口立起来了，鉴权也收口了。但有个问题留着没解决：网关说「校验 token」，可 token 是 ms-user 签发的、由网关来验——**两个独立进程怎么共享同一个登录态？** 这正是第 4 篇分布式会话要解决的。不过在那之前，第 3 篇先把「服务间到底怎么通信」讲透：除了 RestTemplate，还有 Feign 和 Dubbo 两种姿势。
