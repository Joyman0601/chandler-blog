# CLAUDE.md — 项目须知（随仓库走，Claude 每次自动读取）

## 给 Claude 的固化指令（读到这里就执行，无需用户再提醒）

- 本项目对话中，凡是出现**需要来回沟通才跑通**的关键问题（部署失败、环境坑、构建报错、配置不一致等），**解决后主动**把它追加到下面「踩坑记录」一节，格式：**现象 → 根因 → 修复**（各一两句即可，带日期）。
- 用户给出的**明确偏好或约束**，固化到「协作约定」一节。
- 这些是为了让新对话 / 换电脑 clone 后，你依然「记得」本项目的关键经验，不必让用户重讲。

## 项目概览

- 纯静态 **Astro 6** 博客：`astro build` → 输出 `dist/`，部署到 **Cloudflare（静态资源）**。
- **不要**安装 `@astrojs/cloudflare` adapter——本站无 SSR 需求，装了反而会引入 SESSION KV 等麻烦。
- 部署由根目录 `wrangler.jsonc` 钉死为静态资源上传（`assets.directory: ./dist`，无 worker、无 KV 绑定）。
- 仓库：`Joyman0601/chandler-blog`。
- 博客文章在 `src/content/blog/`；front-matter 字段受 `src/content.config.ts` 约束，仅允许：`title / description / pubDate / tags / series / seriesLabel`，多写字段会构建失败。同 `series` 值的文章在首页按 `seriesLabel` 分组。

## 发布博客文章的标准流程（新窗口照此执行，无需通读项目）

新增 / 修改文章并上线，按这套来：

1. **放置文件**：Markdown 放进 `src/content/blog/`。独立文章直接放根下；属于某系列的放进对应子目录（如 `ms-learn/`、`dev-env/`、`jeecgboot/`）。
2. **写 front-matter**：只能用这 6 个字段，多写任何字段都会构建失败——
   - `title`（字符串）、`description`（字符串）、`pubDate`（`YYYY-MM-DD`，不加引号）、`tags`（数组）、`series`（可选）、`seriesLabel`（可选）。
   - 同 `series` 值的文章在首页按 `seriesLabel` 归到一组；想让一组文章聚合显示，就给它们相同的 `series` + `seriesLabel`。
3. **本地构建验证**：跑 `npm run build`，必须 exit 0、页数符合预期（每篇文章 = 1 页）。构建报错通常是 front-matter 字段不对或日期格式不对。
4. **提交**：`git add` 具体文件 → `git commit`，commit message 说清改了什么。
5. **推送前先问用户**（见下方协作约定），得到同意后再 `git push origin main`。
6. **推送后**：Cloudflare 自动重新构建上线。可把线上 URL 报给用户：`https://chandlerblog.com/blog/<相对 src/content/blog 的路径，去掉 .md，末尾加 />`，例如 `src/content/blog/ms-learn/05-sentinel.md` → `https://chandlerblog.com/blog/ms-learn/05-sentinel/`。

## 协作约定

- **用中文回复，不要日文。**
- **推送 GitHub 前先征得用户同意，再 `git push`。**

## 踩坑记录

### Cloudflare 部署卡在 SESSION KV provisioning（2026-06-04）
- **现象**：Cloudflare 部署日志走到 `Provisioning SESSION (KV Namespace)...`，请求 `/storage/kv/namespaces` 报错，文件上传成功但网站不更新。
- **根因**：纯静态站被按 Workers/SSR 方式部署；Astro 6 默认开启 sessions，Cloudflare 自动注入一个 `SESSION` KV 绑定并尝试 provision，建 KV 失败（多为部署 Token 缺 Workers KV Storage:Edit 权限）。静态博客根本不需要 KV。
- **修复**：在根目录加 `wrangler.jsonc`，显式声明静态资源部署（`assets.directory: ./dist`，无 `main`、无 `kv_namespaces`），wrangler 不再自动建 KV。若仍报错，去 Cloudflare 项目 *Settings → Bindings* 删掉残留的 `SESSION` KV 绑定。
