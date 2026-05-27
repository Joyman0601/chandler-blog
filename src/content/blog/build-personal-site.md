---
title: "个人网站搭建记录"
description: "记录 Chandler 的个人技术博客从本地项目、GitHub 仓库到 Cloudflare 自定义域名上线的完整过程。"
pubDate: 2026-05-27
tags: ["Astro", "个人网站", "Cloudflare", "部署"]
---

## 为什么要做个人网站

我希望有一个稳定的位置来沉淀技术笔记、项目复盘和长期学习记录。相比把内容分散在不同平台，个人网站更适合长期维护，也方便把 GitHub、B站和项目经历统一展示出来。

这个博客的定位很明确：个人主页 + 技术文章 + 项目展示 + 关于页面。第一阶段不追求复杂功能，先保证它能访问、能更新、能持续写。

## 技术选择

第一版使用 Astro 搭建，原因是它适合内容型网站：

- 页面生成静态 HTML，访问速度快。
- 文章可以直接用 Markdown 管理。
- 项目结构简单，适合长期维护。
- 后续可以继续加 sitemap、RSS、评论、统计等功能。

部署选择 Cloudflare Workers Git 部署，域名使用 `chandlerblog.com`。代码推送到 GitHub 后，Cloudflare 会自动构建并发布。

## 第一版页面结构

当前网站包含四个核心页面：

- 首页：展示个人方向、最近文章和精选项目。
- 文章：集中展示 Markdown 博客文章。
- 项目：整理正在做和已经完成的项目。
- 关于：介绍个人关注方向、写作内容和账号链接。

第一版内容围绕 Java、Spring 和 AI 大模型应用开发展开。后续文章会更多记录实际项目、问题排查和学习路径。

## 域名和部署

域名 `chandlerblog.com` 购买后，把 nameserver 切到 Cloudflare：

```text
alice.ns.cloudflare.com
maciej.ns.cloudflare.com
```

这样 Cloudflare 就成为这个域名的权威 DNS，可以统一管理 DNS 解析、HTTPS 证书、自定义域名绑定和重定向规则。

最终访问地址是：

```text
https://chandlerblog.com
```

同时配置了：

```text
https://www.chandlerblog.com
```

通过 301 跳转到根域名，避免搜索引擎把 `www` 和非 `www` 当作两套重复内容。

## 已完成的基础 SEO

第一版已经补上基础 SEO 信息：

- 每个页面有独立 title 和 description。
- canonical 统一指向 `https://chandlerblog.com`。
- 支持 Open Graph 和 Twitter Card。
- 生成 sitemap。
- 配置 robots.txt。

这些配置不会立刻带来搜索流量，但可以让网站结构更清晰，也方便后续被搜索引擎发现和收录。

## 后续计划

接下来我会优先做三件事：

1. 持续补充真正的技术文章，而不是只保留示例内容。
2. 把正在做的 RAG + Agent 项目整理成系列复盘。
3. 根据需要增加 RSS、访问统计、评论系统或深色模式。

第一版上线的重点不是功能多，而是建立一个可以持续迭代的起点。
