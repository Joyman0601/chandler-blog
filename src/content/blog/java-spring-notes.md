---
title: "Java 与 Spring 文章索引"
description: "本站 Java / Spring 方向文章的入口：从单体到微服务的电商 demo 系列、接手一个 RuoYi 微服务业务模块的踩坑实录，以及 JeecgBoot 源码阅读，每篇一句话说明讲什么。"
pubDate: 2026-02-23
tags: ["Java", "Spring", "后端", "索引"]
---

> 这一页是 Java / Spring 方向文章的目录。三个系列从不同角度切入：自己从零搭一套微服务、接手别人的微服务项目、读一个开源框架的源码。不知道从哪开始，可以先读各系列的第一篇总览。

## 1. 从单体到微服务（自己搭一套电商 demo）

用一套「用户 / 订单 / 库存」的极简电商 demo，从零把微服务的核心模式逐个跑一遍。

- [从单体到微服务：我用一套极简电商 demo 学了什么](/blog/ms-learn/00-overview/)：系列总览和收尾复盘，列出每一步要解决的问题和整体踩过的坑。
- [注册发现与配置中心：服务靠「名字」找到彼此](/blog/ms-learn/01-nacos-discovery-config/)：用 Nacos 做服务注册发现和动态配置，以及服务发现是最终一致这个坑。
- [API 网关与统一鉴权：把横切关注点提到入口](/blog/ms-learn/02-gateway-auth/)：用 Spring Cloud Gateway 统一做路由和鉴权，以及 WebFlux 不能引 servlet 依赖的坑。
- [服务间通信：Feign 与 Dubbo 两种姿势对比](/blog/ms-learn/03-feign-vs-dubbo/)：同一个跨服务调用分别用 RestTemplate、Feign、Dubbo 实现，对比声明式 HTTP 和 RPC。
- [分布式会话：登录态凭什么跨进程共享](/blog/ms-learn/04-distributed-session/)：用 Sa-Token + Redis 把登录态放到进程外，让签发和校验两端共享。
- [限流与熔断：下游病了，怎么不被拖死](/blog/ms-learn/05-sentinel/)：用 Sentinel 给入口限流、给下游熔断，以及熔断没触发其实是请求密度不够。
- [分布式事务：跨服务写操作怎么「要么全成要么全滚」](/blog/ms-learn/06-seata-at/)：用 Seata AT 模式做全局事务，讲 TC / TM / RM 三个角色和 undo_log 回滚。
- [事件驱动与可靠消息：异步解耦后冒出的新问题](/blog/ms-learn/07-rabbitmq/)：用 RabbitMQ 做异步事件，以及随之而来的幂等、重试和死信队列。
- [可观测性：微服务出了问题怎么定位](/blog/ms-learn/08-observability/)：指标、日志、链路追踪三件套落地，以及 traceId 在 Feign 调用中断开的排查。

## 2. 微服务新人踩坑实录（接手一个 RuoYi 业务模块）

在一套 RuoYi-Cloud-Plus 微服务后端里，从搭环境到独立交付一个业务模块的过程。

- [从零接手一个微服务业务模块：一个新人的踩坑实录](/blog/ruoyi-newbie/00-overview/)：系列总览。
- [01 架构全景与项目背景](/blog/ruoyi-newbie/01-architecture/)：模块怎么切分、一个请求怎么从网关流到业务模块。
- [02 环境搭建踩坑实录](/blog/ruoyi-newbie/02-environment-setup/)：数据库初始化、Nacos 命名空间、启动顺序、网关路由这些第一周的坑。
- [03 联合开发与远程环境](/blog/ruoyi-newbie/03-remote-collaboration/)：接远程共享环境，以及 Dubbo provider / consumer 的部署约束。
- [04 代码分层与实现模式](/blog/ruoyi-newbie/04-code-patterns/)：分层、分页避免 N+1、租户内唯一校验等反复用到的写法。
- [05 字典枚举与 Excel 导入导出的坑](/blog/ruoyi-newbie/05-dict-and-excel/)：两套字典机制和 Excel 导入导出里的类型陷阱。
- [06 雪花 ID 在前端精度丢失](/blog/ruoyi-newbie/06-snowflake-id-precision/)：19 位 ID 超过 JavaScript 的安全整数范围，前端拿到的值被改写。
- [07 同步主分支后的连锁故障：重新构建暴露的旧问题](/blog/ruoyi-newbie/07-dependency-avalanche/)：同步主分支后编译、启动、联调接连出错，逐层拆开。
- [08 协作规范与经验总结](/blog/ruoyi-newbie/08-collaboration-and-summary/)：接口文档口径、权限命名、协作边界，以及整个过程的复盘。

## 3. JeecgBoot 源码阅读

基于 JeecgBoot 3.9.2 源码的逐层阅读。

- [JeecgBoot 微服务实现深度解析](/blog/jeecgboot/microservice-analysis/)：微服务架构设计和认证链路的完整流程。
- [深入 JeecgBoot 3.9.2 源码：多租户 & 低代码平台原理解析](/blog/jeecgboot/multitenancy-lowcode/)：多租户行级隔离的实现链路，以及低代码平台怎么靠元数据解释执行。

## 收尾

三个系列的关系：电商 demo 是自己从零搭，最容易看清每个组件为什么存在；RuoYi 实录是在别人的项目里落地，坑多在环境和协作；JeecgBoot 是读源码，看一个成熟框架怎么取舍。大模型应用方向的文章在 [大模型应用岗学习路线](/blog/llm-learn/00-overview/) 里。
