---
title: "JeecgBoot 微服务实现深度解析"
description: "整理自对 JeecgBoot 3.9.2 源码的逐层阅读，涵盖微服务架构设计、认证链路全流程，以及关键设计取舍的分析。"
pubDate: 2026-03-17
tags: ["JeecgBoot", "微服务", "Spring Cloud", "认证"]
series: "jeecgboot"
seriesLabel: "JeecgBoot 项目"
---

> 本文整理自对 JeecgBoot 3.9.2 源码的逐层阅读，涵盖微服务架构设计、认证链路全流程、以及关键设计取舍的分析。

## 一、核心设计：同一套业务代码，两种运行模式

JeecgBoot 微服务最精妙的地方不是用了哪些框架，而是一个工程上的设计决策：**业务代码对“我在单体里跑还是微服务里跑”完全无感知**。

实现方式是**接口 + 两套实现**，核心接口是 `ISysBaseAPI`。

```text
jeecg-system-api/
├── jeecg-system-local-api/    ← 单体模式
│   └── ISysBaseAPI.java       （普通 Java 接口，无 HTTP 注解）
└── jeecg-system-cloud-api/    ← 微服务模式
    └── ISysBaseAPI.java       （@FeignClient，带 HTTP 注解）
```

两个模块的接口同名、同包：`org.jeecg.common.system.api.ISysBaseAPI`。

**local-api**（单体，同 JVM 内直接调用）：

```java
public interface ISysBaseAPI extends CommonAPI {
    void sendSysAnnouncement(MessageDTO message);
    LoginUser getUserById(String id);
}
```

**cloud-api**（微服务，方法变成 HTTP 调用）：

```java
@FeignClient(value = "jeecg-system", fallbackFactory = SysBaseAPIFallbackFactory.class)
@ConditionalOnMissingClass("org.jeecg.modules.system.service.impl.SysBaseApiImpl")
public interface ISysBaseAPI extends CommonAPI {
    @PostMapping("/sys/api/sendSysAnnouncement")
    void sendSysAnnouncement(@RequestBody MessageDTO message);
}
```

**切换机制的关键**是 `@ConditionalOnMissingClass`：

- 单体模式：`SysBaseApiImpl` 在 classpath，Feign 客户端**不实例化**，用本地实现
- 微服务模式：该实现类不在当前服务 classpath，Feign 客户端**自动生效**，走 HTTP

业务 Controller 注入 `ISysBaseAPI` 时，完全不感知切换。

## 二、微服务各组件全貌

```text
前端 (3100)
  │
  ▼
Gateway (9999)           ← Spring Cloud Gateway，Webflux 响应式
  │  ↕ 服务发现
  ▼
Nacos (8848)             ← 服务注册 + 配置中心
  │
  ├── jeecg-system        ← 系统服务（用户/角色/权限/字典）
  ├── jeecg-demo          ← Demo 独立微服务
  │
  └── jeecg-visual/
       ├── Monitor (9111) ← Spring Boot Admin
       ├── Sentinel (9000)← 流控熔断控制台
       └── XXL-Job (9080) ← 分布式任务调度
```

两种启动方式对比：

| | 单体模式 | 微服务模式 |
|---|---|---|
| 入口模块 | `jeecg-system-start` | `jeecg-system-cloud-start` |
| 依赖的 API 模块 | `jeecg-system-local-api` | `jeecg-boot-starter-cloud` |
| 激活方式 | 默认 | `mvn -P SpringCloud` |
| Gateway | 无 | `jeecg-cloud-gateway`（端口 9999） |
| 服务注册 | 无 | Nacos（端口 8848） |

## 三、Gateway 的两大核心职责

### 3.1 动态路由

路由配置不是写死在 YAML 里的，由 `DynamicRouteLoader` 运行时加载，支持热更新：

```text
dataType = nacos    → 从 Nacos Config 读路由 JSON，并注册监听器（配置变更自动推送）
dataType = database → 从 Redis 读路由（由 jeecg-system 服务写入）
dataType = yml      → 静态路由（写死在 application.yml）
```

路由示例（最终形态）：

```yaml
id: jeecg-system
uri: lb://jeecg-system     # lb:// = 负载均衡，服务名由 Nacos 解析
predicates:
  - Path=/jeecg-boot/sys/**
```

### 3.2 全局 Token 透传（GlobalAccessTokenFilter）

这是理解微服务认证的关键入口。Filter 做两件事：

**① 裁路径（StripPrefix）**

浏览器请求 `/jeecg-boot/sys/login`，Gateway 转发给 `jeecg-system` 时要裁掉第一段，变成 `/sys/login`。

**② 注入 `X_GATEWAY_BASE_PATH`**

把 Gateway 自身的域名+端口传给下游服务，用于生成正确的文件下载等绝对 URL。

`X-Access-Token` 本身不需要在 Filter 里处理——Gateway 配置了 `allowed-headers: "*"`，浏览器发来的所有 Header 都被自动转发给下游服务。

## 四、认证链路全流程

### 4.1 JWT 结构

JWT 是一个自描述字符串，三段用 `.` 连接：

```text
header . payload . signature

例：eyJhbGciOiJIUzI1NiJ9.eyJ1c2VybmFtZSI6ImFkbWluIn0.abc123xyz
```

本项目的 JWT payload 只存了 `username`，**签名密钥是用户的密码**（HMAC256）。

签名时（登录）：

```java
JWT.create()
   .withClaim("username", username)
   .withExpiresAt(expireDate)
   .sign(Algorithm.HMAC256(password));   // 密码作为签名密钥
```

验签时：

```java
Algorithm algorithm = Algorithm.HMAC256(password);       // 用密码重建算法
JWTVerifier verifier = JWT.require(algorithm)
                          .withClaim("username", username)
                          .build();
verifier.verify(cacheToken);   // 重算签名，和 token 的 signature 段比对
```

**验证的不是“和某个东西比对”，而是密码学自证明**：重新用密码计算一遍签名，看能不能和 token 的 signature 段对上。能对上，说明这个 token 确实是用这个密码签出来的。

用户改密码 → 签名密钥变了 → 所有旧 token 自动失效。

### 4.2 为什么还要 Redis

JWT 自带过期时间，按理不需要 Redis。但有一个需求它做不到：**活跃不掉线，闲置自动退出**。

纯 JWT 只能设固定过期时间，做不到“用户一直用就一直有效，一直不用就过期”这种效果。

解决方案是“双 token”机制：

```text
Redis Key:   "jeecg:token:{浏览器发来的原始 token}"
Redis Value: 服务器存的最新 token（会不断续期）
Redis TTL:   JWT 有效期 × 2（PC端 14天，APP端 60天）
```

### 4.3 完整验证流程

```text
请求到达，携带 Header: X-Access-Token = <原始token>
  ↓
JwtFilter.executeLogin()
  从 Header 取出原始 token，包装成 JwtToken
  交给 Shiro: subject.login(jwtToken)
  ↓
ShiroRealm.doGetAuthenticationInfo()
  ↓
  1. JWT.decode(原始token) → 取出 username（不需要密钥，payload 是明文 Base64）
  2. 从 Redis 取 LoginUser 缓存（优先缓存，避免每次查数据库）
  3. 校验用户状态（是否被锁定）
  4. 进入 jwtTokenRefresh()：
     ┌──────────────────────────────────────────────────────┐
     │ cacheToken = Redis.get("jeecg:token:" + 原始token)  │
     │                                                      │
     │ 找不到 → 非法 token 或已空闲超时 → 拒绝             │
     │ 找到了 ↓                                             │
     │                                                      │
     │ JwtUtil.verify(cacheToken, username, password)       │
     │   重算签名，校验 cacheToken 有没有过期               │
     │                                                      │
     │ 过期 → 用密码重签新 token → 写回 Redis → 续期成功   │
     │ 未过期 → 直接通过                                    │
     └──────────────────────────────────────────────────────┘
  5. 校验租户 ID 是否匹配（多租户场景）
  ↓
  返回 LoginUser，存入 Shiro Subject
  ↓
Controller 执行，通过 SecurityUtils.getSubject().getPrincipal() 取当前用户
```

注意：**verify 校验的是 Redis 里的 cacheToken，不是浏览器发来的原始 token**。原始 token 只是 Redis 的 key（一把永不变的“钥匙”），cacheToken 才是真正被校验和续期的令牌。

### 4.4 微服务间 Feign 调用如何带 Token

业务服务之间通过 Feign 互调时，没有浏览器，Token 从 FeignInterceptor 取：

```java
// 情况1：用户请求触发的 Feign（有 HTTP 上下文）
String token = request.getHeader("X-Access-Token");
requestTemplate.header("X-Access-Token", token);   // 转发给下游

// 情况2：定时任务/MQ 消费者触发的 Feign（无 HTTP 上下文）
String token = UserTokenContext.getToken();          // 从 ThreadLocal 取
requestTemplate.header("X-Access-Token", token);
```

下游服务收到 Feign 请求后，走同样的 JwtFilter + ShiroRealm 验证流程。

## 五、Feign 熔断兜底（Fallback）

cloud-api 的每个 Feign 接口都有对应的 `SysBaseAPIFallback`，下游不可用时：

- `void` 方法：打印错误日志，静默失败
- 有返回值方法：返回 `null` 或空集合

```java
@Override
public LoginUser getUserByName(String username) {
    log.error("jeecg-system 服务节点不通：" + cause.getMessage(), cause);
    return null;   // 熔断后的兜底值，调用方需自行判空
}
```

## 六、设计取舍分析

### 6.1 “把刷新推到服务端”的本质

传统 OAuth2 双 token 模式下，token 刷新是**客户端主动发起的额外 HTTP 请求**。本项目把它变成了**服务端每次请求附带的一次 Redis 写操作**。

| 方案 | 刷新触发者 | 用户感知 | 额外开销 |
|---|---|---|---|
| OAuth2 双 token | 客户端，access_token 过期后主动换 | 偶尔出现 401，需重试 | 额外 HTTP 往返 |
| 本项目 | 服务端，每次正常请求内附带 | 完全无感知 | 每次请求多一次 Redis 读写 |

### 6.2 Redis 成为关键基础设施

这套方案实质上让 JWT 变成了**有状态**的认证。Redis 不再是可选缓存，而是认证链路的必要环节：Redis 挂了，所有认证请求都会因找不到 cacheToken 而被拒绝。

代码中有一处注释揭示了这个取舍（`TokenUtils.java:170`）：

```java
// 【重要】此处通过 redis 原生获取缓存用户，是为了解决微服务下
// system 服务挂了，其他服务互调不通问题
if (redisUtil.hasKey(loginUserKey)) {
    loginUser = (LoginUser) redisUtil.get(loginUserKey);
```

用户信息也缓存在 Redis，目的是让 `jeecg-demo` 这类业务服务在 `jeecg-system` 挂掉时，仍能通过 Redis 独立完成 token 验证，避免级联故障。

**Redis 高可用是整套认证能正常工作的前提**，生产环境需配置主从/哨兵/集群。

### 6.3 这样做换来了什么

- **强制下线能力**：删 Redis key 立即踢人，纯无状态 JWT 做不到
- **密码改了立即生效**：签名密钥变了，旧 cacheToken 验签失败，自动续期时用新密码重签
- **前端零负担**：不需要处理任何 token 过期逻辑
- **代价**：每次请求多一次 Redis 读（通常 < 0.1ms），以及 Redis 成为单点依赖

## 七、完整链路图

```text
用户登录
  → 后端：sign(username, password) → JWT token
  → Redis.set("jeecg:token:" + token, token, TTL=14天)
  → 返回 token 给浏览器

浏览器后续每次请求（单体模式）：
  Header: X-Access-Token = <原始token>
    → JwtFilter → ShiroRealm
    → Redis.get(原始token) → cacheToken
    → verify(cacheToken, username, password)
    → 过期则续期 → 放行

浏览器后续每次请求（微服务模式）：
  Header: X-Access-Token = <原始token>
    → Gateway (9999)
        GlobalAccessTokenFilter：裁路径，Token 随 Header 自动透传
    → jeecg-system (内部端口)
        JwtFilter + ShiroRealm（验证逻辑与单体完全相同）
        → Controller 执行

jeecg-demo 通过 Feign 调用 jeecg-system：
  FeignInterceptor：从 HTTP 上下文或 ThreadLocal 取 Token → 注入 Header
    → jeecg-system 的 JwtFilter 照常验证
```

> **核心结论**：验证逻辑始终在各业务服务自己的 Shiro 里，Gateway 只负责路由和裁路径，Token 靠 HTTP Header 在整条链路上自然流动。Redis 是所有服务共享的 token 存储，是微服务下认证能工作的基础。
