---
# import-articles-sha256: 8ea43378a0fe26e4cfbc485429a48fde089aa6a42bf6fabcd08fb5a4adbe77f5
# Imported by scripts/import-articles.mjs from posts/tooling/mac-dev-machine-ops.md
# Source date: 2026-10-22
title: "Mac 开发机的日常排障：代理、磁盘、负载和后台进程"
description: "一台 Mac 同时跑多个开发窗口和代理，常见的故障看起来都像代码问题。这篇按网络、磁盘、负载、进程的顺序，记下 Node 构建 TLS 断开、SSH 卡在密钥交换、磁盘一两天就满、负载 17 的真正元凶，以及停进程、切长截图、Go 只编译时的几个假失败。"
pubDate: 2026-10-05
tags: ["macOS","代理","开发环境","Go","命令行"]
series: tooling
seriesLabel: "开发环境与工具"
---

> 一句话总结：开发机出毛病时，先问「这条连接走没走代理」「这块空间真能回收多少」「这些 CPU 和内存按应用加起来是谁」，再动手。凭感觉清缓存、关编辑器、关代理，多半清错对象。

## 0. 起因：一台机器，好几条线同时在跑

我的开发机是一台 16 GB 内存的 Apple Silicon Mac。平时同时开着好几个编辑器窗口、好几个 Claude Code 会话，各自在不同的 worktree 里编译、跑测试、起本地服务；Docker 里跑着数据库；访问外网要经过本机代理。下文的排查和清理，大多是我让其中一个 Claude Code 会话（下文叫「助手」）去做的，我看结论、决定要不要动手。

这种机器上的故障有个共同点：看起来像代码问题。构建报 TLS 断开，像依赖坏了；`git push` 卡住，像远端挂了；测试超时，像代码变慢了。查到最后，多半是代理、磁盘、内存或者某个没人管的后台进程。

下面按网络、磁盘、负载、进程的顺序讲，最后是两个小工具上的假失败。

## 1. 代理：curl 能通，Node 构建却 TLS 断开

**现象**：Next.js 生产构建卡在「Creating an optimized production build」，反复出现：

```text
Client network socket disconnected before secure TLS connection was established
Retrying 1/3...
```

同一时刻，用 curl 请求同一个字体地址，返回 200。

**根因**：构建时 `next/font/google` 会并发下载字体。本机代理跑在 fake-IP 加 TUN 模式下：DNS 返回 198.18 开头的假地址（这一段是 RFC 2544 保留给基准测试的地址，fake-IP 常用它），流量再由 TUN 虚拟网卡接管、转发。Node 的 TLS 连接走这条路径时，会间歇性地被断开（实测）。一开始怀疑是 IPv6 优先的问题，改了 DNS 顺序，没用：解析结果本来就是 IPv4 的假地址。

判断是不是这种情况，看一眼域名解析到哪：

```bash
dig +short fonts.googleapis.com
```

结果是 198.18 开头，就是本机代理接管了。

**修复**：Next 下载字体时会读 `https_proxy` 环境变量。让它显式走代理的 HTTP 端口，绕开 TUN 那条路：

```bash
scutil --proxy | grep -E 'HTTPSProxy|HTTPSPort'
```

```bash
https_proxy=http://127.0.0.1:<端口> http_proxy=http://127.0.0.1:<端口> no_proxy=127.0.0.1,localhost npx next build
```

`no_proxy` 不能漏。构建时如果要请求本地后端（比如预渲染时拉一份本地数据），不排除本地地址，请求会被转发到代理，然后失败。

同一个根源还有另一种表现：抓某个文档站，curl 报 `Could not resolve host`，Node 的工具报 `getaddrinfo ENOTFOUND`。换一个公共 DNS 服务器直接问（`dig +short @<公共 DNS 地址> <域名>`），能解析出来，说明网站没挂，是系统解析路径被代理接管后对这个域名失败了。这时让代理自己去解析：

```bash
curl -sS -L --proxy http://127.0.0.1:<端口> https://example.com/docs/page
```

反过来也要注意：Python 的 `urllib` 在 macOS 上会自动读取系统代理设置（文档：`urllib.request.getproxies()` 的说明）。本地起一个 mock 服务做测试时，请求可能被悄悄送进代理。测本地服务时，显式设 `no_proxy=127.0.0.1,localhost`，或者给 opener 传一个空的 `ProxyHandler({})`。

## 2. SSH：TCP 通了，卡在密钥交换

**现象**：用 SSH 协议 `git push`，一直卡住不动。浏览器、npm 这些走代理的都正常。

先看卡在哪个阶段：

```bash
ssh -vT git@github.com
```

TCP 连接建立了，服务端的 banner 也收到了，输出停在密钥交换那几行（`SSH2_MSG_KEX` 开头），之后再没有回包。

**根因**：`~/.ssh/config` 里有一行不分主机的 `ProxyCommand`，让所有 SSH 连接都经本机的 SOCKS5 代理转发，而这个代理处理不好 SSH 密钥交换的流量（实测）。

**修复**：先备份原文件，再删掉这行，或者把它限定到真正需要的主机上：

```sshconfig
Host some-host-behind-proxy
  ProxyCommand nc -X 5 -x 127.0.0.1:<端口> %h %p
```

删掉之后，`ssh -T git@github.com` 马上就有返回。系统代理不用关。代理只影响它声明的那条路径，排查时该问的是「这条连接有没有走代理、走的是哪个」，而不是「要不要把代理关掉」。

## 3. 磁盘一两天就满：先清真能回收的

多个窗口并行开发时，这台机器的磁盘一两天就能写满。大头都是可以再生的东西，但不同东西「真能释放多少」「删了会不会弄断正在跑的进程」差别很大。助手按下面的顺序清（数字都是实测）：

| 对象 | 实测情况 | 怎么清 |
|---|---|---|
| Docker 匿名卷 | 用 `--rm` 起的临时数据库容器每次留下一个，一天多攒了 115 个、17.6 GB | 先确认里面没有命名卷，再 `docker volume prune` |
| Go 编译缓存 | 并行编多个分支，一天长到 16 GB，修剪后约 6 小时又到 20 GB | 按 mtime 删 3 小时以上没用过的 |
| `.next` 构建产物 | 每个检出一份，是真占用 | 先停同目录的 dev server 再删 |
| Jest 缓存 | 在系统临时目录里，每个检出路径各一套，攒到 3.75 GB | 删一天以上没动过的文件 |
| 包管理器缓存 | npm、pip、Homebrew 各一份 | 用各自的清理命令 |

几条要单独说的：

- **Docker 虚拟盘看实占**。`Docker.raw` 是稀疏文件，`ls -l` 显示的是上限（两百多 GB），prune 之后也不变，要用 `du -sh` 看实占。prune 之后几十秒，实占从 17.7 GB 缩到 7.5 GB；
- **Go 缓存为什么可以按 mtime 删**。Go 自带的修剪每天一次，只删 5 天没用过的条目，所以并行编译时会涨得很快。Go 读到一条缓存时，如果它的 mtime 超过 1 小时就刷新一次（文档：Go 标准库缓存实现里的 `mtimeInterval`）。所以「3 小时以上没被读过」的条目，正在编译的进程不会用到。实测 16 GB 删到 7.5 GB，并行跑着的测试没受影响。`go clean -cache` 是全删，会拖慢别的窗口，还有读到一半被删的风险；
- **pnpm 的 node_modules 量不准**。每个检出 `du` 出来约 0.8 GB，但 pnpm 在 APFS 上默认先用写时复制克隆，`du` 看不出它和全局仓库共用磁盘块。删它们大概省不出多少（推断，没有实测）；
- **缓存里可能正跑着程序**。npx 起的命令行工具就从 `~/.npm/_npx/` 里运行，当时正好有一个文档校验在那里跑着，删了就把它弄断。删之前用 `pgrep -fl '/.npm/_npx/'` 看一眼；
- **按内容认缓存，不按名字**。按目录名找 `go-cache`，误中了一个同名的第三方库源码。先看目录里是不是缓存的格式（两位十六进制分桶、`cache/download` 这类结构）再删。Go 模块缓存是只读的，删之前要 `chmod -R u+w`；
- **每一步前后各打一次 `df`**。别的窗口同时在编译、装浏览器，几分钟内剩余空间从 18 GB 掉到 11 GB。不打 `df`，就不知道这一步到底回收了多少。

```bash
docker system df
docker volume ls -f dangling=true
docker volume prune -f

C="$(go env GOCACHE)"
find "${C}" -type f -mmin +180 -exec stat -f %z {} + | awk '{s+=$1} END {printf "%.1f GB\n", s/2^30}'
find "${C}" -type f -mmin +180 ! -name trim.txt ! -name README -delete

T="$(getconf DARWIN_USER_TEMP_DIR)jest_dx"
find "${T}" -type f -mmin +1440 -delete

npm cache clean --force
pip3 cache purge
brew cleanup --prune=all -s
```

Claude Code 会话在系统临时目录下也有按会话分的沙箱目录，可能有几个 GB。动之前先看对应会话的记录文件最后写入的时间，会话还在活动就不碰。另外，自动模式下让 Claude 批量 `rm -rf` 会被拦；工具自带的清理命令这次都放行了，删目录的部分由助手写成脚本，交给我自己跑。

## 4. 负载 17：先按应用汇总，不要凭感觉

**现象**：某天晚上机器卡得厉害，我第一反应是编辑器窗口开太多了，让助手看看是不是这个原因。它先量了一下：10 核的机器，1 分钟负载 17.9；交换区用了 12.0 GB，上限 13.3 GB，快满了。

### 汇总的口径

- CPU：`ps` 的 %CPU 按应用归组后求和；
- 内存：用 `top` 的 MEM 列。它把被压缩的部分也算进去了；RSS 不算被压缩、被换出的内存，会严重低估。实测同一个浏览器，RSS 合计 1.1 GB，MEM 合计 6.7 GB；Docker 虚拟机 RSS 0.3 GB，MEM 8.2 GB；
- 各进程的 MEM 加起来会超过物理内存，因为有压缩和换出，只看相对大小；
- 「已用 15 GB」这类数字说明不了问题，macOS 本来就会把空闲内存拿去做缓存。看交换区用量和内存压力。

```bash
top -l 1 -o mem -n 20 -stats pid,ppid,mem,cpu,command
sysctl vm.swapusage
memory_pressure
```

按应用一加，编辑器只占 CPU 的 8%。真正的元凶是两样东西。

### 元凶一：没人管的浏览器实例

两个 Chromium 内核的浏览器实例，是某个桌面客户端拉起来的，已经空转了 22 到 23 天，CPU 分别占 551% 和 208%，合计约 7.6 个核。

认出这种「孤儿」实例，助手看了四个信号：

1. 主进程的父进程是 1（launchd），而客户端主程序的启动时间比它晚，说明客户端重启过，旧实例没人管了；
2. 有几个 helper 进程各占满一个核，常驻内存却只有几 MB；
3. 用 `lsof` 找到它实际监听的调试端口，请求 `/json/list` 没有返回 JSON。正常的实例会列出自己的标签页；
4. 发 SIGTERM，等了 15 秒没反应。

```bash
ps -o pid,ppid,etime,comm -p "${PID}"
lsof -nP -a -p "${PID}" -iTCP -sTCP:LISTEN
curl -s --noproxy '*' -m 3 "http://127.0.0.1:${PORT}/json/list" | head
```

对两个主进程 `kill -9` 以后，29 个子进程在 1 秒内全部退出。客户端当前还管着的那个实例（父进程是客户端，调试端口能列出标签页）没有动。

### 元凶二：Docker Desktop 的虚拟机

容器只用了约 0.4 GB 内存，Docker 的虚拟机却占着 8 GB 以上不放。

- Docker Desktop 的设置文件里，内存的键名是 `MemoryMiB`。文件里没有这个键就用默认值，`docker info` 里的 MemTotal 约为本机内存的一半（实测，Docker Desktop 4.x）；
- 虚拟机用过的内存不会还给宿主机，和容器现在用多少无关；
- 改内存必须重启虚拟机，所有容器都会停。重启策略是 `no` 的容器不会自己回来，要手动 `docker start`。

设成 4096 以后，重启后 MemTotal 是 3916 MiB，虚拟机占用从 8.2 GB 降到 2.5 GB。

改之前助手先做了一件事：给依赖 Docker 的服务记一份对照，跑一遍健康检查。结果有一个本地的 Go 服务，动手之前 `/healthz` 就已经返回 503。原因是它连接池里放了两天的空闲连接，早已被 MySQL 断开，第一次 ping 正好撞上；再请求一次就是 200。不先测这一下，就会把这个旧问题算到这次重启头上。Docker 重启之后，同样的情况又出现了一次，有了对照就知道是同一回事。

在 Claude Code 的自动模式下，停容器、`docker desktop stop` 都被拒了。我让它把整个顺序写成脚本，自己执行：

1. 记对照：健康检查结果、数据库端口能不能握手；
2. `docker stop -t 60 <容器>`，给数据库留时间正常落盘；
3. `docker desktop stop`，改设置文件里的 `MemoryMiB`；
4. `docker desktop start`，轮询 `docker info` 直到可用，核对 MemTotal；
5. `docker start <容器>`，等端口能握手；
6. 再跑一遍对照，和第 1 步比。

### 结果

| 时点 | 1 分钟负载 | 交换区已用 | CPU 空闲 |
|---|---|---|---|
| 处理前 | 17.9 | 12.0 GB | 约 0% |
| 杀掉两个浏览器实例后 | 14.3 | 7.8 GB | 86% |
| 调小 Docker 内存后 | 2.8 | 4.6 GB | 84% |

负载平均值是平滑过的，杀掉元凶以后要过几分钟才降下来。当场判断效果，看 `top -l 2 -s 3` 第二次采样的 CPU 空闲。第二天再看：负载 2.1，空闲 89%，内存压力 1 级，10 秒内没有换入页面。

### 编辑器关了，后台进程还在

处理完这两样，内存里还剩 11 个 Cursor 的后台进程。它们来自三周内的三次启动，父进程都已经是 1，而 Cursor 主程序早就没在运行了。这些进程在 `ps` 里的 RSS 是 0，全被换出去了；在 `top` 的 MEM 里每个约 100 MB，合计约 0.6 GB。发 SIGTERM 后 7 个退出，剩下 4 个要 `kill -9`。

按名字筛的时候要排除 `CursorUIViewService`。它是 macOS 输入法的系统服务，名字里带 Cursor 只是巧合。

那天最后还剩一个症状：鼠标拖影。系统这边已经排除了（GPU 占用 0 到 2%，WindowServer 6 到 8%），怀疑是插在 USB 3 扩展坞上的无线接收器受了干扰（推断），还没验证。

## 5. 停后台进程的两个坑

### pkill -f 杀掉了自己所在的 shell

一条组合命令执行到 `pkill -f 'next build'` 就中断，返回码 137，后面的步骤全没执行。`-f` 匹配的是完整命令行，而包着这条命令的 shell，命令行里恰好就有 `next build` 这段文字，于是它把自己也杀了。

```bash
nohup some-server > server.log 2>&1 & echo $! > server.pid
kill "$(cat server.pid)"

kill $(lsof -nP -tiTCP:3000 -sTCP:LISTEN)

pkill -f '[n]ext build'
```

按 PID 文件或监听端口停最稳。非要用模式时，写成 `'[n]ext build'`：正则照样能匹配 `next build`，而 shell 命令行里出现的是 `[n]ext build` 这串字面文字，匹配不上自己。

### Python 起的子进程退出后是僵尸

有个本地起服务的编排脚本，用 `subprocess.Popen(..., start_new_session=True)` 起服务，用 PID 文件管理。第一次重启服务正常；同一个 Python 进程里第二次重启，「停旧进程」这一步卡满超时，然后在 `os.killpg(pid, SIGKILL)` 这行抛出：

```text
PermissionError: [Errno 1] Operation not permitted
```

**根因**：子进程收到 SIGTERM 正常退出了，但父进程没有 `wait`，它就停在僵尸态。僵尸仍占着 pid，`os.kill(pid, 0)` 照样成功，「每隔一会儿看它还活着没」的循环于是跑满超时。超时后对这个进程组发 SIGKILL，组里只剩僵尸，macOS 返回 EPERM（实测；Linux 上通常不会这样）。

**修复**：判断存活之前，先试着回收：

```python
import os

def alive(pid: int) -> bool:
    try:
        done, _ = os.waitpid(pid, os.WNOHANG)
        if done == pid:
            return False
    except ChildProcessError:
        pass
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
```

是自己的子进程，`waitpid` 顺手回收，回收到了就是已退出；不是自己的子进程，会抛 `ChildProcessError`，再交给 `kill(pid, 0)`。`killpg` 那一行，用 `try` 包住 `PermissionError` 和 `ProcessLookupError`。手上有 `Popen` 对象时，直接 `p.terminate()` 再 `p.wait(timeout)` 更简单；只有跨多次运行、靠 PID 文件管理进程时，才需要这一套。

## 6. 超长截图：先切块，再给模型读

整页长截图（比如 4402×28800）直接给模型读，会被整体缩到长边 2000 像素左右，正文字高只剩几个像素。要先按正文列宽切成若干块，让每块的缩放比例接近 1。实测 1750×2400 的块显示为 1458×2000，缩到 0.83，中文正文仍然清楚。

macOS 自带的 `sips` 就能切，但有两个坑：参数是先高后宽，`-c 高 宽`、`--cropOffset Y X`；`--cropOffset 0 0` 会被当成「没给偏移」，裁出来的是图片正中间（实测，用 md5 对比过，和不带偏移的居中裁剪逐字节相同）。只要有一个值不为 0 就正常，差 1 像素对读图没有影响。

```bash
IN=long.png
OUT=./slices
mkdir -p "${OUT}"
sips -g pixelWidth -g pixelHeight "${IN}"

X=1330
W=1750
H=2400
TOTAL=28800
for i in $(seq 0 $(( (TOTAL + H - 1) / H - 1 ))); do
  Y=$(( i * H ))
  [ "${Y}" -eq 0 ] && [ "${X}" -eq 0 ] && Y=1
  sips -c "${H}" "${W}" --cropOffset "${Y}" "${X}" "${IN}" --out "${OUT}/c$(printf %02d "${i}").png" >/dev/null
done
```

`X` 取正文列的左边界，可以先用 `sips -Z 1800` 出一张缩略图，按比例换算出来。只裁正文列、不带侧栏和留白，同样的显示尺寸下字会大一倍以上。在 zsh 里别把两个偏移写进一个变量（`off="0 0"`），它不分词，sips 收到的是一个参数。

## 7. Go 只想验编译：两种还没开始编就失败的报错

改了一个依赖库，只想确认下游还能编过，`go build` 会给出两种看起来像编译失败、其实还没开始编的报错。

第一种：

```text
go: build output "cmd" already exists and is a directory
```

`go build` 只带一个 main 包参数时，会在当前目录输出一个二进制，名字取包目录的最后一段。仓库里 `cmd/` 本身就是 main 包时，`go build ./cmd` 要写出的文件 `cmd` 正好撞上同名目录。只验编译就加 `-o /dev/null`，不撞名也不留产物。在 Go 1.27 上实测，`go build -o /dev/null ./...` 对多个包也能用。

第二种：main 包用 `//go:embed web/dist` 嵌了前端产物，而这个工作区没构建过前端：

```text
pattern web/dist: no matching files found
```

放一个 `.gitkeep` 不行，embed 默认跳过 `.` 和 `_` 开头的文件，报错会换成 `cannot embed directory web/dist: contains no embeddable files`（实测）。要放一个普通文件：

```bash
mkdir -p web/dist
echo '<!-- local build placeholder -->' > web/dist/index.html
go build -o /dev/null ./...
```

这个目录本来就在 `.gitignore` 里，占位文件不会被误提交。真要跑这个二进制时别用占位，先把前端构建出来。

## 收尾

1. **先问走没走代理** —— curl 能通、Node 断开，看解析地址是不是 198.18 开头；SSH 卡住，看配置里有没有全局的 `ProxyCommand`。
2. **按真能回收的排顺序** —— Docker 匿名卷和 Go 缓存是大头，`du` 量出来的 node_modules 可能是虚的，每步前后打 `df`。
3. **内存看 MEM 不看 RSS，按应用汇总** —— 这次的元凶是空转三周的孤儿浏览器和不还内存的 Docker 虚拟机，不是编辑器。
4. **动手前先记对照** —— 不然改之前就坏着的东西，会被算到这次改动头上。
5. **停进程按 PID，判断存活前先回收** —— `pkill -f` 会杀到自己，僵尸进程会让 `kill(pid, 0)` 说谎。

这些事单拎出来都不难，难在它们伪装成别的问题。现在机器一不对劲，我先跑三条命令：`scutil --proxy` 看代理，`df -h` 看磁盘，`top -l 1 -o mem` 看谁占着资源，再决定往哪个方向查。命令行本身的坑，见 [zsh 和 bash 3.2 的七个展开坑](/blog/tooling/zsh-expansion-gotchas/)；这台机器是怎么从零搭起来的，见[从零搭一台开发机](/blog/tooling/dev-env-from-zero/)。
