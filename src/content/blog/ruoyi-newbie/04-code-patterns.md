---
title: "04 代码分层与实现模式"
description: "在 RuoYi 业务模块里反复用到、且被验证靠谱的几个实现模式：DDD 分层、分页避免 N+1、多对多全量覆盖、租户内唯一校验、Dubbo 字段注入、翻译注解的边界。"
pubDate: 2026-06-14
tags: ["RuoYi", "MyBatis-Plus", "Dubbo", "MapStruct", "代码分层"]
series: "ruoyi-newbie"
seriesLabel: "微服务新人踩坑实录"
---

> 系列第四篇。前面都在讲环境，这篇回到代码。把我在这个模块里反复用到、且被验证靠谱的几个实现模式整理出来——它们不复杂，但每一个都对应过一次「为什么不这么写就出问题」。

## 分层：照着「样板模块」抄

RuoYi 是强约定的框架，每个业务实体一套固定分层。我直接参照系统模块的样板：

```
domain/XxxEntity.java          # 实体，继承 TenantEntity（带 update_*/remark 审计列 + tenant_id）
domain/bo/XxxBo.java           # 入参对象，@AutoMapper 映射到实体，带 Jakarta 校验注解
domain/bo/XxxQueryBo.java      # 列表查询入参，extends PageQuery（自带分页字段）
domain/vo/XxxVo.java           # 出参对象，带翻译注解
mapper/XxxMapper.java          # extends BaseMapperPlus<Entity, Vo>
service/IXxxService.java
service/impl/XxxServiceImpl.java
controller/XxxController.java
resources/mapper/XxxMapper.xml
```

新手最容易犯的错是「图省事，Controller 直接返回 Entity」。但 **BO / VO 分离是有用的**：
- **BO** 承载校验规则和「前端能传什么」；
- **VO** 承载「前端该看到什么」和翻译后的展示字段；
- **Entity** 是数据库的形状，不该直接暴露给前端。

三者之间用 MapStruct（`@AutoMapper`）自动转换，不用手写一堆 `set`。

> **一个构建相关的坑：** 改了字段名/类型后，MapStruct 生成的转换类需要重新生成，必须**重新构建模块**（带上 `-am` 把上游依赖也带上），否则会用到旧的映射类，出现「字段莫名没赋上」的灵异现象。

## 模式一：列表带嵌套集合，怎么避免 N+1

需求：区域列表，每个区域要带上它关联的网点集合（多对多）。

新手直觉是 JOIN + 集合映射一把梭，但这在分页场景下会出大问题：**JOIN 出来的多行会让分页的 `count` 算错**（一个区域关联 3 个网点就变 3 行）。

正确做法是「分页查主表 + 批量查关联 + 内存组装」：

```
1. 分页查区域主表（干净的分页，count 正确）
2. 收集本页所有区域 id
3. 用这批 id 一次性批量查关联表（一条 IN 查询，不是循环里查 N 次）
4. 在内存里 groupingBy(areaId) 把网点填回每个区域
```

> **经验：** **「分页主表」和「补充关联数据」要分开做**。JOIN 适合「一对一打平」，不适合「一对多还要分页」。批量查 + 内存组装，既绕开分页 count 问题，又避免了在循环里查库的 N+1。

## 模式二：多对多关系的「全量覆盖」更新

需求：保存「某区域关联哪些网点」，前端直接传一份完整的网点 id 列表。

最省心、最不容易出 bug 的实现是**先删后插**，而不是去 diff「哪些新增、哪些删除」：

```java
@Transactional(rollbackFor = Exception.class)
public boolean relateSites(Long areaId, List<Long> siteIds) {
    // 1. 删掉该区域所有旧关联
    areaSiteMapper.delete(Wrappers.<BizAreaSite>lambdaQuery()
        .eq(BizAreaSite::getAreaId, areaId));
    // 2. 重新插入新关联（空列表时跳过，避免插空）
    if (CollUtil.isNotEmpty(siteIds)) {
        List<BizAreaSite> list = siteIds.stream()
            .map(id -> new BizAreaSite(areaId, id))
            .collect(Collectors.toList());
        areaSiteMapper.insertBatch(list);
    }
    return true;
}
```

两个要点：
- 整个操作包在**事务**里，删一半失败要能回滚；
- **空列表也要处理**（代表「清空所有关联」），别漏了导致旧数据残留。

> **经验：** 「前端传全量、后端覆盖」的接口，**先删后插**比「精细 diff」简单得多，且不易出错。代价是几条多余的写操作，对这种低频配置型操作完全可接受——别为了省几行 SQL 把简单问题做复杂。

## 模式三：关联表不要无脑继承 `TenantEntity`

`biz_area_site` 这种**只增删、不修改**的关联表，我一开始也让它继承 `TenantEntity`，结果写库报错——因为 `TenantEntity` 带了 `update_by/update_time/remark` 这些列，而我的关联表压根没建这些列。

**解决：** 关联表只实现 `Serializable`，按需手动加 `create_*` 审计列和 `tenant_id`，**不继承带 `update_*` 的基类**。

> **经验：** 选基类要看**表真实有哪些列**。「只增删」的关联表用精简审计列；「会被修改」的业务主表才继承完整的 `TenantEntity`。基类带的列比表多，插入/更新就会撞上「Unknown column」。

## 模式四：租户内唯一校验，别手写 tenant_id

第 01 篇说过租户拦截器会自动补条件，这里给出唯一校验的标准写法（含「编辑时排除自己」）：

```java
boolean exists = mapper.exists(Wrappers.<BizArea>lambdaQuery()
    .eq(BizArea::getAreaName, areaName)
    // 编辑场景排除当前记录自身；新增时 excludeId 为 null，这个条件不生效
    .ne(ObjectUtil.isNotNull(excludeId), BizArea::getId, excludeId));
if (exists) {
    throw new ServiceException("名称已存在");
}
```

- **不写 `tenant_id`**：拦截器自动加，唯一性天然限定在「本租户内」；
- `ne(condition, ...)` 的第一个布尔参数是 MyBatis-Plus 的「条件成立才拼这段」，用它优雅地实现「新增不排除、编辑排除自己」。

## 模式五：Dubbo 字段注入，别跟 Lombok 构造器注入混用

跨模块取数据要 `@DubboReference`。但有个坑：

```java
// ❌ 这样不行：@RequiredArgsConstructor 走构造器注入，Dubbo 引用不支持
@RequiredArgsConstructor
public class BizAreaServiceImpl {
    @DubboReference private final RemoteUserService remoteUserService;
}

// ✅ Dubbo 引用必须用字段注入
public class BizAreaServiceImpl {
    @DubboReference
    private RemoteUserService remoteUserService;
}
```

> **经验：** 项目里大量用 Lombok 的 `@RequiredArgsConstructor` 做构造器注入，但 **`@DubboReference` 必须字段注入**，两者不能对同一个字段混用。

## 模式六：展示字段的翻译，交给注解

需求：列表要显示「负责人姓名」，但库里只存了「负责人用户 ID」。框架提供了序列化时自动翻译的注解：

```java
@Translation(type = TransConstant.USER_ID_TO_NICKNAME, mapper = "managerUserId")
private String managerName;   // 不用写任何查询代码，序列化时自动填充
```

**但有个重要边界：** 这个翻译发生在**响应序列化时**，所以——

> **它只能用于「展示」，不能用于「查询条件」。**

如果需求是「按负责人姓名**搜索**」，不能指望这个注解。得反过来：先把「姓名」通过 Dubbo 换成一批「用户 ID」，再作为 `IN` 条件去查。（也正是这个需求引出了第 03 篇那个 Dubbo 跨模块部署的大坑。）

## 小结

这几个模式没有一个是「高级技巧」，但它们共同体现了一种取向：

- **顺着框架的约定走**（分层、BO/VO、翻译注解），不自己另搞一套；
- **简单优先**（全量覆盖先删后插，而不是精细 diff）；
- **知道每个魔法的边界**（租户自动过滤、翻译只在序列化时、Dubbo 必须字段注入）。

新人写业务最大的浪费，是「不知道框架已经帮你做了」而重复造轮子，或者「不知道框架的魔法在哪生效」而用错地方。

下一篇是重灾区：字典/枚举的两套机制，以及 Excel 导入导出怎么把我炸了好几次。
