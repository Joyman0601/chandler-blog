---
title: "深入 JeecgBoot 3.9.2 源码：多租户 & 低代码平台原理解析"
description: "基于 JeecgBoot 3.9.2 源码，解析多租户行级隔离的完整实现链路，以及低代码 Online 平台元数据驱动、解释执行的底层原理。"
pubDate: 2026-03-28
tags: ["JeecgBoot", "多租户", "低代码", "MyBatis-Plus"]
series: "jeecgboot"
seriesLabel: "JeecgBoot 项目"
---

> 本文基于对 JeecgBoot 3.9.2 源码的实际阅读整理，聚焦两个核心主题：多租户的实现机制，以及低代码平台的底层原理。适合已有 Spring Boot / MyBatis-Plus 基础、想理解平台设计思路的读者。

---

## 一、多租户：行级隔离是怎么做到的

### 1.1 方案选型

多租户在技术实现上有三种常见方案：

| 方案 | 说明 | 代价 |
|---|---|---|
| **独立数据库** | 每个租户一个库 | 运维成本极高 |
| **独立 Schema** | 每个租户一套表 | 建库逻辑复杂 |
| **行级隔离** | 所有租户共用一张表，靠字段区分 | 所有表必须有 `tenant_id` 字段 |

JeecgBoot 选择了**行级隔离**，并且默认是**关闭**的——一个静态布尔开关控制一切：

```java
// MybatisPlusSaasConfig.java
public static final Boolean OPEN_SYSTEM_TENANT_CONTROL = false;
```

开启后，凡是加入 `TENANT_TABLE` 白名单的业务表（如 `sys_depart`、`sys_category`、Online 自定义表等），所有 SQL 都会被自动注入租户过滤条件。

---

### 1.2 SQL 层：MyBatis-Plus 拦截器自动注入

核心是 MyBatis-Plus 提供的 `TenantLineInnerInterceptor`，它在 SQL 执行前介入，把原始查询改写成带租户条件的版本：

```sql
-- 原始 SQL
SELECT * FROM sys_depart WHERE status = 1

-- 执行时自动变成
SELECT * FROM sys_depart WHERE status = 1 AND tenant_id = 1001
```

配置时需要实现 `TenantLineHandler` 接口：

```java
new TenantLineHandler() {
    @Override
    public Expression getTenantId() {
        // 从 ThreadLocal 取当前请求的租户 ID
        String tenantId = TenantContext.getTenant();
        return new LongValue(tenantId);
    }

    @Override
    public boolean ignoreTable(String tableName) {
        // 白名单模式：不在列表里的表，直接跳过隔离
        return !TENANT_TABLE.contains(tableName.toLowerCase());
    }
}
```

注意 `ignoreTable` 的逻辑是反向白名单：**在列表里才隔离，不在列表里直接跳过**。`sys_menu`、`sys_role`、`sys_permission` 等系统配置表不做隔离，所有租户共享。

---

### 1.3 请求层：ThreadLocal 传递租户上下文

每个 HTTP 请求携带请求头 `X-Tenant-Id`，由 `JwtFilter` 在请求生命周期的最开始提取并存入 ThreadLocal：

```java
// JwtFilter.preHandle()
String tenantId = httpServletRequest.getHeader(CommonConstant.TENANT_ID);
TenantContext.setTenant(tenantId);   // 存入 ThreadLocal

// JwtFilter.afterCompletion()
TenantContext.clear();               // 请求结束后必须清理，防止内存泄漏
```

`TenantContext` 本质就是一个 ThreadLocal 的简单包装，确保并发请求之间的租户信息不会互相污染。

---

### 1.4 认证层：ShiroRealm 验证用户是否有权访问该租户

JWT 验证通过之后，ShiroRealm 还会做一次额外的租户归属校验：

```java
// 用户关联的所有租户：从 sys_user_tenant 表查出，登录时一次性加载
String relTenantIds = loginUser.getRelTenantIds();  // "1001,1002"

// 当前请求声称要访问的租户
String contextTenantId = TenantContext.getTenant();  // "1001"

// 校验：用户是否有权访问这个租户？
if (!Arrays.asList(relTenantIds.split(",")).contains(contextTenantId)) {
    throw new AuthenticationException("登录租户授权变更，请重新登陆!");
}
```

这一层保证了：即使攻击者修改请求头里的 `X-Tenant-Id`，也无法访问自己没有权限的租户数据。

---

### 1.5 完整请求流程

```
前端请求（携带 X-Tenant-Id: 1001）
    │
    ▼
JwtFilter.preHandle()
    └─ TenantContext.setTenant("1001")        ← ThreadLocal 存储

    ▼
ShiroRealm.checkUserTokenIsEffect()
    ├─ 解析 JWT，找到 loginUser
    ├─ 查 relTenantIds = "1001,1002"
    └─ 验证 "1001" 在列表里 → 放行

    ▼
业务代码执行（Service / Mapper）

    ▼
TenantLineInnerInterceptor 拦截 SQL
    └─ SELECT * FROM sys_depart WHERE ...
       自动改写为:
       SELECT * FROM sys_depart WHERE ... AND tenant_id = 1001

    ▼
JwtFilter.afterCompletion()
    └─ TenantContext.clear()                  ← 清理 ThreadLocal
```

---

### 1.6 用户表是个特例：N:N 关系而非字段

一个容易产生误解的地方：`sys_user` 表**没有 `tenant_id` 字段**。

用户是"人"，可以同时受雇于多家公司（属于多个租户）；但一条业务数据（如一张订单）只能属于一家公司。因此两者的数据模型不同：

- **业务数据（订单、部门等）**：多对一，用 `tenant_id` 字段表示
- **用户与租户的关系**：多对多，用独立关联表表示

```sql
-- 用户-租户 N:N 关联表
CREATE TABLE sys_user_tenant (
  user_id   varchar(32),   -- 指向 sys_user
  tenant_id int,           -- 指向 sys_tenant
  status    varchar(1)     -- 1正常 2冻结 3待审核 4拒绝
);

-- 张三属于两个租户
INSERT INTO sys_user_tenant VALUES ('张三id', 1001, '1');
INSERT INTO sys_user_tenant VALUES ('张三id', 1002, '1');
```

登录时一次性查出该用户的所有有效租户，拼成逗号分隔的字符串挂在 `LoginUser` 对象上：

```java
loginUser.relTenantIds = "1001,1002"
```

用户切换租户时，前端只需要把 `X-Tenant-Id` 换成另一个值，后端 ShiroRealm 校验通过后，SQL 层的过滤条件就会自动切换，整个过程对业务代码完全透明。

---

### 1.7 这套方案的权衡

| 优点 | 代价 |
|---|---|
| 实现简单，无需多数据源 | 所有业务表必须有 `tenant_id` 字段 |
| SQL 层自动注入，业务代码无感 | 忘记开 `OPEN_SYSTEM_TENANT_CONTROL` 会全量返回数据 |
| 支持一用户多租户，灵活切换 | Redis 是认证链路的关键依赖（JWT 续期也在 Redis） |
| ThreadLocal 线程安全隔离 | ThreadLocal 必须手动清理，否则内存泄漏 |

---

## 二、低代码平台：从"写死代码"到"解释执行"

### 2.1 核心问题

普通的 Spring Boot CRUD 开发，整条链路的前提假设是：**写代码的时候就知道表长什么样**。

```
Controller → Service → Mapper（固定 Entity）→ MyBatis XML（固定 SQL）→ 数据库
```

低代码平台要解决的是完全相反的问题：**写框架代码的时候不知道用户将来会配置什么表，但仍然要能对任意表做 CRUD**。

---

### 2.2 解法：放弃 Entity，换成 Map + 动态 SQL

普通写法中，Mapper 操作的是固定的实体类：

```java
List<Order> list = orderMapper.selectList(queryWrapper);
```

Online 运行时的做法（`jeecg-online.jar` 内部推断）：

```java
// tableName 来自请求参数，运行时才知道
String tableName = params.getString("tableName");

// 不用实体类，用 Map 接收数据
String sql = "SELECT * FROM " + tableName + " WHERE tenant_id = ?";

// JdbcTemplate 执行，返回 List<Map<String,Object>>
List<Map<String, Object>> rows = jdbcTemplate.queryForList(sql, tenantId);
```

**本质就一句话：用 `Map<String,Object>` 代替 Entity，用运行时拼 SQL 代替 MyBatis XML。**

---

### 2.3 元数据的作用

光有动态 SQL 还不够。还需要知道：这张表有哪些字段？字段什么类型？哪些字段显示在列表？哪些字段是必填的？

这些"关于数据结构的数据"就是**元数据**，存储在 `onl_cgform_field` 表里：

```
db_field_name   = "order_no"   ← 数据库字段名，拼 SQL 用
db_type         = "varchar"    ← 字段类型，做类型转换用
field_show_type = "input"      ← 前端渲染什么控件
is_query        = 1            ← 是否出现在搜索栏
field_must_input = 1           ← 是否必填
field_extend_json = "{...}"    ← 扩展配置（JSON）
```

运行时 CRUD 流程：

```
POST /online/cgform/api/saveData
  { tableName: "cg_order", record: { order_no: "001", amount: 999 } }
            │
            ▼
1. SELECT * FROM onl_cgform_field WHERE cgform_head_id = ?
   → 取出字段定义列表
            │
            ▼
2. 遍历 record 里的每个 key-value：
   - 查元数据，确认字段存在且合法
   - 根据 db_type 做类型转换（"999" → 999.0）
   - 组装 INSERT 的字段列表和值列表
            │
            ▼
3. jdbcTemplate.update(
     "INSERT INTO cg_order (order_no, amount, ...) VALUES (?, ?, ...)",
     ["001", 999.0, ...]
   )
```

---

### 2.4 两条路径：直接运行 vs 代码生成

Online 平台给了用户两种选择：

```
配置好的元数据
    │
    ├──→ [直接运行]  ────────────────→ 无需生成代码，配置即上线
    │       读元数据 → 动态 SQL → JDBC      前端自动渲染控件
    │       由 jeecg-online.jar 负责
    │
    └──→ [代码生成]  ────────────────→ 固化成可手工维护的代码
            FreeMarker 模板渲染              产出 Java + Vue + SQL 文件
            模板在 resources/jeecg/code-template-online/
```

两者并不互斥：先用直接运行快速验证业务逻辑，确认无误后再代码生成转入正式开发，是一种常见的工作流。

---

### 2.5 增强机制：解决 20% 的个性化需求

通用 CRUD 引擎只能覆盖大多数标准场景，复杂业务逻辑需要通过"钩子"注入。JeecgBoot 提供三层增强：

**JS 增强**（前端联动，存 `onl_cgform_enhance_js`）：

```javascript
// 当 sex 字段变化时，联动清空 age 字段
onlChange() {
  return {
    sex() {
      that.triggleChangeValues({ age: 0 });
    }
  }
}
```

**Java 增强**（后端拦截，存 `onl_cgform_enhance_java`）：

```java
@PostMapping("/enhanceJavaHttp")
public Result<?> enhanceJavaHttp(@RequestBody JSONObject params) {
    JSONObject record = params.getJSONObject("record");

    // 校验：返回 error 则中断保存
    if (isEmpty(record.getString("phone"))) {
        return Result.error("手机号不能为空！");
    }

    // 修改数据后透传给引擎继续执行
    record.put("phone", "010-" + record.getString("phone"));
    return Result.OK(Map.of("code", 1, "record", record));
}
```

**SQL 增强**（操作后附加 SQL，存 `onl_cgform_enhance_sql`）：用于保存后同步库存、写审计日志等场景。

---

### 2.6 演化历史

理解这套设计，还需要看它是怎么一步步演化过来的：

```
阶段一：纯代码生成器（早期 Jeecg，2012 年前后）
  用户填配置 → 工具跑模板 → 输出 Java/XML/JSP 代码 → 手动粘贴进项目 → 编译部署
  本质：批量帮你写代码的工具，和 MyBatisGenerator 是同一个思路

          ↓ 关键转变：为什么要生成代码再编译？直接运行不行吗？

阶段二：Online 解释执行（JeecgBoot 2.x）
  同样的元数据配置，不生成代码
  运行时读元数据 → 动态 SQL → JdbcTemplate 执行
  前端读元数据 → FormSchemaFactory 动态渲染控件
  本质：把"编译时确定"变成"运行时解释"（和脚本语言 vs 编译语言是同一个权衡）

          ↓ 功能越来越复杂，商业化需要保护核心知识产权

阶段三：黑盒化（JeecgBoot 3.x）
  Online 运行时提取为独立的 jeecg-online.jar，闭源
  以 Maven 依赖方式引入：org.jeecgframework.boot3:jeecg-online
  开放：元数据表结构 + 代码生成模板 + 增强接口
  用增强机制解决个性化需求
```

---

### 2.7 黑盒的边界

```
┌──────────────────────────────────────────┐
│         jeecg-online.jar（闭源）          │
│                                          │
│  输入：                                  │
│    tableName（请求参数）                  │
│    record（请求体）                       │
│    onl_cgform_* 元数据表                 │
│                                          │
│  内部：读元数据 → 校验 → 类型转换         │
│        → 动态 SQL → JdbcTemplate 执行   │
│        → 调用增强钩子                    │
│                                          │
│  输出：Result<T>（标准响应）              │
└──────────────────────────────────────────┘

你能控制的（开放接口）：
  ✅ 元数据配置（字段定义、控件类型、校验规则）
  ✅ JS 增强（前端联动、提交前校验）
  ✅ Java 增强（后端数据拦截、外部系统调用）
  ✅ SQL 增强（操作后附加 SQL）
  ✅ 代码生成（把元数据固化成可维护的手写代码）
```

---

## 三、两个模块的交汇点

多租户和低代码并不是独立的两个模块，它们在几个关键位置深度集成：

- **数据隔离**：Online 同步建表时自动加 `tenant_id` 字段；运行时 CRUD 由 `TenantLineInnerInterceptor` 自动过滤，无需额外处理。
- **认证链路**：Online 接口同样经过 `JwtFilter` + `ShiroRealm`，共用同一套认证和租户校验逻辑。
- **公共字段**：`MybatisInterceptor` 在 INSERT 时自动注入 `create_by`、`create_time`、`tenant_id`，对 Online 动态 CRUD 同样生效。

---

## 小结

| | 多租户 | 低代码 Online |
|---|---|---|
| **核心思想** | 行级隔离，SQL 自动注入 `tenant_id` | 元数据驱动，运行时解释执行 |
| **关键组件** | `TenantLineInnerInterceptor` + `TenantContext` | `jeecg-online.jar` + `onl_cgform_*` 元数据表 |
| **透明度** | 业务代码无感，框架层自动处理 | 核心引擎闭源，通过增强钩子介入 |
| **代价** | 所有业务表必须有 `tenant_id` | 性能略低于编译期确定的代码 |
| **默认状态** | 关闭（需手动开启） | 开启（配置即可使用） |

两者共同体现了 JeecgBoot 的设计哲学：**把"变化的部分"从代码里抽出来，放进数据库配置**——多租户把"属于谁"放进数据行，低代码把"表结构定义"放进元数据表，本质是同一个思路在不同层次的应用。
