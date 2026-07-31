---
title: "自建 Langfuse 反代到公网：六个非踩不可的坑"
description: "给 RAG 项目自建 Langfuse 观测栈，独立 compose stack 通过 external network 复用主 stack 内网。踩了六个坑：NEXTAUTH_URL 精确匹配、Postgres 数据卷不能挂父目录、Next.js 反代必带 Upgrade 头、web 镜像必须 rebuild 才吃 nginx.conf、Langfuse UI trace input/output 独立于 generation、input 必须是 JSON message 数组。这篇原样复盘，希望能省别人几小时。"
pubDate: 2026-08-13
tags: ["Langfuse", "可观测性", "Docker Compose", "Nginx", "反向代理", "RAG"]
series: "rag"
seriesLabel: "RAG 项目"
---

> 一句话总结：给 RAG 项目做观测层，选了自建 Langfuse 而不是 Cloud——数据不出内网、面试可以给面试官 read-only 链接看真实 trace。整个过程从「拷官方 compose」到「面试官能匿名点开 trace 详情」花了 3 小时，其中至少 2 小时在排坑。这篇按踩到的顺序把 6 个坑复盘出来：观测栈解耦、NEXTAUTH_URL、Postgres 数据卷路径、Next.js 反代 WS 头、`web` 镜像必须 rebuild、以及最耗时的一个——Langfuse UI 里 trace input/output 显示为 null 的排查。

## 0. 起因：为什么不用 Langfuse Cloud

Langfuse 有 Cloud 版，免费额度对演示环境完全够。但我最后还是选了自建：

1. **数据不出内网**：面试演示的 prompt/response 里可能有脱敏 markdown 内容，不想上传给第三方，哪怕是免费的。
2. **面试演示的完整度**：README 里能写「自建 Langfuse + 公开 read-only 链接」，比「Cloud 免费额度」听着工程师味重。
3. **踩坑本身就是内容**：自建过程本身会积累一堆运维经验，日后写博客/面试都能用。

架构长这样：

```
observability.rag.chandlerblog.com (Cloudflare A 记录, DNS only)
  ↓ HTTPS
Nginx (web 容器, TLS 终结, 反代)
  ↓ HTTP 走 docker 内网
langfuse-server (Next.js, 3000 端口)
  ↓
langfuse-db (Postgres 16)
```

同时 Spring Boot 应用侧从 docker 内网直接上报到 `http://langfuse-server:3000`，**绕过公网 TLS**，省一次 TLS 握手 + 证书依赖。

## 1. 独立 stack + external network：观测栈解耦

第一个设计决策：`docker-compose.langfuse.yml` **不合并**进 `docker-compose.prod.yml`。

分开的原因：

- **可独立下线/升级**：观测栈更新不影响 RAG 主链路
- **可独立监控资源**：`docker stats` 看观测栈单独占多少内存
- **失败隔离**：Langfuse 挂了不能连锁把 app 拖挂

两个 stack 通过 external network 共享内网：

```yaml
# docker-compose.prod.yml (主 stack, 自动创建网络)
networks:
  rag-net:
    driver: bridge

# docker-compose.langfuse.yml (观测 stack, 引用已有网络)
networks:
  rag-net:
    external: true
    name: rag-prod_rag-net    # ← compose 默认命名规则:项目名_网络定义名
```

`rag-prod_rag-net` 这个名字来自 docker compose 的默认命名规则：**项目名（当前目录名 `rag-prod`）+ 下划线 + 网络定义名（`rag-net`）**。手动 `docker network ls` 能看到。

**启动顺序有依赖**：必须先起主 stack 创建网络，再起 langfuse stack 引用它。反过来会报「network rag-prod_rag-net not found」。

**面试口径**：这套设计的核心思想是「业务栈 vs 观测栈解耦」。配合 `LangfuseClient` 里的 **fire-and-forget + `log.warn` 静默吞异常**——Langfuse 挂了，业务只是不上报 trace，不 fail 任何请求。

## 2. NEXTAUTH_URL 必须精确匹配对外 URL

Langfuse 是 Next.js + NextAuth 实现。`NEXTAUTH_URL` env 用于**校验登录回调**和**生成 cookie domain**。

一开始我照抄官方示例的 `docker-compose.yml`：

```yaml
langfuse-server:
  environment:
    NEXTAUTH_URL: http://localhost:3000
```

跑起来之后，本地 SSH tunnel 登录能进主页，但**任何操作都无限重定向到登录页**。cookie 也没设上。

**根因**：NEXTAUTH_URL 必须**精确等于用户浏览器访问时的 scheme+host**（含 `https://`）。用户实际访问的是 `https://observability.rag.chandlerblog.com`，但 NextAuth 期望的是 `http://localhost:3000`——校验不过，cookie 不写。

**修复**：从 `.env.prod` 读并强校验：

```yaml
langfuse-server:
  environment:
    NEXTAUTH_URL: ${LANGFUSE_NEXTAUTH_URL:?LANGFUSE_NEXTAUTH_URL is required}
```

`.env.prod`:

```bash
LANGFUSE_NEXTAUTH_URL=https://observability.rag.chandlerblog.com
```

`:?` 强校验的原因是：这个变量忘了填一定会翻车，与其运行时排半天不如启动时立刻爆炸。

## 3. Postgres 数据卷不能挂父目录

第二个 3 分钟才排出来的坑。

一开始 langfuse-db 的 volume 挂成了这样：

```yaml
langfuse-db:
  image: postgres:16
  volumes:
    - langfuse_pg_data:/var/lib/postgresql   # ← 错误:挂到父目录
```

启动直接报：

```
initdb: directory "/var/lib/postgresql/data" exists but is not empty
FATAL: database directory appears to contain a database, but is missing files
```

**根因**：官方 `postgres` 镜像的**数据目录是 `/var/lib/postgresql/data`**（子目录），初始化脚本、配置文件、辅助文件散在 `/var/lib/postgresql` 下其他地方。**如果把 volume 挂到父目录 `/var/lib/postgresql`，会把那些辅助文件顶掉**——启动脚本找不到就报错。

**修复**：挂到子目录：

```yaml
volumes:
  - langfuse_pg_data:/var/lib/postgresql/data
```

**面试口径**：容器数据卷挂载粒度要贴合镜像官方约定的 `PGDATA` 路径，不能拍脑袋挂父目录图省事。同类问题在 Redis (`/data`)、MySQL (`/var/lib/mysql`) 都要遵守各自镜像的约定。

## 4. Next.js 反代必须带 Upgrade / Connection 头

Langfuse 有 WebSocket 和 SSE 通路——live trace 尾追、实时 dashboard 都靠它。Nginx 反代如果不带 WS 升级头，面板加载后大部分**静态渲染 OK**（迷惑性极强），但**实时功能失效**、`useEffect` 里的实时订阅永远 pending。

正确的反代块长这样：

```nginx
server {
  listen 443 ssl http2;
  server_name observability.rag.chandlerblog.com;

  ssl_certificate /etc/letsencrypt/live/observability.rag.chandlerblog.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/observability.rag.chandlerblog.com/privkey.pem;

  client_max_body_size 20m;    # Langfuse ingestion body 可能较大

  location / {
    proxy_pass http://langfuse-server:3000;
    proxy_http_version 1.1;              # ← WS 需要 HTTP/1.1
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 120s;             # SSE 长连接
  }
}
```

**这套配置不套 `rag_api` 限流 zone**——观测流量本身是内部流量，不做限流。

## 5. 修完还是 `SSL: no alternative certificate`——因为 `web` 镜像没 rebuild

这个坑最坑。前面 4 个都改完了，DNS 也解析到位、certbot 也签好了 observability 子域名的证书，`curl` 一测：

```bash
curl -I https://observability.rag.chandlerblog.com
# curl: (60) SSL: no alternative certificate subject name matches target host name
```

`no alternative certificate subject name`——SNI 匹配失败，fallback 到主域名的证书。可我明明在 `nginx.conf` 里加了 observability 子域名的 server 块啊。

进 web 容器 `cat /etc/nginx/nginx.conf`——**里面根本没有 observability 那段**。

**根因**：`frontend/nginx.conf` 是在 `frontend/Dockerfile` 的 build 阶段 **COPY 进镜像**的：

```dockerfile
FROM nginx:1.27-alpine
COPY nginx.conf /etc/nginx/nginx.conf
```

我 `git pull` 拉到了新的 `nginx.conf`，但**没有 rebuild 镜像**。`docker compose restart web` / `docker compose up -d web`（不带 `--build`）都是**复用旧镜像**——旧镜像里的 nginx.conf 是拉取前的老版本。

**修复**：

```bash
dcp up -d --build web
```

带上 `--build` 才会重新跑 `docker build`，把新 nginx.conf COPY 进新镜像。

**面试口径**：Docker 里 **build-time 资产**（COPY 进的配置、静态文件）改了必须 `--build`；**run-time 资产**（挂 volume 的、env vars）改了 `up -d` recreate 就够。这是 Docker 生命周期里最容易搞混的两类。

## 6. Langfuse UI 里 trace input/output 显示 null——两轮修复

最后一个坑，也是耗时最久的。埋点代码写完，Spring Boot 侧上报了三条 `/api/rag/ask`，去 Langfuse UI 看：

**Trace 列表**：能看到 3 条 trace，时间、latency、cost 都对。

**点进详情**：顶部 input / output 显示 `null`。子 generation 有内容。

第一直觉是「上报没塞进去」，进 langfuse-db 查：

```sql
SELECT input, output FROM observations WHERE trace_id = '...' LIMIT 5;
```

`observations.input` 是完整的 message 数组内容，**数据在数据库里**。

**根因（第一版）**：Langfuse UI 的 trace 概览**是从 trace 对象本身的 input/output 字段读的**——不是从子 generation 聚合上来。SDK 概念里，`trace` / `span` / `generation` 是三层独立的观察点，UI 每一层展示独立读取。我只在 generation 层塞了 input/output，trace 层为空。

**第一版修复**：`LangfuseTracer.buildTraceEvent` 也塞 input/output：

```java
private Map<String, Object> buildTraceEvent(TraceContext ctx, String input, String output) {
  return Map.of(
    "type", "trace-create",
    "body", Map.of(
      "id", ctx.traceId(),
      "name", ctx.name(),
      "input", input,       // ← 新加
      "output", output      // ← 新加
    )
  );
}
```

Rebuild、部署、跑问答、看 UI……**还是 null**。

进 DB 查 traces 表：`traces.input` 是我传的字符串 `"[system] xxx\n[user] xxx"`，UI 上还是显示 null 或者显示成不像话的样子。

**根因（第二版）**：Langfuse UI 用 **chat/message 结构化视图**渲染 input/output，期望的是：

- `input`: `List<Map<String,String>>`，形如 `[{"role":"system","content":"..."}, {"role":"user","content":"..."}]`
- `output`: `Map<String,String>`，形如 `{"role":"assistant","content":"..."}`

我传的是拼接字符串，字段类型不对——DB 存下来了但 UI 渲染不出气泡。

**第二版修复**：

```java
// LlmClient 里埋点前构造 message 数组
List<Map<String, String>> messages = List.of(
    Map.of("role", "system", "content", systemPrompt),
    Map.of("role", "user", "content", userPrompt)
);
Map<String, String> output = Map.of(
    "role", "assistant",
    "content", answer
);

langfuseTracer.recordGeneration(ctx, messages, output, latencyMs, usage);
```

`LangfuseTracer.recordGeneration` 的参数类型也从 `String input, String output` 改成 `Object`，让 Jackson 按实际类型序列化。

Rebuild、部署、跑问答……**这次终于看到 chat 气泡了**：system 消息、user 消息、assistant 回复分块渲染。

**面试口径**：可观测性上报的字段格式**不是「能传就行」**，UI 层往往有隐式契约（比如 chat message 数组）。埋点前先看官方 SDK 示例的结构，别直觉写。

## 收尾

回头看这 6 个坑：

1. **NEXTAUTH_URL 精确匹配** — 抄示例翻车，env 强校验挡住
2. **Postgres 数据卷** — 挂父目录顶掉辅助文件，挂子目录 `/data`
3. **Next.js 反代 Upgrade 头** — 缺 WS 升级头，静态渲染 OK 实时功能挂
4. **web 镜像必须 rebuild** — build-time 资产改了要 `--build`，`restart` 白改
5. **trace input/output 独立于 generation** — 三层观察点独立读取
6. **input 必须是 JSON message 数组** — UI 隐式契约，字符串上报显示空

其中 5 和 6 是可观测性 SDK 的**「UI 隐式契约」**这类问题，最难排——因为数据在 DB 里、SDK 也没报错、只是 UI 展示空。教训是：**遇到这种情况先看 UI 源码或者官方 example 而不是猜**。我最后是翻了 Langfuse 的 GitHub examples 才发现 message 数组结构的。

其他 4 个（1、2、3、4）都是**「Docker Compose + 反向代理」**的通用陷阱，跟自建任何 Next.js 应用都会踩到，不局限于 Langfuse。如果你在自建 Metabase、Grafana、Sentry 之类，这几个坑照样适用。

面试如果被追问「你的项目怎么落地可观测性」，除了讲埋点设计（trace/span/generation 三层），我最想强调的是**「Langfuse 挂了业务不 fail」**这个降级策略——fire-and-forget + `log.warn` 静默吞异常，业务链路和观测链路彻底解耦。这个思路和我之前写[对话式改写](/blog/rag-conversational/)里的「增强类功能失败就降级」是一脉相承的。
