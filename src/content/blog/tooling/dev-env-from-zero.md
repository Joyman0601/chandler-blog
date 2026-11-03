---
# import-articles-sha256: bfb0961f37baf477a54ac7124289d5a9056866985128e373a2c9017b175e5b1f
# Imported by scripts/import-articles.mjs from posts/tooling/dev-env-from-zero.md
# Source date: 2026-09-21
title: "从零搭一台开发机：顺手写了个会话检索工具"
description: "从 Windows 换到 Apple Silicon Mac 的第一天，绕开不通的 GitHub 和 Homebrew 装好工具链，又写了一个检索 Claude Code 历史会话的小工具。讲安装顺序和几处坑，以及这个工具的设计和后来发现的局限。"
pubDate: 2026-08-03
tags: ["开发环境","macOS","Go","Claude Code","命令行"]
series: tooling
seriesLabel: "开发环境与工具"
---

> 一句话总结：新机器先盘点再装，网络不通就绕路，别和 Homebrew 死磕；PATH 写进哪个启动文件、Docker 怎么拉镜像、数据库容器怎么接到宿主机命令，这几处第一天就定好。会话记录是一堆按目录存放的 JSONL，写一个流式扫描的小工具就能全文检索，但时区、目录名编码、迁移后的旧数据这几个边界要早点想到。

## 0. 起因：换机器当天下午就要干活

我从 Windows 换到了一台 Apple Silicon 的 Mac。当天下午就要接一个前端任务，留给搭环境的时间大约四个小时。我让 Claude Code（下文叫「助手」）动手，自己盯着每一步。

约束有三条：那天 GitHub 完全连不上；我不想给每个安装都输 sudo；装的东西都要是 arm64 原生的，不靠 Rosetta 转译。

最后新装了 6 样东西，全程没有 sudo，也没装 Homebrew。剩下的时间，我让助手写了一个检索 Claude Code 历史会话的小工具。之后一个多月，翻旧会话找原话都靠它；它的设计和用下来暴露的局限，放在后半篇讲。

## 1. 先盘点，再安装

我给助手的第一句话是：先检查本地有没有，然后再安装。新 Mac 上其实已经有不少东西了：

```bash
for c in node npm pnpm bun git go docker ffmpeg; do
  printf '%-8s %s\n' "${c}" "$(command -v "${c}" || echo 未安装)"
done
uname -m
```

那台机器上已经有 Node 24、npm 11、Bun 1.2，还有苹果自带的 Git 2.50。真正要装的是 pnpm、VS Code、Cursor、Docker Desktop、Chrome、Postman，后来又补了 Go、MySQL、Redis、FFmpeg。先盘点的好处是不重复装、不装出两份版本打架，也能顺便确认 `uname -m` 是 `arm64`，后面挑安装包时心里有数。

pnpm 走 Node 自带的 corepack 装，不需要 sudo。

## 2. GitHub 不通：绕开 Homebrew，直接装厂商的包

**现象**：Homebrew 的官方安装脚本要从 GitHub 拉，一直超时：

```text
curl: (56) Recv failure: Operation timed out
```

**做法**：不和网络死磕，改从各厂商的官网下载 arm64 安装包。关键是 `/Applications` 的权限：

```bash
ls -ld /Applications
id -Gn | tr ' ' '\n' | grep -x admin
```

`/Applications` 属于 `root:admin`，组可写；当前账号在 `admin` 组里，往里装应用不需要 sudo（实测）。dmg 包挂载以后用 `ditto` 拷进去：

```bash
hdiutil attach -nobrowse -mountpoint /Volumes/pkg Some.dmg
ditto /Volumes/pkg/Some.app /Applications/Some.app
hdiutil detach /Volumes/pkg
codesign --verify --deep --strict /Applications/Some.app && echo "签名完好"
lipo -archs /Applications/Some.app/Contents/MacOS/Some
```

用 `ditto` 而不是 `cp -R`，是因为它会保留应用包里的符号链接和扩展属性（文档：`man ditto`）。用命令行下载的文件不带浏览器打的隔离属性，Gatekeeper 不会弹窗，可它也就不替你检查了，所以签名和架构要自己验一遍。

命令行工具也照这个思路装：

- **Go**：下载官方的 tarball，先拿官网公布的 SHA256 核对，再解压到 `~/.local/go`。模块代理设成国内可访问的镜像（`go env -w GOPROXY=<镜像地址>,direct`），不然第一次 `go mod download` 又会卡住；
- **FFmpeg**：第一次下的构建是 x86_64 的，要靠 Rosetta 才能跑，`lipo -archs` 一看就露馅了，换成 arm64 的构建。助手校验时也走过一次弯路：`.sha256` 文件里写的是「哈希值加文件名」，拿整个文件内容和算出来的哈希比，永远不相等。直接用 `shasum -a 256 -c ffmpeg.zip.sha256` 校验就好。

## 3. PATH 写在哪个启动文件里

Docker Desktop 装好以后，助手发现它做的是用户级安装：这台机器上没有 `/usr/local/bin`，它就把命令行工具放进了 `~/.docker/bin`，再往 `~/.zprofile` 里追加了一行 PATH。

这里有个容易忽略的点：zsh 不同的启动方式，读的启动文件不一样（文档：zsh 手册的 STARTUP/SHUTDOWN FILES 一节）。

- 登录 shell 读 `.zprofile`，交互 shell 读 `.zshrc`；
- `zsh -l -c '…'` 是登录、非交互，读 `.zprofile`，不读 `.zshrc`；
- `zsh -i -c '…'` 是交互、非登录，读 `.zshrc`，不读 `.zprofile`；
- 终端窗口默认既是登录又是交互，两个都读，所以在终端里永远看不出问题。

编辑器、脚本、AI 工具起的 shell 不一定是哪种。装完一个往 PATH 里加东西的工具，我会分别验一下：

```bash
zsh -lc 'command -v docker'
zsh -ic 'command -v docker'
```

我的约定是：PATH 写在 `.zprofile`，别名和提示符写在 `.zshrc`。用户级的可执行文件统一放 `~/.local/bin`，这是 XDG 目录规范里给用户级程序留的位置，VS Code 和 Cursor 的命令行入口 `code`、`cursor` 也软链到这里。项目目录在家目录下分成 `Projects/{work,personal,playground}` 三块，`.zshrc` 里给每块配一个跳转别名。

## 4. Docker 拉不到镜像，数据库容器接到宿主机命令

**现象**：`docker pull` 报 EOF，镜像拉不下来。

**根因**：当时本机代理只开了 TUN 模式，没有提供 HTTP 端口给 Docker 用，Docker 虚拟机里的流量没被代理覆盖（这是当时的判断，没有进一步验证）。

**做法**：在 Docker Desktop 的 Docker Engine 设置里配镜像加速，配置存在 `~/.docker/daemon.json`：

```json
{
  "registry-mirrors": ["https://<镜像加速地址>"]
}
```

镜像加速是第三方的中转，拉下来的镜像要信得过它。有可用的代理时，优先给 Docker 配代理。

MySQL 和 Redis 都放容器里跑，用命名卷存数据，重启策略设成 `unless-stopped`，开机后自己起来：

```bash
docker volume create mysql-data
docker run -d --name local-mysql --restart unless-stopped \
  -p 127.0.0.1:3306:3306 -v mysql-data:/var/lib/mysql \
  -e MYSQL_ROOT_PASSWORD="${MYSQL_ROOT_PASSWORD}" mysql:8
```

命名卷在容器删掉以后还在；端口只绑 `127.0.0.1`，不暴露给局域网。宿主机上没装 MySQL 客户端，助手写了个同名的小包装，转进容器里执行：

```sh
#!/bin/sh
if [ -t 0 ]; then
  exec docker exec -it local-mysql mysql "$@"
else
  exec docker exec -i local-mysql mysql "$@"
fi
```

分两种情况，是因为 `docker exec` 的两个参数各有一个坑（文档：`docker exec` 的参数说明）：不加 `-i`，标准输入不会转进容器，`mysql < dump.sql` 什么都收不到；加了 `-t` 而当前又没有终端（比如在管道里），会报 `the input device is not a TTY`。用 `[ -t 0 ]` 判断标准输入是不是终端，两种用法都能走通。

## 5. Claude Code：分类器不可用时的鸡生蛋

搭到一半，Claude Code 的 Bash 和 Write 时不时被拦，提示自动模式的安全分类器不可用。

自动模式要靠一个分类器模型判断每次工具调用安不安全。我当时配的是一个第三方的 API 端点（base URL），它不提供这个分类器模型，于是分类器一直失败（这是助手当时的判断）。麻烦在于：想改配置，写配置文件这个动作本身也要过分类器。最后是我手动编辑 settings 文件、退出，再用 `claude --continue` 接着刚才的对话。

顺手做了两件事：

- 助手提醒 settings 文件里的 token 是明文的，建议换一个新的，改用环境变量或者 `apiKeyHelper` 这类设置去取；
- 给 settings 加了 42 条只读和构建类命令的白名单，减少权限弹窗。

## 6. 为什么自己写一个会话检索工具

环境搭得差不多的时候，我问助手：「我想要对此电脑上所有的对话内容进行管理，必要时能快速检索，我该怎么做？有没有相对应的 skill？」

助手当时的判断是：Claude Code 自带的 `/resume`、`claude --continue` 和双击 Esc，能按项目和时间找回某个会话，但不能跨项目做全文检索。会话记录本身就在本地：

```text
~/.claude/projects/<编码后的启动目录>/<会话 id>.jsonl
```

每个会话一个 JSONL 文件，每行一条记录，带时间戳、角色、正文、当时的工作目录。

助手列了三个方案：A 是一个命令行工具加一个 skill，让 Claude 自己也能调；B 是建 SQLite 的 FTS5 全文索引；C 只做归档。我选了 A，数据量大到扫描变慢时再升级成 B。

有个小插曲：写代码的时候 Bash 正被拦着（上一节的问题），没法先看真实数据。代码只能防御性地写，假设字段可能缺、格式可能变。能跑命令以后，助手第一件事是加了一个自检模式，拿 6 个会话、1163 行真实数据核了一遍，字段识别全对。

## 7. 它怎么工作

工具用 Go 写，单个文件，七百来行。核心是四步：

1. **找文件**：遍历根目录下所有 `.jsonl`。根目录默认是 `~/.claude/projects`，可以用 `-root` 换；
2. **流式读**：用 `bufio.Scanner` 一行一行读，不整份载入。单行可能塞着一大段工具输出，缓冲区从 1 MB 起，上限放到 64 MB；解析失败的行跳过，不中断；
3. **抽正文**：`content` 可能是字符串，也可能是 block 数组。只取 `text` 类型的块，模型的思考过程不进结果，工具调用和工具输出只在加 `-tools` 时才搜；
4. **匹配和输出**：多个词默认是「都要出现」，不区分大小写；`-re` 时按正则。命中按时间从新到旧排，取前 N 条，每条截一段以第一个词为中心的上下文，按字符而不是字节截，不会把中文切成半个。

抽正文那一步的最小版本：

```go
type block struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

func textOf(content json.RawMessage) string {
	var s string
	if json.Unmarshal(content, &s) == nil {
		return s
	}
	var blocks []block
	if json.Unmarshal(content, &blocks) != nil {
		return ""
	}
	var parts []string
	for _, b := range blocks {
		if b.Type == "text" {
			parts = append(parts, b.Text)
		}
	}
	return strings.Join(parts, "\n")
}
```

其余是一些过滤和输出选项：按角色（`-role user`）、按项目（`-project`）、按时间窗（`-since 7d`、`-before 2026-09-30`）；`-list` 列会话，`-stats` 出统计，`-json` 方便接管道。用起来大概是这样：

```bash
recall -since 7d -role user docker 镜像
recall -re -tools 'ENOTFOUND|EOF'
recall -list -since 24h
recall -doctor
```

最有用的是 `-doctor`。它报告每个字段（时间戳、角色、正文、工作目录）的识别率，以及记录类型的分布。会话的格式不是公开承诺的接口，随版本会变；一个多月后再跑一次，592 个文件里已经多出了好几种新的顶层记录类型。识别率一掉，就知道该改解析了。

## 8. 用下来发现的局限

工具用了一个多月，碰到的问题都在边界上。

**按「最后活动」排序，不能按本地日期切分**。`-list` 按会话的最后活动时间排；一个昨天开始、今天还在用的会话，在「今天的会话」里不好找。后来写日报汇总脚本时，干脆绕过了它，直接解析 JSONL、按每条记录的时间切日，见[从会话记录生成日报](/blog/ai-workflow/daily-report-from-sessions/)。

**日期按 UTC 解析**。`-since 2026-09-21` 走的是 Go 的 `time.Parse`，不带时区就按 UTC 的零点算；记录里的时间戳也是 UTC。在东八区的机器上，「从 21 号开始」其实是从本地上午 8 点开始，差了 8 小时（看代码得出，没有逐条实测）。该用 `time.ParseInLocation(layout, s, time.Local)`。

**项目过滤匹配的是编码后的目录名**。Claude Code 把会话的启动目录编码成目录名，路径里的 `/`、`.`、`_` 都换成 `-`。工具解码时只能把 `-` 换回 `/`，这是有损的：`my-app` 解成 `my/app`，`.local` 解成 `/local`。帮助文字写的是「对工作目录做子串匹配」，实际匹配的却是解码后的目录名。实测：拿工具源码目录的路径片段去过滤，扫到 0 条消息；那个会话是在别的目录里启动、后来才切过去的，它的目录名里根本没有这段路径。该改成匹配每条记录里的 `cwd` 字段。

**先截断再看最早**。结果按时间从新到旧排、取前 N 条，所以显示出来的「最早一条」只是最新 N 条里最早的那条，不是真正的第一次出现。要找某件事第一次出现，得放大 `-n` 或者缩小时间窗。

**迁移环境以后，旧会话不在默认目录里**。几天后我为了换账号迁移了 Claude 的环境：历史会话打包备份，新环境从空目录开始。后来想翻迁移前的记录，写死默认路径的工具就看不到了；`recall -root <备份目录>` 能看到。所以检索工具一定要留一个根目录参数；迁移时，要么把历史一起搬过去，要么让工具也去索引备份。

## 9. 第一天就该做、却拖了两天的事

Git 身份。第一天定的是「下次提交再说」，结果当天就已经提交过了。没配身份时，git 会按系统的用户名和主机名自己拼一个（文档：git-commit 手册的 COMMIT INFORMATION 一节），提交里的作者信息就不是你想要的。

```bash
git log -1 --format='%an <%ae> / %cn <%ce>'
```

推送之前用这一行看一眼作者和提交者。在不方便改配置的仓库里，提交时直接带上身份：`git -c user.name=<名字> -c user.email=<邮箱> commit`。

## 收尾

1. **先盘点再装** —— 新机器上已有的东西比想的多，盘点一遍能避免装出两份版本打架。
2. **网络不通就绕路** —— 厂商的 arm64 包加上 `admin` 组可写的 `/Applications`，比和安装脚本死磕快得多。
3. **PATH 按启动方式验** —— 终端里能用不代表工具里能用，`zsh -lc` 和 `zsh -ic` 各跑一次。
4. **自己的工具要有自检** —— 数据格式不归你管，`-doctor` 这类识别率报告能第一时间发现格式变了。
5. **检索工具留好边界参数** —— 根目录、时区、匹配字段，这三处第一版就该想到。

现在回头看，那天最值的不是装好的那些软件，而是那个小工具。要回答「上次那个问题是怎么解决的」，先搜一遍会话，比凭记忆靠谱。机器跑起来以后的日常排障，见 [Mac 开发机的日常排障](/blog/tooling/mac-dev-machine-ops/)。
