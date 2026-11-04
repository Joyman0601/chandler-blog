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

## 从技术文章库导入

`scripts/import-articles.mjs` 将技术文章库的 `posts/` 导入 `src/content/blog/`，保留原稿，只发布 `draft: false` 的文章。README、索引和写作规范等管理文档不进入博客。

```bash
node scripts/import-articles.mjs ../md
node scripts/import-articles.mjs ../md --check
```

分类映射到博客的系列分组；相对 `.md` 文章链接转换为站内 `/blog/` 地址并保留查询参数与锚点，代码内容保持原样，表格内行内代码的竖线作必要转义，避免被当成分列符。缺失文章链接、未知元数据格式或与既有文章冲突时导入失败。重复导入相同输入不会修改文件，手动编辑过的导入文章也不会被直接覆盖。

文章库的 `date` 表示素材发生日期，可选 `pubDate` 表示明确的公开发布日期。新文章优先使用 `pubDate`，没有时使用 `date`；已有导入文章没有显式 `pubDate` 时，保留博客中经过来源标识及完整摘要校验的既有发布日期。需要主动改发布日期时，在原稿中明确填写 `pubDate`。

新增、补录或修改文章不会重新分配旧文日期。日常新稿在文章库填写实际整理发布的 `pubDate`；不再随机排日期，不限制每天的篇数，也没有固定日期窗口。脚本不以运行当天覆盖日期。原稿 `date` 保留在生成文件的注释中；`updated` 如存在则映射为不早于发布日期的 `updatedDate`。

导入文章以文章库原稿为正文维护源。`--check` 只检查导入副本是否同步，不写入文件。日期、手动改稿保护和失败时不写入等回归用例可直接运行：

```bash
node --test scripts/import-articles.test.mjs
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
