# Chandler的博客

个人技术博客项目，用于记录 Java、Spring、AI 大模型应用开发、项目复盘和长期学习。

线上地址：

```text
https://chandlerblog.com
```

GitHub 仓库：

```text
https://github.com/Joyman0601/chandler-blog
```

## 项目介绍

这是一个基于 Astro 搭建的个人主页和技术博客，当前包含：

- 首页：展示个人方向、最近文章和精选项目。
- 文章页：使用 Markdown 管理技术笔记和项目复盘。
- 项目页：展示个人项目和工程实践。
- 关于页：介绍学习方向、写作内容和账号链接。

博客名称为「Chandler的博客」，展示名为 Chandler，主要关注 Java / Spring / AI 大模型应用开发。

## 技术栈

- Astro
- TypeScript
- Markdown Content Collections
- CSS
- Cloudflare Workers Git 部署
- Cloudflare DNS / 自定义域名

## 本地开发

安装依赖：

```bash
npm install
```

启动开发服务器：

```bash
npm run dev
```

生产构建：

```bash
npm run build
```

本地预览构建结果：

```bash
npm run preview
```

## 内容结构

```text
src/content/blog/        博客文章
src/pages/               页面路由
src/components/          页面组件
src/layouts/             全局布局
src/data/site.ts         站点配置
src/styles/global.css    全局样式
public/robots.txt        搜索引擎抓取配置
```

## 写新文章流程

在 `src/content/blog/` 下新建 Markdown 文件，例如：

```text
src/content/blog/my-new-post.md
```

文章开头需要包含 frontmatter：

```md
---
title: "文章标题"
description: "文章描述，用于博客列表和 SEO。"
pubDate: 2026-05-27
tags: ["Java", "Spring", "RAG"]
---
```

本地确认构建：

```bash
npm run build
```

提交并推送：

```bash
git add .
git commit -m "Add my new post"
git push origin main
```

推送到 GitHub `main` 分支后，Cloudflare 会自动部署。部署成功后可访问：

```text
https://chandlerblog.com/blog/my-new-post/
```

## 部署

项目代码推送到 GitHub `main` 分支后，Cloudflare 会自动触发构建和部署。

当前配置：

```text
Build command: npm run build
Deploy command: npx wrangler deploy
Domain: chandlerblog.com
```

域名策略：

```text
https://chandlerblog.com        主域名
https://www.chandlerblog.com    301 跳转到根域名
```

## SEO

当前已配置：

- canonical URL
- meta description
- Open Graph
- Twitter Card
- sitemap
- robots.txt
- www 到根域名 301 跳转

## 后续计划

- 持续补充 Java / Spring / AI 大模型应用文章。
- 为 RAG 项目补充更多项目复盘和实现细节。
- 根据需要增加 RSS、访问统计、评论或深色模式。
