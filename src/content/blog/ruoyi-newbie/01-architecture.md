---
title: "01 架构全景与项目背景"
description: "微服务模块怎么切分、一个请求怎么从浏览器流过网关到业务模块，以及多租户、Dubbo 契约、ruoyi-system 地基这些新人必须先建立的坐标。"
pubDate: 2026-06-11
tags: ["RuoYi", "微服务", "网关", "Dubbo", "多租户"]
series: "ruoyi-newbie"
seriesLabel: "微服务新人踩坑实录"
---

> 系列第一篇。先把「我在哪、整个系统长什么样、一个请求怎么跑」讲清楚，后面所有的坑才有坐标。

## 我接到的任务

一句话：**在一套已经在跑的微服务后端里，新增一个业务模块，并独立交付到测试环境。**

听起来简单，但「已经在跑的微服务」这几个字背后，是一整套我当时并不熟悉的东西：服务注册发现、配置中心、网关路由、服务间 RPC、多租户、统一鉴权……新增一个模块，不是写个 Controller 那么简单，而是要让它**正确地长进这套体系里**。

## 技术栈全景

| 层 | 技术 | 作用 |
|---|---|---|
| 框架底座 | RuoYi-Cloud-Plus 2.6.1 | 把下面这些整合好的脚手架 |
| 运行时 | Spring Boot 3.x + Spring Cloud 2025.x | 微服务基础 |
| 语言 | JDK 17 | — |
| 注册/配置中心 | Nacos | 服务发现 + 配置热更新（按环境分命名空间） |
| 服务间调用 | Apache Dubbo 3 | 模块之间走 RPC，不走 HTTP |
| 网关 | Spring Cloud Gateway（响应式） | 所有外部请求的唯一入口 |
| 认证 | Sa-Token + JWT | 登录态、权限校验 |
| ORM | MyBatis-Plus | 自动分页、多数据源、多租户拦截 |
| 缓存 | Redis（Redisson 客户端） | — |
| Excel | FastExcel | 导入导出 |

如果你和我一样是新手，看到这张表的第一反应是「东西好多」。但其实**真正每天要打交道的就三四个**：Nacos（配置在哪）、Gateway（请求怎么进来）、Dubbo（怎么调别人）、MyBatis-Plus（怎么写库）。其余的框架都替你接好了。

## 模块是怎么切的

整个后端是一个 Maven 多模块工程，大致分三类：

```
ruoyi-api/          # Dubbo 接口契约（各模块对外暴露的 RPC 接口定义，只有接口没有实现）
ruoyi-auth/         # 认证服务（登录、发 Token）
ruoyi-common/       # 公共组件（core/security/mybatis/redis/excel/tenant... 一堆子模块）
ruoyi-gateway/      # 网关（唯一入口）
ruoyi-modules/
  ruoyi-system/     # 系统管理（用户/角色/部门/菜单/租户）—— 几乎所有模块都依赖它
  biz-module/       # 【我负责的业务模块】
  ...               # 代码生成、任务调度、文件存储、工作流等
```

几个对新人很关键的认知：

1. **`ruoyi-api` 里只有接口，没有实现。** 它是「契约层」。比如「根据用户 ID 查昵称」这个能力，接口定义在 `ruoyi-api`，**实现在 `ruoyi-system`**。我的业务模块想用，就 `@DubboReference` 引这个接口。这个设计后面第 03 篇会狠狠坑我一次。

2. **`ruoyi-common` 是一堆子模块**，不是一个。`common-core`、`common-mybatis`、`common-tenant`、`common-excel`…… 我的模块按需依赖。这点在第 07 篇「编译报包不存在」时很关键。

3. **`ruoyi-system` 是地基。** 用户、部门、菜单、租户都在它那。几乎任何业务模块都要通过 Dubbo 找它要数据。

## 一个请求是怎么流动的

这是我花了最久才在脑子里建立起来的图。以「前端查一个列表」为例：

```
浏览器
  │  GET /biz/asset/v0.1/list   （前端只知道一个地址：网关）
  ▼
[ 网关 Gateway :端口X ]
  │  1. 校验 Token（Sa-Token）
  │  2. 按路径前缀 /biz/** 匹配路由
  │  3. StripPrefix 去掉前缀，转发给服务名 lb://biz-module
  │     （服务名→实例地址，靠 Nacos 服务发现）
  ▼
[ 业务模块 biz-module :端口Y ]
  │  Controller → Service → Mapper → MySQL
  │  如果要「用户昵称」这种跨模块数据：
  │     @DubboReference 调 ruoyi-system 的 RPC 接口
  ▼
[ ruoyi-system ]  ← Dubbo RPC
```

**关键点：前端永远只跟网关说话，端口只认网关那一个。** 后面的业务模块端口随便改，前端都感知不到——因为网关靠「服务名」而不是「写死端口」去找它们。这个事实在第 07 篇会成为破案的关键。

## 多租户：你写的每条 SQL 都被偷偷加了条件

平台是多租户的。框架的处理方式很「魔法」：

- 业务实体都继承 `TenantEntity`，自带 `tenant_id` 字段；
- MyBatis 有个**租户拦截器**，在你毫不知情的情况下，给 `SELECT/UPDATE/DELETE` 自动拼上 `AND tenant_id = ?`，给 `INSERT` 自动塞 `tenant_id`。

所以我写「校验名称在租户内唯一」时，**根本不需要手写 `tenant_id` 条件**：

```java
// 框架会自动补 tenant_id 过滤，这里只管业务字段
boolean exists = mapper.exists(Wrappers.<BizArea>lambdaQuery()
    .eq(BizArea::getAreaName, areaName));
```

新手很容易自己再加一遍 `tenant_id`，要么多余、要么和拦截器打架。**记住：业务代码里看不到租户条件，是正常的。**

## 一个真实的「两个包共存」的故事

我的模块里有个细节挺能说明「联合开发」的味道：模块里**并存两个顶层包**——一个是带教先写的，一个是我写的。主类上于是要显式声明扫描两个包：

```java
@SpringBootApplication(scanBasePackages = {"org.dromara.inspection", "org.dromara.system"})
```

> 默认情况下 Spring Boot 只扫描主类所在包及其子包。两个人各起一个顶层包，就必须手动把两个都加进 `scanBasePackages`，否则**另一个人的 Bean 全都不会被注册**，启动起来一切正常、调接口却 404 或找不到 Bean。

这是「多人往同一个模块塞代码」时一个很典型的小坑，单人项目永远遇不到。

## 小结

- 微服务不是「很多个 Spring Boot」，而是**网关 + 注册配置中心 + RPC** 把它们编织成一个整体；
- 新人最该先建立的图是**「请求怎么从浏览器流到你的代码」**，其余细节用到再查；
- `ruoyi-api`=接口契约、`ruoyi-system`=地基、`ruoyi-common`=工具箱，这三个先记住；
- 多租户、鉴权这类「横切能力」是框架偷偷帮你做的，**别重复造、也别和它对着干**。

下一篇，我们从「第一次启动就报 `Unknown database`」开始，把环境搭建的坑挨个趟一遍。
