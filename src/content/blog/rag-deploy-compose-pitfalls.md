---
title: "把 RAG 项目部署上云的那天，我踩了五个坑"
description: "Spring Boot + pgvector + Vue3 第一次用 Docker Compose 上云踩的五个坑：首启连库失败、子命令不读 .env.prod、上传链路走混、向量维度写死在建表 SQL、initdb 只在空卷时跑。"
pubDate: 2026-07-29
tags: ["Docker", "Docker Compose", "pgvector", "PostgreSQL", "部署", "RAG"]
series: "rag"
seriesLabel: "RAG 项目"
---

> 一句话总结：这个 RAG 项目本地跑了几个月都很稳，为了面试演示要把它部署到阿里云 ECS 上。我给自己估的时间是「一下午」——毕竟 Dockerfile 都写好了、`docker-compose.prod.yml` 也 review 了好几遍。实际花了 **3.5 小时**，踩了 **5 个坑**。这篇把每个坑的现象、根因、修复原样记下来，尤其想强调其中几个「本地写 compose 时根本想不到会翻车」的点。

## 0. 起因

项目是一个基于 Spring Boot + pgvector 的 RAG 系统，本地开发时是这样跑的：

- Spring Boot 直接在 IDEA 里启动
- 前端 `npm run dev` 跑 Vite dev server
- pgvector 用 `docker-compose.pgvector.yml` 起一个单独的容器

现在要上云，改成 3 容器同时起：

```text
pgvector（PostgreSQL 15 + pgvector 扩展）
  ↓
app（Spring Boot jar，maven → jre 两阶段构建）
  ↓
web（Vue 打包 + Nginx，反代 /api → app:19090）
```

我提前一天把 `docker-compose.prod.yml` / 后端 `Dockerfile` / 前端 `Dockerfile` / `nginx.conf` / `.env.prod.example` 都写好了，看着挺完整的。真到服务器上一跑——每一个都出问题。

## 1. 首次 `docker compose up`：pgvector 还在初始化，app 已经连上去崩了

现象：

```bash
docker compose -f docker-compose.prod.yml up -d
```

跑完立刻 `docker compose ps`，看到：

```text
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

意思是「等 pgvector healthy 了再起 app」。

更正：我当时写的解释是「`service_healthy` 有超时，等不到 healthy 就放行 app」，这不对。Compose 会一直等依赖变成 healthy；依赖被判 unhealthy 时，Compose 报错（`dependency failed to start`），不启动 app。另外，postgres 官方镜像本身不带 HEALTHCHECK，`pg_isready` 这条检查是我自己在 compose 里写的。

更可能的原因（推测，当时日志没留全）：postgres 镜像首次启动时，会先起一个临时实例跑 `docker-entrypoint-initdb.d/*.sql`。官方文档写明，这个临时实例只监听 Unix socket。`pg_isready` 不带 `-h` 时走的正是 Unix socket，于是在初始化阶段就报 ready，容器被判 healthy，app 跟着启动。app 走 TCP 去连，这时 TCP 端口还没开，或者临时实例刚好在关、正式实例还没起来，就是 `Connection refused`。上面 `ps` 里 pgvector 显示的 `health: starting` 和这个推测也对不全，具体是哪种，待我核对。

当时实际的处理是**再跑一遍 `docker compose up -d`**：第二次数据卷里已经有库，不再走初始化，几秒钟就 healthy，app 一次起来。

**修复**：可复用的写法是三处一起改：

1. healthcheck 用 `pg_isready -h localhost`，强制走 TCP，初始化阶段的临时实例不会让它提前报 ready；
2. 加 `start_period`，给首次初始化留时间，这段时间里检查失败不计入 `retries`；
3. app 自己也要能重试连接：最省事的是 `restart: on-failure`，或者给连接池配启动等待（比如 HikariCP 的 `initializationFailTimeout`）。

```yaml
services:
  pgvector:
    image: pgvector/pgvector:pg15
    healthcheck:
      # 走 TCP，避开初始化阶段只听 socket 的临时实例
      test: ["CMD-SHELL", "pg_isready -h localhost -U $${POSTGRES_USER} -d $${POSTGRES_DB}"]
      interval: 5s
      timeout: 3s
      retries: 10
      start_period: 60s   # ← 首次 initdb 留足时间
  app:
    depends_on:
      pgvector:
        condition: service_healthy
    restart: on-failure   # ← 万一还是连早了，崩了自己再起
```

`$$` 是 compose 文件里对 `$` 的转义，让变量在容器里展开。

## 2. `docker compose ps` 报 `PG_PASSWORD is missing`——只有 `up` 带了 `--env-file`

第二个坑发生在几分钟后。我想看看容器状态：

```bash
docker compose -f docker-compose.prod.yml ps
```

结果直接报错：

```text
required variable PG_PASSWORD is missing a value: err
```

明明 `up -d` 时是能起来的啊？我 `.env.prod` 就在旁边。

**根因**：我在 `docker-compose.prod.yml` 里对敏感变量用了强校验语法：

```yaml
pgvector:
  environment:
    POSTGRES_PASSWORD: ${PG_PASSWORD:?PG_PASSWORD is required}
```

这个语法要求变量必须有值，否则报错。我当时以为 `docker compose` 只有 `up` 读 env 文件，这不对。Compose 文档的说法是：没给 `--env-file` 时，它在项目目录找 `.env`（项目目录默认是第一个 `-f` 文件所在的目录），`up`、`ps`、`logs`、`down`、`exec` 都一样。**它只认 `.env` 这个名字，不会自动读 `.env.prod`。**

我的变量写在 `.env.prod`。`up` 那次能起来，是因为带了 `--env-file .env.prod`；`ps` 没带，Compose 去找 `.env`，没找到，`PG_PASSWORD` 就没有值。所以只要文件不叫 `.env`，每条子命令都得带上：

```bash
docker compose -f docker-compose.prod.yml --env-file .env.prod ps
```

顺带一点：这类 env 文件里的变量只用来替换 compose 文件里的 `${...}`，不会自动进容器。要进容器，得在服务的 `environment` 里列出来，或者用 `env_file` 指定。

**修复**：在服务器 `~/.bashrc` 里加了个 alias（另一个办法是把文件直接命名成 `.env`，放在 compose 文件旁边）：

```bash
alias dcp='docker compose -f /opt/rag/docker-compose.prod.yml --env-file /opt/rag/.env.prod'
```

以后所有命令都用 `dcp` 前缀。教训是：env 文件不叫 `.env` 时，每条 compose 命令都要带 `--env-file`；用了 `${VAR:?...}` 强校验，漏带会直接报错，反倒容易发现。

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

这个坑真正的教训是**要看清楚项目里有几条数据链**。怎么判断：调接口前先按 URL 找到 controller，再看它调的 service 写到哪个 store；同一类资源有两个入口时，查清楚前端和脚本各用哪一个，别按 URL 里的词猜。

## 4. 灌完但检索为空：pgvector 的维度写死在建表 SQL 里

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

翻 app 日志才发现，向量写进 pgvector 时报错了，只是 ingest 状态没反映出来：

```text
ERROR: expected 4096 dimensions, not 1024
```

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

这个 `vector(4096)` 是**数据库表结构层的强约束**。（4096 维本身也建不了 HNSW 索引，见 [pgvector 篇的更正](/blog/rag-pgvector-migration/)。）`.env.prod` 里的 `VECTORSTORE_DIMENSION=1024` 只是 Java 侧的向量长度断言，两处**是完全独立的配置**。

上线前我头脑一热选了 `Qwen3-VL-Embedding-8B`（4096 维、多模态），后来意识到演示场景纯文本 FAQ 用不到 VL 能力、还贵 10 倍，改回了 1024 维的 `text-embedding-v4`。Java 侧改完 env，SQL 里 4096 忘了改。

**修复**：

```bash
# 服务器上先 sed 改本地 SQL
sed -i 's/vector(4096)/vector(1024)/' db/init/01_schema.sql
```

改完还不够——见坑 5。

**怎么判断**：换 Embedding 模型前，先列出维度出现在哪几处。我这里是两处：Java 侧的 env 和 SQL 建表语句。我在 SQL 注释里标了这个联动关系。更规范的做法是用 Flyway 这类工具做版本化迁移，改维度就是一条迁移脚本。

## 5. `docker-entrypoint-initdb.d` 只在空卷首次初始化时跑

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

**怎么判断**：改了 `initdb.d` 里的 SQL，先问一句「数据卷里已经有库了吗」。有库就不会重跑，要么删卷，要么手动执行。`initdb.d` 适合每次都是全新库的场景（比如 CI 集成测试）；库要长期保留时，用 Flyway、Liquibase 这类迁移工具管 schema 变更。

## 番外：改 `.env.prod` 后 `restart` 不生效

这个不算独立坑，但连着踩的。改完 `.env.prod` 想让新变量生效，本能反应是 `dcp restart app`。发现变量根本没进容器。

**根因**：`docker compose restart` **不会重读 `.env.prod`**——它只是给容器进程发 SIGTERM 让它重启。env 是在容器**创建时**注入的，`restart` 前后是同一个容器实例。

改 env 后想让变化生效，必须让 compose **recreate 容器**：

```bash
dcp up -d                        # compose 检测到 env 变化会自动 recreate
dcp up -d --force-recreate app   # 或者显式强制
```

区分：`restart` 是「进程重启，容器不变」，`up -d` 是「必要时重建容器」。

**怎么判断**：改了 env 之后，进容器 `printenv` 看一眼新值到了没有。这个坑后来[做演示加固](/blog/rag-demo-hardening/)时又碰到两次，都是同一个原因。

同类的还有一个：`${VAR:?err}` 把空字符串也当成缺失，想允许空值要用不带冒号的写法，比如 `${VAR-}`。

## 收尾

3.5 小时踩完这 5 个坑，最后端到端跑通了：

- `docker compose ps` 三容器全 Up
- 5 篇脱敏 markdown 通过 `POST /api/documents/upload` 灌入，异步 ingest 全 `SUCCESS`
- `POST /api/rag/ask` 返回中文答案 + sources 指向源 md + tokenUsage
- 浏览器 `https://rag.chandlerblog.com` 首页可访问，HTTPS 锁绿

回头看这 5 个坑，有 3 个（1、5、番外）都跟「Docker Compose 生命周期」有关——`healthy` 什么时候放行、`initdb` 什么时候跑、`restart` 和 `up -d` 差在哪。这块是我以前只在本地跑 compose 时完全没深挖过的地方，这次踩完算是补齐了。

另外 3 个（2、3、4）都跟「多层配置的联动」有关——两条 controller 数据链、Java 侧 env vs SQL 表结构、`.env` vs `compose.yml` 的透传。这些坑的共同点是：**每一层单独看都没错，跨层就错了**。以后写部署脚本我会多问一句「这个配置在几个地方定义？改了要不要同步改另一处？」

如果你也在把一个本地跑得挺好的项目搬上云，希望这 5 个坑能帮你省几个小时。
