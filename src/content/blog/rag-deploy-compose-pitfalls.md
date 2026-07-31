---
title: "把 RAG 项目部署上云的那天，我踩了六个坑"
description: "本地跑得好好的 Spring Boot + pgvector + Vue3，第一次用 Docker Compose 上云那天基本上是每半小时一个坑。healthcheck 拖崩 app、上传接口两条数据链踩混、pgvector 维度硬编码、docker compose --env-file 必带……复盘一下这六个每一个都够我心态崩一次的坑。"
pubDate: 2026-07-29
tags: ["Docker", "Docker Compose", "pgvector", "PostgreSQL", "部署", "RAG"]
series: "rag"
seriesLabel: "RAG 项目"
---

> 一句话总结：这个 RAG 项目本地跑了几个月都很稳，为了面试演示要把它部署到阿里云 ECS 上。我给自己估的时间是「一下午」——毕竟 Dockerfile 都写好了、`docker-compose.prod.yml` 也 review 了好几遍。实际花了 **3.5 小时**，踩了 **6 个坑**。这篇把每个坑的现象、根因、修复原样记下来，尤其想强调其中几个「本地写 compose 时根本想不到会翻车」的点。

## 0. 起因

项目是一个基于 Spring Boot + pgvector 的 RAG 系统，本地开发时是这样跑的：

- Spring Boot 直接在 IDEA 里启动
- 前端 `npm run dev` 跑 Vite dev server
- pgvector 用 `docker-compose.pgvector.yml` 起一个单独的容器

现在要上云，改成 3 容器同时起：

```
pgvector（PostgreSQL 15 + pgvector 扩展）
  ↓
app（Spring Boot jar，maven → jre 两阶段构建）
  ↓
web（Vue 打包 + Nginx，反代 /api → app:19090）
```

我提前一天把 `docker-compose.prod.yml` / 后端 `Dockerfile` / 前端 `Dockerfile` / `nginx.conf` / `.env.prod.example` 都写好了，看着挺完整的。真到服务器上一跑——每一个都出问题。

## 1. 首次 `docker compose up`：pgvector 被判「unhealthy」直接把 app 拖崩

现象：

```bash
docker compose -f docker-compose.prod.yml up -d
```

跑完立刻 `docker compose ps`，看到：

```
rag-pgvector     Up 45 seconds (health: starting)
rag-app          Exited (1)
rag-web          Up 45 seconds
```

app 直接退出了。日志翻上去，是 Spring Boot 启动时连 pgvector 报 `Connection refused`——但 pgvector 明明在跑啊。

**根因**：我在 `docker-compose.prod.yml` 里配了：

```yaml
app:
  depends_on:
    pgvector:
      condition: service_healthy
```

意思是「等 pgvector healthy 了再起 app」。但 pgvector 的官方镜像 healthcheck 走 `pg_isready`，冷启动前 30-60 秒会一直返回 `starting`。Docker Compose 的 `service_healthy` 是**有超时限制**的——如果 pgvector 在超时窗口内没变 healthy，`depends_on` 会**放行 app 启动**，而不是继续等。

app 一启动就撞上 pgvector 还在做 initdb（跑 `docker-entrypoint-initdb.d/*.sql`），端口开着但拒接连接，直接 `Connection refused` 崩掉。

**修复**：其实没改配置。就是**再跑一遍 `docker compose up -d`**——第二次 pgvector 已经初始化过了，几秒钟就 healthy，app 一次性起来。

这个坑不是配置错，是**首启动的 initdb 时间**没在我预期内。教训是：`healthcheck.start_period` 得给足够长（默认 0s，我后来改成了 60s），或者接受首次部署要跑两遍 up 这个事实。

## 2. `docker compose ps` 报 `PG_PASSWORD is missing`——只有 `up` 带了 `--env-file`

第二个坑发生在几分钟后。我想看看容器状态：

```bash
docker compose -f docker-compose.prod.yml ps
```

结果直接报错：

```
required variable PG_PASSWORD is missing a value: err
```

明明 `up -d` 时是能起来的啊？我 `.env.prod` 就在旁边。

**根因**：我在 `docker-compose.prod.yml` 里对敏感变量用了强校验语法：

```yaml
pgvector:
  environment:
    POSTGRES_PASSWORD: ${PG_PASSWORD:?PG_PASSWORD is required}
```

这个语法要求变量必须有值，否则报错。而 `docker compose` 有一个反直觉的行为：**除了 `up` 之外的所有子命令，都不会自动读 `.env` 文件**。`ps` / `logs` / `down` / `exec` 全部要显式带 `--env-file`：

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod ps
```

**修复**：在服务器 `~/.bashrc` 里加了个 alias：

```bash
alias dcp='docker compose -f /opt/rag/docker-compose.prod.yml --env-file /opt/rag/.env.prod'
```

以后所有命令都用 `dcp` 前缀。教训是：只要你在 compose 里用了 `${VAR:?...}` 强校验，就一定要习惯性 `--env-file`，别偷懒。

## 3. 灌 seed 文档返 415——错走了另一个 controller

第三个坑发生在灌演示文档时。我要往新起的 pgvector 里灌 5 篇脱敏 markdown。直觉写了：

```bash
curl -X POST https://rag.chandlerblog.com/api/rag/documents \
  -H "Content-Type: multipart/form-data" \
  -F "file=@01-年假.md"
```

得到 `415 Unsupported Media Type`。改 `application/json`？也不对。换 form-data？还是不对。

**根因**：项目里其实**有两条独立的上传数据链**：

| 端点 | Controller | Service | 用途 |
|---|---|---|---|
| `POST /api/documents/upload` | `DocumentController` | `DocumentService` | 前端 Docs 页正式用，multipart 上传，异步 ingest 到 pgvector |
| `POST /api/rag/documents` | `RagController` | `RagService` | 老接口，吃 JSON body（`{title, content}`），独立老 store |

这俩是历史演进留下来的：早期只有 `RagService`（内存链），后面加了正式的 `DocumentService` 支持权限过滤、parent-child chunk、异步 ingest。**它们共用 pgvector schema 但 controller 层是解耦的**。老接口保留是为了回归测试和评估脚本还在用。

我一开始按接口 URL 里的 `/rag/` 直觉走了老链，走错了。

**修复**：换成正确端点：

```bash
curl -X POST https://rag.chandlerblog.com/api/documents/upload \
  -F "file=@01-年假.md;type=text/markdown"
```

这个坑真正的教训是**要看清楚项目里有几条数据链**。上面这种情况面试如果被追问，我的口径是：「`DocumentService` 承载正式的异步 ingest 通路，`RagService` 保留了早期简易接口用于评估脚本/回归测试」——不能说成 bug，得说成有意的解耦。

## 4. 灌完但检索为空——sources 数组返 `[]`

灌 5 篇 markdown 时都是 `SUCCESS`，`GET /api/documents` 也能看到列表。然后跑问答：

```bash
curl -X POST https://rag.chandlerblog.com/api/rag/ask \
  -H "Content-Type: application/json" \
  -d '{"question": "公司请年假的流程"}'
```

返回：

```json
{
  "answer": "根据我掌握的知识，公司年假流程一般是……",
  "sources": []
}
```

sources 空！LLM 用了自己的常识胡答一通。

**根因**：还是「两条数据链」。前端 Docs 页读的是 `GET /api/documents`（新链），但 `POST /api/rag/ask` 底层用的 `RagAskService` 走的却是**新链的 pgvector store**——我灌进去的文档能被列出、能被读到，但检索时……

不对，让我再看一遍日志。原来这次是：pgvector 插入报错了，只是我没注意到日志里的：

```
ERROR: expected 4096 dimensions, not 1024
```

引出坑 5。

## 5. pgvector 维度硬编码 vs env 维度——两处独立配置

现象：pgvector 插入时报 `expected 4096 dimensions, not 1024`。

我 `.env.prod` 里明明写的 `VECTORSTORE_DIMENSION=1024`（用的 DashScope `text-embedding-v4`，1024 维）。

**根因**：pgvector 里的向量列**在建表时就把维度写死了**。我 `db/init/01_schema.sql` 里长这样：

```sql
CREATE TABLE document_chunk (
  chunk_id UUID PRIMARY KEY,
  document_id UUID NOT NULL,
  embedding vector(4096),   -- ← 这里硬编码 4096
  content TEXT,
  ...
);
```

这个 `vector(4096)` 是**数据库表结构层的强约束**。`.env.prod` 里的 `VECTORSTORE_DIMENSION=1024` 只是 Java 侧的向量长度断言，两处**是完全独立的配置**。

上线前我头脑一热选了 `Qwen3-VL-Embedding-8B`（4096 维、多模态），后来意识到演示场景纯文本 FAQ 用不到 VL 能力、还贵 10 倍，改回了 1024 维的 `text-embedding-v4`。Java 侧改完 env，SQL 里 4096 忘了改。

**修复**：

```bash
# 服务器上先 sed 改本地 SQL
sed -i 's/vector(4096)/vector(1024)/' db/init/01_schema.sql
```

改完还不够——见坑 6。

**面试口径**：这个坑在我看来其实是**部署侧深度理解的加分点**。你可以说：「embedding 维度是数据库 schema 强约束，切模型必须改两处：Java 侧 env + SQL 表结构。我在 SQL 注释里显式标注了这个联动关系防下次踩坑，因为不同层的配置容易漏改。生产上更规范应该引入 Flyway 做版本化迁移，但演示项目手动改也够。」

## 6. `docker-entrypoint-initdb.d` 只在空卷首次初始化时跑

改完 SQL，我 `dcp restart pgvector` 想让新 schema 生效。重启后跑问答，**还是报 `expected 4096 dimensions`**。

以为 sed 没生效？`cat db/init/01_schema.sql` 一看，确实改成 1024 了。进容器 `psql` 看 pgvector 表结构，`\d document_chunk`——embedding 还是 `vector(4096)`。

**根因**：pgvector 官方镜像的 `docker-entrypoint-initdb.d/*.sql` 只在 `/var/lib/postgresql/data` **为空目录时**执行一次。只要数据卷里已经存在数据库（哪怕表全空），后续任何 pull 到的 schema.sql 改动都**不会自动执行**。

这个机制其实是合理的——避免每次 restart 都把生产数据 truncate 一遍——但作为部署新手很容易踩。

**修复**：想让 schema 变更在已有卷生效，有两条路：

1. **删卷重来**（我选的路，反正 seed 是自动灌的）：
   ```bash
   dcp down -v          # -v 是关键：把 volume 也删掉
   dcp up -d            # 重新初始化，跑 initdb.d
   ```

2. **手动跑 SQL**（保留数据的话）：
   ```bash
   dcp exec pgvector psql -U rag -d rag \
     -f /docker-entrypoint-initdb.d/01_schema.sql
   ```

**面试口径**：这个坑背后其实是**数据库 schema 迁移**的最佳实践问题。生产上更规范是引入 Flyway/Liquibase 做版本化迁移，`docker-entrypoint-initdb.d` 只适合「每次部署都是全新库」的场景（比如 CI 集成测试）。演示环境规模小可以手动，未来上量必须换 migration 工具。

## 番外：改 `.env.prod` 后 `restart` 不生效

这个不算独立坑，但连着踩的。改完 `.env.prod` 想让新变量生效，本能反应是 `dcp restart app`。发现变量根本没进容器。

**根因**：`docker compose restart` **不会重读 `.env.prod`**——它只是给容器进程发 SIGTERM 让它重启。env 是在容器**创建时**注入的，`restart` 前后是同一个容器实例。

改 env 后想让变化生效，必须让 compose **recreate 容器**：

```bash
dcp up -d                        # compose 检测到 env 变化会自动 recreate
dcp up -d --force-recreate app   # 或者显式强制
```

区分：`restart` 是「进程重启，容器不变」，`up -d` 是「必要时重建容器」。

面试如果被问 Docker Compose 有哪些容易踩的坑，这个和 `${VAR:?err}` 空字符串也算 missing（`${VAR-}` 才允许空）是我最想讲的两个。

## 收尾

3.5 小时踩完这 6 个坑，最后端到端跑通了：

- `docker compose ps` 三容器全 Up
- 5 篇脱敏 markdown 通过 `POST /api/documents/upload` 灌入，异步 ingest 全 `SUCCESS`
- `POST /api/rag/ask` 返回中文答案 + sources 指向源 md + tokenUsage
- 浏览器 `https://rag.chandlerblog.com` 首页可访问，HTTPS 锁绿

回头看这 6 个坑，有 3 个（1、6、番外）都跟「Docker Compose 生命周期」有关——`healthy` 什么时候放行、`initdb` 什么时候跑、`restart` 和 `up -d` 差在哪。这块是我以前只在本地跑 compose 时完全没深挖过的地方，这次踩完算是补齐了。

另外 3 个（3、4、5）都跟「多层配置的联动」有关——两条 controller 数据链、Java 侧 env vs SQL 表结构、`.env` vs `compose.yml` 的透传。这些坑的共同点是：**每一层单独看都没错，跨层就错了**。以后写部署脚本我会多问一句「这个配置在几个地方定义？改了要不要同步改另一处？」

如果你也在把一个本地跑得挺好的项目搬上云，希望这 6 个坑能帮你省几个小时。
