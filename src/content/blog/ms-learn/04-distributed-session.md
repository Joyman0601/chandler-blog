---
title: "分布式会话：登录态凭什么跨进程共享"
description: "单体把 session 存进程内存就行，微服务为什么不行？用 Sa-Token + Redis 把登录态外置，让签发 token 的服务和校验 token 的网关共享同一份登录态。"
pubDate: 2026-01-09
tags: ["微服务", "Sa-Token", "Redis", "分布式会话"]
series: "ms-learn"
seriesLabel: "从单体到微服务"
---

> 系列第 4 篇，回收第 2 篇埋的悬念。网关说「校验 token」，token 又是 ms-user 签发的——两个独立进程怎么认同一个登录态？答案是把会话外置到 Redis。

## 拆开单体后，session 存哪？

单体应用的登录态很简单：用户登录后，session 存在**进程内存**里，后续请求带上 sessionId，服务器从内存查出这个用户是谁。因为只有一个进程，内存共享毫无障碍。

微服务一拆，这个前提就崩了：

- 用户登录是 **ms-user** 干的（进程 A），token 在它的内存里。
- 校验 token 是 **网关** 干的（进程 B）。
- 进程 B 的内存里**根本没有**进程 A 存的那份会话。

结果就是：ms-user 签发的 token，网关不认识。哪怕同一个服务起了两个实例，请求落到不同实例上也会「认不出登录态」。

**根本矛盾**：单体的 session 是进程内的，而微服务的请求会落到不同进程/实例上。

## 解法：把会话外置到一个公共存储

既然各进程的内存不共享，那就把登录态**搬出进程**，放到一个所有服务都能访问的地方——Redis。

这套 demo 用 **Sa-Token + Redis** 实现：

- **ms-user**（签发方）：用户登录时生成 token，并把 token → 用户身份的映射**写进 Redis**。
- **网关**（校验方）：校验 token 时，去**同一个 Redis** 查这个 token 是否有效。

只要两个进程读写的是**同一个 Redis**，登录态就共享了。这就是分布式会话的核心。

环境上 docker-compose 加一个 `redis:7.2` 容器（6379）即可。

## 签发方：ms-user 登录写 Redis

ms-user 是 servlet 应用，加 `sa-token-spring-boot3-starter` + `sa-token-redis-jackson` + `spring-boot-starter-data-redis`。登录接口：

```java
// 登录中心: 签发 token 并存入 Redis(由 Sa-Token + sa-token-redis 完成)
@RestController
@RequestMapping("/user")
public class AuthController {

    // 登录: 演示用 GET 方便 curl。StpUtil.login 会生成 token 并写入 Redis
    @GetMapping("/login")
    public Map<String, Object> login(@RequestParam Long userId) {
        StpUtil.login(userId);
        return Map.of(
            "msg", "login ok",
            "loginId", StpUtil.getLoginId(),
            "token", StpUtil.getTokenValue()   // 把 token 返回给客户端, 后续请求带上它
        );
    }

    // 查看当前登录身份(需带 token)
    @GetMapping("/whoami")
    public Map<String, Object> whoami() {
        return Map.of(
            "isLogin", StpUtil.isLogin(),
            "loginId", StpUtil.getLoginIdDefaultNull(),
            "servedBy", "ms-user"
        );
    }
}
```

`StpUtil.login(userId)` 这一行就完成了「生成 token + 写 Redis」。客户端拿到返回的 token，后续请求把它放进 header 带上。

ms-user 的 Sa-Token 配置：

```yaml
sa-token:
  token-name: Authorization   # token 放在名为 Authorization 的 header 里
  timeout: 1800               # token 有效期(秒)
  is-concurrent: true
  token-style: uuid
```

## 校验方：网关读同一个 Redis

网关是 WebFlux 响应式应用（回顾第 2 篇的坑），加的是 `sa-token-reactor-spring-boot3-starter` + 同样的 redis 依赖。用 `SaReactorFilter` 做全局校验：

```java
@Bean
public SaReactorFilter getSaReactorFilter() {
    return new SaReactorFilter()
        .addInclude("/**")                          // 拦截所有路径
        .addExclude("/user/login")                  // 放行白名单(登录)
        .addExclude("/user/greeting")               // 放行白名单(公开接口)
        .setAuth(obj -> {
            SaRouter.match("/**")
                    .notMatch("/user/login", "/user/greeting")
                    .check(r -> StpUtil.checkLogin());   // 除白名单外都要求已登录
        })
        .setError(e -> SaResult.error("blocked by gateway: " + e.getMessage()).setCode(401));
}
```

`StpUtil.checkLogin()` 在网关这边会去 Redis 查 token。这一步替换掉了第 2 篇的「假鉴权」过滤器。

网关的 Redis 和 Sa-Token 配置：

```yaml
spring:
  data:
    redis:
      host: 127.0.0.1
      port: 6379       # 必须和 ms-user 指向同一个 Redis

sa-token:
  token-name: Authorization   # token-name 必须和 ms-user 一致
  timeout: 1800
  is-concurrent: true
  token-style: uuid
```

## 三个配置必须一致，否则会话共享不成立

这是接入时最关键的认知。要让两个进程共享会话，三样东西必须各服务统一：

1. **同一个 Redis**——这是共享的物理基础，分布式会话能成立的根本。
2. **`token-name` 一致**（都叫 `Authorization`）——否则一方往这个 header 写、另一方从那个 header 读，对不上。
3. **序列化方式一致**——都用 `sa-token-redis-jackson`，否则一方写进 Redis 的数据另一方反序列化不出来。

少任何一个，token 就会「这边签的那边不认」。

## 亲手验证：分布式会话确实跨进程

1. **不登录访问** `/user/whoami` → 网关返回 401 拦截（没 token）。
2. **登录**（走白名单 `/user/login`）→ 拿到 token。
3. **带 token 访问** → 返回 `{"isLogin":true,"loginId":"88"}`。

关键证据在 Redis 里。登录后，去 Redis 里能看到：

```
Authorization:login:token:<token>    # token -> loginId 的映射
Authorization:login:session:88       # loginId 的会话数据
```

**这就是铁证**：登录由 ms-user（进程 A）完成、token 写入 Redis；校验由网关（进程 B）完成、读同一个 Redis。两个独立进程都认这个 token，正因为它们共享 Redis。如果是单体的进程内 session，进程 B 根本看不到进程 A 的数据。

## 一个容易被忽略的坑：Sa-Token 返回的 HTTP 状态码默认是 200

`SaReactorFilter.setError` 里返回的 `SaResult.error(...).setCode(401)`，这个 401 是**写在 JSON body 里的 `code` 字段**，**HTTP 状态码默认仍然是 200**。

也就是说，前端如果靠 HTTP 状态码判断「是否未登录」，会被骗——因为它收到的是 200。`SaResult.setCode` 只设置响应体里的 code，不改 HTTP status。要返回真正的 HTTP 401，需要额外定制响应状态。

这个坑很隐蔽，因为 body 里明明写着 401，很容易以为 HTTP 也是 401。

## 另一条路：JWT（无状态鉴权）

这里用的是「Redis 存 token」的**有状态**方案——token 本身只是个随机串，真正的用户信息存在 Redis，每次校验都要查 Redis。

另一条路是 **JWT**：token 自身就携带了用户信息（签名保证不被篡改），校验时只需验签，**无需查存储**。Sa-Token 也支持 JWT 模式。

两者的权衡：

- **Redis 存 token**：能随时让 token 失效（删 Redis 即可），但每次校验都查 Redis。
- **JWT**：无状态、不查存储、天然适合分布式，但 token 一旦签发，到期前难以主动作废（要额外维护黑名单）。

这个 demo 选 Redis 方案，是因为它更直观地体现「会话外置 + 跨进程共享」这个核心概念。

## 一个工作目录的小坑

学习过程中踩到一个和代码无关、但很烦的坑：**工作目录在命令之间会保持**。前面 `cd .../docker` 起 Redis 后，当前目录停在了 docker 子目录，再跑 `mvn -pl ms-user` 就报 `Could not find the selected project in the reactor`（Maven 在 docker 目录下找不到项目）。

教训：每条 mvn 命令前显式 `cd /e/yhl/ms-learn &&`，或确保当前目录在项目根。

## 小结

| 问题 | 方案 | 关键点 |
|------|------|--------|
| 单体 session 存内存，微服务不行 | 会话外置到 Redis | 各进程内存不共享，必须搬出进程 |
| 怎么共享 | Sa-Token + 同一个 Redis | 签发方写 Redis，校验方读同一个 Redis |
| 三个一致 | token-name / Redis / 序列化 | 少一个就「这边签那边不认」 |
| 隐蔽坑 | Sa-Token 返回 HTTP 200 | `setCode(401)` 只改 body，不改 HTTP status |
| 另一条路 | JWT 无状态鉴权 | token 自带信息，验签即可，无需查存储 |

到这里，服务能互相找到、能优雅通信、登录态也能跨进程共享了——「正常情况」下整套系统跑得很顺。但分布式系统的真正考验是**异常**：下一篇我们直面第 1 篇埋的那个伏笔——下游突然变慢、变挂，怎么不被它拖死？这就是 Sentinel 的限流与熔断。
