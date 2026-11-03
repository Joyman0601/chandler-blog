---
# import-articles-sha256: f96290649313e7cf72812e83cc80cf3ffb796b7ea7e033ae6f052f4c73408648
# Imported by scripts/import-articles.mjs from posts/git-collab/worktree-multi-task.md
# Source date: 2026-09-28
title: "多任务并行的 git 用法：按任务隔离 worktree"
description: "几个任务同时在一台机器上推进，又分散在互相依赖的几个仓库里。平铺的 worktree 让任务共用同一份依赖检出，构建悄悄串线。这篇讲按任务分目录、显式起点、多仓审视、同一行追加的合并、共用检出时只暂存自己的改动。"
pubDate: 2026-08-13
tags: ["Git","worktree","多仓库","协作"]
series: git-collab
seriesLabel: "Git 与协作"
---

> 一句话总结：worktree 隔离的单位是「任务」，不是「仓库」。一个任务要改的仓库和它依赖的仓库放进同一个任务目录，相对路径的依赖替换才会各归各；再加上显式起点、建完核归属、共享清单只追加，几条线并行时就不会互相踩。

## 0. 起因：并行的线越来越多

刚开始只是前端的三条线并行：三个功能各一个 worktree，各起一个 dev server，端口错开。三条线都要往同一份契约清单和页面注册表里加东西。

第一个坑来得很快。其中一个 worktree 是在主检出停在另一条功能分支上时建的，`git worktree add` 默认从当前 HEAD 切，新分支一出生就带着另一条线的代码。好在两边的提交改的文件零重叠，最后拆成了一条工具分支和一条功能分支，各自干净。

后来后端的活多起来，事情变复杂了。后端拆成了几个仓库：主后端网关、供应商 SDK、一个公共核心库、任务 worker。一次功能改动往往同时落在其中三个。网关和 worker 的 `go.mod` 用相对路径指向兄弟仓库：

```go
// repo-a/go.mod
replace example.com/sdk => ../sdk
replace example.com/core => ../core
```

本地联调用的 compose 文件里，也写死了 `../worker` 这样的相对路径。这一条约束，决定了 worktree 不能随便摆。

还有一点：这些 worktree 里干活的，大多是我同时开着的几个 Claude Code 会话，每个会话负责一条线。下文说的「助手」就是它们，「我」是给它们派活、看结论的人。

## 1. 目录约定：按任务分，依赖跟着任务走

**现象**：最早 worktree 和主检出平铺在同一层，名字加后缀区分，比如 `repo-a-task1`、`worker-task1`。有一天 worker 在 A 任务的分支上本地编译失败了，worker 自己的代码看不出问题。

**根因**：平铺时，`worker-task1/../sdk` 指向的是 SDK 的主检出，而不是 A 任务的 SDK 分支。那份主检出当时被另一个会话切到了 B 任务的分支上。所有平铺的 worktree 共用这一份 SDK，谁切一下分支，别的任务的构建就跟着变。更糟的情况是有人在这时跑了 `go mod vendor`：vendor 目录会按当时那份 SDK 重新生成，别的任务刚加的客户端代码就被悄悄换掉。那段时间我得记着一条规矩「构建前先看一眼 SDK 停在哪个分支」，这种靠记性的规矩迟早会漏。

**修复**：目录按任务分，任务目录里的仓库名和原仓库一模一样，不加后缀：

```text
work/
├── repo-a/                 主检出，停在默认分支
├── sdk/
├── worker/
└── wt/
    ├── task-a/
    │   ├── repo-a/         task-a 的分支
    │   ├── sdk/            task-a 的 SDK 分支
    │   └── worker/
    └── task-b/
        ├── repo-a/
        └── sdk -> ../../sdk    这个任务不改 SDK，软链到主检出
```

这样 `wt/task-a/repo-a/../sdk` 自然就是 `wt/task-a/sdk`，相对路径的 replace 和 compose 里的 `../worker` 一行都不用改，各自指向本任务的副本。任务不改某个仓库时，软链到主检出即可，前提是主检出约定只停在默认分支。

这个约定带来一个副作用：每个任务目录里的仓库都叫 `repo-a`，而 Docker Compose 默认拿目录名当项目名（文档）。在 `wt/task-a/repo-a` 里 `docker compose up`，项目名和主检出那套开发栈相同，会把正在跑的那套替换掉。compose 文件里写死了 `container_name` 的话，用 `-p` 换项目名也没用，容器名照样撞。我的选择是同一时间只起一套栈，起之前看一眼 `docker compose ls`。

从平铺挪到新布局是助手做的，挪完它核了三件事：

- 每个被挪的目录，挪前挪后的 `git rev-parse HEAD` 一致；
- 用 `go build -mod=mod` 编一遍，强制走 replace 的相对路径、不读 vendor，确认依赖解析到了本任务的副本；
- 其他还开着的会话记着旧路径，要逐个告诉它们新路径。挪的过程中恰好有个会话在提交，提交落进了正确的目录，但这是运气。下次挪目录，先让其他会话停手。

任务结束：推送，逐个 `git worktree remove`，最后删掉空的任务目录。

## 2. 建 worktree：显式起点，绝对路径，建完核归属

`git worktree add` 不写起点时，从当前 HEAD 切分支。主检出停在哪，新任务就背着什么。所以起点一律显式写：

```bash
git -C "${WORK}/repo-a" fetch -q origin
git -C "${WORK}/repo-a" worktree add -b feature/task-a "${WORK}/wt/task-a/repo-a" origin/main
```

路径为什么要写绝对路径，有两个原因。

第一，`git -C <仓库> worktree add <相对路径>` 里的相对路径，是相对 `-C` 指向的目录解析的，不是相对你当前所在的目录。在父目录里写 `git -C repo-a worktree add wt/task-a/repo-a`，worktree 会建到 `repo-a/wt/task-a/repo-a`，也就是仓库内部。

第二，在 Claude Code 这类工具里，shell 的当前目录会在两次命令之间被重置。助手有一次写的是 `cd <仓库> && git worktree add …`，实际执行时 `cd` 进的是另一个仓库，建出来的是那个仓库的 worktree，一下子检出了七千多个文件，一眼就不对。

所以写法固定成「`-C` 指仓库的绝对路径，目标也写绝对路径」，建完立刻核归属：

```bash
# 只为编译或跑环境的 worktree，不开分支，用 --detach
git -C "${WORK}/worker" worktree add --detach "${WORK}/wt/task-a/worker" origin/main

# 归属核对：应当指向 worker 主检出的 .git
git -C "${WORK}/wt/task-a/worker" rev-parse --git-common-dir
```

建错了用归属仓库的 `git worktree remove --force <目标>` 删，挪位置用 `git worktree move <旧> <新>`。不要用 `rm -rf` 或 `mv`：主仓库的 `.git/worktrees/` 里还记着这个 worktree，手工删挪会留下悬空记录。

另外两条规则也要记住：

- 所有 worktree 共享同一个 `.git`，同一个分支不能同时在两个 worktree 里检出；
- 每个 worktree 有自己的构建输出目录，但同一个目录里的 dev server 和 build 仍然会抢同一个输出目录。前端项目跑 build 之前，先停掉同目录的 dev server。

## 3. 依赖的修复落在依赖仓库，不落在 vendor

**现象**：为了跑通一次真实调用，助手直接改了下游仓库 `vendor/` 目录里的 SDK 代码。调用通了，测试记录里写上了「SDK 直测通过」。

**根因**：`vendor/` 被 `.gitignore` 忽略，是生成物，不是源码。SDK 仓库里还是旧的实现。别人拉 SDK 构建出来的是坏的；本地任何人跑一次 `go mod vendor`，这个修复就被覆盖。改生成物，等于把修复放在一个不受版本管理、随时会被重新生成的地方。这种情况下「本地跑通了」反而更危险，因为它让人以为事情做完了。

**修复**：修复迁回 SDK 仓库并提交，下游 `go get` 到这个提交，再重新 vendor。测试记录写明验证时用的依赖来自哪里。在 vendor 里改，只用来临时验证一个猜想，验证完就还原。

## 4. 审多仓库的改动：按依赖清单定范围

**现象**：审一次后端改动，主仓的 diff 很小，看起来只是几行接线。真正的上游调用和队列逻辑改在兄弟仓库里，差点没人看。

**根因**：三件事叠在一起（文档：Go modules 对 replace 和 vendor 的行为说明，加上实际排查）：

1. 拆仓期间新旧结构并存，分支名看不出一个工作区走的是哪种结构；
2. 本地 `replace ../` 用的是磁盘上的兄弟仓库。跨仓接口只改了一侧，只要本地两个目录对得上，编译照样通过；合并以后各仓按发布版本取依赖，才会炸；
3. 主仓的 `vendor/` 是依赖的快照，依赖改了但快照没重新生成，跑的还是旧代码，`go build` 会报 `inconsistent vendoring`。

**修复**：审视范围按依赖清单定，不按分支名定。先判断结构：

```bash
grep -q '=> \.\./' go.mod && echo "多仓结构" || echo "单体结构"
```

多仓结构下，每个兄弟仓库对着自己的主干各出一份三点 diff。主干怎么认、为什么用三点，见[出 diff 前先定主干和起点](/blog/git-collab/diff-range-trunk-merge-base/)：

```bash
for d in sdk core worker; do
  echo "=== ${d} ==="
  git -C "../${d}" fetch -q origin
  git -C "../${d}" diff --stat "origin/main...HEAD" | tail -3
done
```

改动为空的仓库，在审视记录里写「已查，无改动」，而不是不写。

还有一种跨仓问题，编译查不出来，只有测试能查出来。依赖仓库给某个类型新实现了一个可选接口，下游如果有一张按「是否实现该接口」给每个实现分类的守卫表，编译照过，下游测试会红。这张表要在下游同步改，并且和依赖版本升级放进同一次合并。

## 5. 两条分支往同一行追加：写成逐字相同的并集

**现象**：两个功能分支从同一个基点切出，各自往一行逗号分隔的注册名单末尾加了自己的一项。单独看每条都干净；集成时合第二条，报文本冲突。

```text
基线：  PLUGINS=alpha,beta
分支 A：PLUGINS=alpha,beta,gamma
分支 B：PLUGINS=alpha,beta,delta
```

**根因**：三方合并只在「一侧等于基线」或「两侧相同」时自动接受。两侧对同一行做了不同修改，就是冲突，哪怕语义上只是各加一项（文档：git-merge 手册的三方合并说明）。

**修复**：看两条分支的依赖关系选做法。

- B 以 A 为前提：把 A 合进 B，冲突处取并集。之后主干先合 A 再合 B，第二次合并没有差异。
- 两条独立、哪条先合都有可能：在 A 和 B 上都把那一行改成同一份并集，连顺序、空格都一致，各自提交。三方合并看到两侧相同，就直接接受。

```text
A 和 B 都改成：PLUGINS=alpha,beta,gamma,delta
```

这招有个前提：两条分支在那一行上的基线相同。后来又踩过一次。其中一条分支的基线比主干旧很多，主干在它分出之后改过同一行。它原本没动这一行，合进主干是干净的；助手一把它改成「和兄弟分支逐字相同」，就变成它和主干各改了一次，立刻冲突。所以改之前，把三种合并组合都用 merge-tree 演一遍：

```bash
for pair in "feature/a feature/b" "origin/main feature/a" "origin/main feature/b"; do
  git merge-tree --write-tree --name-only ${=pair} >/dev/null
  echo "${pair}: exit=$?"
done
```

这段是 zsh 写法，`${=pair}` 让变量按空格拆成两个参数；bash 里直接写 `$pair`。为什么 zsh 要这样写，见 [zsh 和 bash 3.2 的七个展开坑](/blog/tooling/zsh-expansion-gotchas/)。

反过来也有坑，而且更隐蔽。一次把主干合进功能分支，两边各自往同一个列表里加了一项，也都把测试里钉死的条目数从 34 改成 35。冲突只出在那一行上方的注释里；数字那一行两边相同，git 直接取了 35，没有任何冲突标记。正确值是 36。

「两侧相同就接受」正是并集这招能成立的原因，可计数、总数、版本号这类该累加的值，两边各加一后写出同一段文本，合并结果只加了一次。钉在断言里的数，跑到那条测试会红；写在注释、文案、配置里的总数，没有测试读，会带着错值进主干。

所以合并完，对两边都改过的文件，逐个看被改的数字和列表，不只看冲突块。看结果之前先写下预期：计数等于基线加两边增量之和，列表等于两边的并集。

## 6. 几个窗口共用一个检出：只暂存自己的改动

有些仓库不适合开 worktree，比如一个所有会话共用的笔记仓库，保存脚本固定执行 `git add -A`。一次整理要提交一百四十多个文件，其中一个文件里有另一个窗口刚写、还没提交的一段内容，而助手批量改链接也正好动了这个文件的一行。直接跑保存脚本，对方那段就会以这个窗口的提交说明进库。

stash 和 checkout 都不行，对方可能正在写这个文件。做法是绕开工作区，直接往暂存区放一个「只含本窗口改动」的版本：

```bash
F=notes/shared.md
TMP_F="${TMPDIR}/mine.md"

# 取 HEAD 版本，只在它上面做自己的改动（比如对它重跑同一个改链接脚本）
git show "HEAD:${F}" > "${TMP_F}"

# 写成 blob，放进暂存区，工作区不动
blob=$(git hash-object -w "${TMP_F}")
git add -A -- . ":(exclude)${F}"
git update-index --cacheinfo "100644,${blob},${F}"

# 暂存区里只应看到自己的改动；工作区里只应剩对方那段
git diff --cached -- "${F}"
git diff -- "${F}"
```

助手核对时还踩了一个小坑：它习惯用 `grep '^[-+][^-+]'` 过滤掉 diff 的文件头，可 Markdown 列表行删掉时是 `-- [`、加上时是 `+- [`，正好被一起滤掉，看起来像什么都没暂存。直接看完整的 diff 更可靠。

## 7. 重排仓库之后逐项核实

挪文件、挪脚本、规范化换行这类「整理」，命令没报错、相似度很高，都不等于挪对了。碰到过三种。

### git mv -k 静默跳过未跟踪的文件

迁移页面时，要把一批文件挪进新目录，其中有已提交的，也有刚写、还没 `git add` 的。为了「一个出错别中断整批」，助手用了 `git mv -k`。命令安静地结束了，之后按新路径找文件，才发现新建的那几个还在旧目录。

`git mv` 遇到未跟踪的源文件，本来会报 `fatal: not under version control` 并以 128 退出；`-k` 把这类错误一律吞掉，不打印、不改退出码（实测，git 2.50）。做法：

```bash
git ls-files --error-unmatch old/dir/page.tsx >/dev/null 2>&1 && echo tracked || echo untracked
# 已跟踪的用 git mv（不加 -k），未跟踪的用普通 mv
ls old/dir new/dir
```

### 按脚本位置定位输入的脚本，挪一层就找不到文件

另一次是把一百多个一次性脚本从根目录分进 `scripts/<类别>/`。大部分脚本写的是 `open('input.txt')`，按当前目录找文件，从根目录运行照常工作；另有二十多个写的是 `join(dirname(__file__), 'input.txt')`，按脚本自身的位置找文件，挪进两层子目录后就 FileNotFoundError。

两种定位方式对「挪动」的敏感度正好相反，混在一起时看目录名看不出来。挪之前先 `grep -l '__file__' *.py`（JS 看 `__dirname`）把位置敏感的那批列出来，挪完按新深度改基准；按当前目录定位的那批，在 README 里写明从哪里运行。验收时每类挑一个只读脚本实跑一次。

### 规范化换行后，相似度证明不了「只改了换行符」

加了 `* text=auto` 再 `git add --renormalize .`，几百个文件显示成 R09x 的改名。助手先用 `--ignore-cr-at-eol` 再看，数字一个没变：改名检测的相似度按原始字节算，这个参数只影响 diff 正文，不影响相似度分数（实测）。

换成去掉 `\r` 再比 blob，大部分一致，但两百多个 XML 转储仍然不同。它们是 Windows 上用文本模式写出的，字符串里本来就有 `\r\n`，又被平台换行翻译了一次，行尾变成 `\r\r\n`。规范化只认 `\r\n` 这一对，剩下的一个孤 `\r` 留在行尾，检出时字节就变了。

```bash
git diff --cached -M --name-status | awk '$1 ~ /^R0?[0-9][0-9]$/ {print $2 "\t" $3}' |
while IFS=$'\t' read -r old new; do
  a=$(git cat-file -p "HEAD:${old}" | tr -d '\r' | shasum)
  b=$(git cat-file -p ":${new}" | tr -d '\r' | shasum)
  [ "${a}" = "${b}" ] || echo "content changed: ${new}"
done
```

别的工具生成、还要被别的工具读回的文件，在 `.gitattributes` 里按目录标 `-text`，关掉转换。

## 8. 一张清单

| 场合 | 做法 |
|---|---|
| 开新任务 | 建 `wt/<任务>/<仓库>`，要改的和要依赖的仓库都放进去，不改的软链到主检出 |
| 建 worktree | 显式起点；`-C` 和目标都写绝对路径；建完 `rev-parse --git-common-dir` 核归属 |
| 只为编译或跑环境 | `--detach`，不开分支 |
| 修依赖的 bug | 改依赖仓库并提交，下游升级版本再 vendor |
| 审多仓改动 | 按 `go.mod` 的 replace 定范围，每个仓库对着自己的主干出三点 diff |
| 共享清单 | 新增项一律加在末尾；同一行追加写成逐字相同的并集，先用 merge-tree 演三种组合 |
| 合并后 | 计数按「基线加两边增量」重算；生成物重跑，不手解冲突 |
| 共用检出提交 | 混着别人改动的文件，用 `hash-object` 加 `update-index --cacheinfo` 只暂存自己的那份 |
| 重排仓库 | 不用 `git mv -k`；挪完两边 `ls`；每类脚本实跑一个；去掉 `\r` 后比 blob |

## 收尾

1. **隔离的单位是任务** —— 依赖仓库也要按任务各有一份，否则相对路径的 replace 会把所有任务接到同一份检出上。
2. **起点显式写，路径写绝对** —— 默认起点是当前 HEAD，相对路径按 `-C` 解释，当前目录还会被工具重置。
3. **修复落在源头** —— vendor 和缓存里改的东西不属于任何仓库，跑通了也不算数。
4. **多仓审视按依赖清单** —— 本地 replace 会让只改了一侧的跨仓接口照常编译通过。
5. **两侧相同就接受，是把双刃剑** —— 并集靠它免冲突，累加的计数也因为它少加一次。

这些规则单看都很朴素，难在并行时没有人替你记。我现在开任务的第一步就是建好任务目录、核一遍归属，再开始写代码。分支推上去以后，状态要问远端，见[推送和 PR 状态只问远端](/blog/git-collab/push-status-ask-remote/)。
