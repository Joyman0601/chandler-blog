---
# import-articles-sha256: 60ade64e347fd20eff8862809784266c07cf510317a0e0e6b503bf5428395e30
# Imported by scripts/import-articles.mjs from posts/git-collab/diff-range-trunk-merge-base.md
# Source date: 2026-10-16
title: "出 diff 前先定主干和起点：让 diff 骗人的五种情况"
description: "审分支、出快照、挪基线时，diff 的输出本身没错，错在拿什么和什么比。认错主干、基线前进后用两点 diff、在子目录里写根路径、rebase 零冲突就收工、审视工具看不到未提交改动，每种都附一段能直接用的命令。"
pubDate: 2026-09-26
tags: ["Git","Code Review","多仓库"]
series: git-collab
seriesLabel: "Git 与协作"
---

> 一句话总结：git diff 的输出几乎不会错，错的是比较的两端。出任何 diff 之前先回答两个问题：主干是哪条，起点是不是 merge-base；在子目录里跑命令、挪完基线、审未提交的改动这三种场合，再各加一道核对。

## 0. 起因：几次「diff 不对劲」都不是 git 的问题

我日常有不少活是「拿一段 diff 下结论」：审别人的分支、合并前做深度 review、给几个仓库导出主干快照、挪完基线确认改动没丢。这些活大多交给 AI 编程助手（Claude Code）跑命令、出结论，我看结论。几个仓库并行，每个仓库都有好几条长期分支。

一个多月里碰到几次「diff 看起来不对」，事后看是同一类问题：git 的输出是对的，交给它的两端是错的。

- 主干认错了，导出的快照少了将近 900 个文件的改动；
- 基线前进了还用两点 diff，十几个分支没碰过的文件显示成「被删了」；
- 在子目录里写了按仓库根算的路径，diff 是空的，退出码是 0，差点拿它证明「两边逐字节一致」。

这篇按出 diff 的顺序讲：先认主干，再定起点，然后是三种需要额外核对的场合。每节都给能直接用的命令。文中的分支名一律用 `main`、`integration` 这类通用名。

## 1. 认主干：看最近的 PR 合进了哪条分支

**现象**：助手给几个仓库导出主干快照，用来做代码梳理。其中一个仓库，它选了 `main`。后来一对比，快照少了将近 900 个文件的改动。

**根因**：这个仓库的默认分支是 `main`，团队实际却在一条长期集成分支上开发（下面叫 `integration`）。事后统计，最近几十个合并掉的 PR，目标全是 `integration`。`main` 是它的祖先，远远落后于它；偶尔又有人往 `main` 直接推一两个提交，所以按最近提交日期排，`main` 经常排第一。

更尴尬的是，助手是照着我经验库里一条现成的规则选的：「按最近提交日期认主干」。这条规则是一周多以前碰到「默认分支过期」时，助手总结出来的，还写进了自动检查脚本。这次是负责复盘的子代理回看历史数据时挖出了问题，助手核实以后，把同一批仓库的快照全部按新规则重新导了一遍，检查脚本里写死的「全局一个主干」改成了逐仓配置，经验库里那条规则也重写了。

默认分支、`origin/HEAD`、最近提交日期这三个信号都可能骗人：

- 默认分支是仓库设置，团队换了工作流，不一定有人去改它；
- `origin/HEAD` 是 clone 时记下的本地指针，远端后来改了默认分支，它不会自己跟上（文档：要用 `git remote set-head origin --auto` 去远端重新查）；
- 最近提交日期会被偶发的直推拉高。

**修复**：认主干看「最近合并的 PR 都合进了哪条分支」。这是团队真实工作流留下的痕迹，比任何设置都准。

```bash
# 最近 60 个已合并 PR 的目标分支分布
gh pr list --repo OWNER/REPO --state merged --limit 60 \
  --json baseRefName \
  --jq 'group_by(.baseRefName) | map("\(.[0].baseRefName) \(length)") | .[]'

# 对照：远端分支按提交日期排，看它会不会把你带偏
git for-each-ref --sort=-committerdate --count=10 \
  --format='%(committerdate:short) %(refname:short)' refs/remotes/origin

# 确认候选主干之间的祖先关系
git merge-base --is-ancestor origin/main origin/integration && echo "main 是 integration 的祖先"
```

输出里一条分支占了绝大多数，它就是主干。几条分支平分秋色时（比如有 release 分支），按这次 diff 的目的选：审一个特性分支，就选它的 PR 目标；导快照，就先问清要哪条线的快照。

## 2. 定起点：一律从 merge-base 出，用三点 diff

**现象**：rebase 之前，要看一条分支改了什么，助手跑了一条两点 diff：

```bash
git diff --stat origin/integration HEAD
```

列出来三十多个文件，其中十几个测试文件和 SQL 文件显示成「被删除」。这条分支根本没碰过它们，实际改动大约 10 个文件。

**根因**：两点 diff `A B` 比的是两个提交的完整快照。分支从旧基线切出来以后，主干又合进了别人的提交，新加了那些文件。拿主干的最新状态和分支比，别人新增的文件在分支这边不存在，就显示成「删了」；别人改过的行，就显示成「改回去了」。

三点 diff `A...B` 比的是 `merge-base(A, B)` 和 `B`，只含 B 这一侧自分叉以来的改动（文档：git-diff 手册写明 `git diff A...B` 等价于 `git diff $(git merge-base A B) B`）。

**修复**：要回答「我这条分支改了什么」，一律用三点：

```bash
BASE=origin/integration
MB=$(git merge-base HEAD "${BASE}")

# 基线在我切出来以后又前进了多少
git rev-list --count "${MB}..${BASE}"

# 我的改动，从分叉点算
git diff --stat "${BASE}...HEAD"

# 我改过、主干这段时间也改过的文件，rebase 时最可能打架
comm -12 \
  <(git diff --name-only "${MB}" HEAD | sort) \
  <(git diff --name-only "${MB}" "${BASE}" | sort)
```

`rev-list --count` 不是 0，两点 diff 就一定会混进别人的改动。

两点和三点的语义在 `git log` 里正好反过来：`git log A..B` 才是「B 有、A 没有的提交」，`git log A...B` 是两边各自独有的提交。我的记法是：diff 想看「我的改动」用三点，log 想看「我的提交」用两点。

## 3. 在子目录里：路径参数按当前目录解释

**现象**：一次复核里，要证明「这批页面文件和主干逐字节一致」。负责复核的助手窗口，shell 停在仓库的 `web/` 子目录里，它照仓库根写了路径：

```bash
cd repo-a/web
git diff --quiet origin/main HEAD -- web/pages && echo "一致"
```

输出「一致」。退出码 0，看起来没有差异。其实这个路径一个文件都没匹配上。

**根因**：`git diff`、`git grep`、`git log`、`git ls-tree` 的路径参数（pathspec）按当前目录解释。在 `web/` 里写 `web/pages`，git 去找的是 `web/web/pages`。不存在的路径不报错，于是（实测，git 2.50）：

- `git diff` 输出为空、退出码 0，加 `--quiet` 也是 0，等于告诉你「无差异」；
- `git grep` 退出码 1，等于告诉你「没找到」；
- `git log` 输出 0 条。

更容易误导的是 `git show rev:path`：冒号后面的路径按仓库根算（文档：gitrevisions 里写明要相对当前目录得写成 `rev:./path`）。同一个窗口里两种写法混着用，一个对，另一个静默为空。gitglossary 对 pathspec 的说法是：「See the documentation of each command for whether paths are relative to the current directory or toplevel」。也就是说，没有统一规则，要看每个命令自己的文档。

**修复**：做三件事。

第一，路径按仓库根写的时候，用 `git -C` 指到根，或者给路径加 `:/` 前缀。gitglossary 对这个前缀的解释是「match from the root of the working tree」：

```bash
ROOT=$(git rev-parse --show-toplevel)
git -C "${ROOT}" diff --quiet origin/main HEAD -- web/pages

# 或者
git diff --quiet origin/main HEAD -- ':/web/pages'
```

第二，先数路径参数命中了几个文件。数出 0 个，「空 diff」就不可信。数法是拿空树和目标提交做 diff：

```bash
EMPTY=$(git hash-object -t tree /dev/null)
P=(web/pages 'web/components/*.tsx')
git -C "${ROOT}" diff --name-only "${EMPTY}" origin/main -- "${P[@]}" | wc -l
```

这个数法也改过一次。助手记进经验库的第一版，用的是 `git ls-tree -r --name-only origin/main -- <路径>`，后来实测发现 ls-tree 的路径参数不展开通配符，`*.tsx` 一律数出 0，又是一个假的「0 命中」。空树 diff 走的是和 `git diff` 相同的匹配逻辑，数出来的就是 diff 真正会看的范围。路径里带 `[locale]` 这种方括号时，助手也担心过它被当成字符类，实测仍能匹配到真实文件；拿不准时，先数一遍就知道。

第三，加一个正向对照：挑一对确实有差异的提交，用同样的路径参数跑一遍，它必须报出差异。

```bash
git -C "${ROOT}" diff --quiet HEAD~5 HEAD -- web/pages
echo "exit=$?"
```

预期是 `exit=1`。对照报不出差异，说明命令本身是瞎的，它说「一致」也不算数。

那次复核用 `git -C` 加对照重跑以后，结论没变，文件确实一致。但在重跑之前，这个结论是没有证据的。

## 4. 挪基线之前：用 merge-tree 先演一遍

要把分支 rebase 到新主干上之前，我会先用 `git merge-tree --write-tree`（git 2.38 起）在内存里做一次合并。它不碰工作区、不碰 index、不改任何引用：

```bash
git fetch origin
git merge-tree --write-tree --name-only origin/main HEAD
echo "exit=$?"
```

退出码 0 表示能干净合并；退出码 1 表示有冲突，输出里会列出冲突的文件名。注意老格式 `git merge-tree <base> <a> <b>` 是另一套输出，两者别混用。

它预言的范围要分清：

- 分支只有一个提交时，merge-tree 的结果就是 rebase 的结果；
- 分支有多个提交时，rebase 是逐个提交重放，中间某一步可能冲突、后面又自己消掉，所以 merge-tree 只能预言「最终会不会冲突」，预言不了 rebase 中途停几次。

它和第 2 节的 `comm -12` 重叠清单配合用。**重叠不等于冲突**：两边改了同一个文件的不同段落，git 会自己合好。merge-tree 报干净，就不用逐个文件担心文本冲突；重叠但干净的文件，再用 `git diff --numstat` 看两边各改了多少，改动大的那几个，合完以后重点看语义。我一般先看这两样，再决定这次用 rebase 还是 merge。

## 5. rebase 零冲突不等于完事

git 只管文本冲突。下面两种问题，rebase 零冲突、提交历史干干净净，照样会出。

### 按提交日期生成的文件会漂移

文档站的 sitemap 由脚本生成，每页的 `lastmod` 取自最后修改这个文件的提交：

```bash
git log -1 --format=%cI -- docs/some-page.md
```

`%cI` 是提交者日期（committer date）。rebase、amend、cherry-pick 都会把提交者日期改成「现在」，作者日期不变。所以挪完基线，分支改过的那些页面，`lastmod` 全变成了挪基线的那一刻，和分支里已经提交的生成物对不上。

先查仓库里有没有这类脚本：

```bash
grep -rnE '%c[dDiIst]|committer' scripts/
```

有的话，挪完基线就重跑一次生成；再跑第二次，预期零 diff，证明生成是稳定的。

还有一层更隐蔽的。分支已经推上去以后，把主干合进分支，再重跑生成，结果和最终合进主干后的样子还是不一样。原因在 `git log -- <文件>` 的历史简化：遇到合并提交，它会沿着和合并结果相同（TREESAME）的父提交走，优先第一父（文档：git-log 手册的 History Simplification 一节）。本地「把主干合进分支」的合并提交，第一父是功能分支；平台合并 PR 时，第一父是主干。同一个文件沿哪条父链去找「最后一次修改」，两种合并可能给出不同答案。

要预览合并进主干以后的生成结果，就造一个主干在前的合成合并，在它上面跑生成脚本：

```bash
SIM=$(git commit-tree "$(git rev-parse 'HEAD^{tree}')" -p origin/main -p HEAD -m sim)
git worktree add --detach "${TMPDIR}/sim" "${SIM}"
```

这个提交不在任何分支上，用完 `git worktree remove` 掉即可。

### 新基线里钉死清单的测试

**现象**：rebase 零冲突。只跑了改动相关的测试，全绿。后来跑全量，红了一条这条分支从没碰过的测试。

**根因**：主干在这段时间里新加了一条测试，钉死「某一天的更新日志恰好是这 3 条」。这条分支往同一天加了第 4 条。两边各自都对，合在一起就红。这是语义冲突，git 看不见。

**修复**：挪完基线跑全量测试。时间紧的话，至少把基线这段时间新增和改动的测试挑出来跑：

```bash
git diff --name-only ORIG_HEAD...origin/main | grep -E '(__tests__/|_test\.|\.test\.)'
```

rebase 结束后 `ORIG_HEAD` 指向挪之前的分支顶端，这条命令列出的就是「主干在分支切出来以后新增或改动的测试文件」。

## 6. 审未提交的改动：用临时 index 拍一个提交

我有个习惯：改动先不提交，等 review 意见改完再提交。可很多审视工具只认 `merge-base..HEAD`，看不到工作区里没提交的东西。为了审一次去提交或者 stash，都会动到真实的分支和 index。

做法是复制一份 index，在副本上 `add -A`、写树，再用 `commit-tree` 造一个不在任何分支上的提交：

```bash
SNAP_INDEX="${TMPDIR}/snap.index"
cp "$(git rev-parse --git-path index)" "${SNAP_INDEX}"
GIT_INDEX_FILE="${SNAP_INDEX}" git add -A
TREE=$(GIT_INDEX_FILE="${SNAP_INDEX}" git write-tree)
SNAP=$(git commit-tree "${TREE}" -p HEAD -m "review snapshot")

# 真实 index 没动：暂存区的文件数应该和拍之前一样
git diff --cached --name-only | wc -l

# 交给只认提交的工具：detached worktree，或者工具自己的 --rev 参数
git worktree add --detach "${TMPDIR}/review" "${SNAP}"
```

几点注意：

- 这不是 stash，没有任何引用指着它。过一段时间会被 gc 回收，所以别拿它当备份；
- 代码改了就重新拍一次，旧快照不会跟着变；
- 被 `.gitignore` 忽略的文件不会进快照，和正常提交一致。

要预览「这批未提交改动合进主干以后」的样子，可以把第 4 节和这里接起来：先用 merge-tree 拿到合并结果的树，再用 `commit-tree -p origin/main -p "${SNAP}"` 造一个合成合并，挂成 detached worktree。

## 7. 出 diff 前的检查表

| 问题 | 怎么核 |
|---|---|
| 主干是哪条 | `gh pr list --state merged` 看 `baseRefName` 的分布 |
| 起点对不对 | 用 `git merge-base` 找分叉点；`rev-list --count` 不是 0 就只用三点 diff |
| 路径参数命中了吗 | 空树 diff 数文件数；路径按根写时用 `git -C` 或 `:/` |
| 命令是不是瞎的 | 正向对照：一对已知有差异的提交，同样的参数必须报出差异 |
| 挪基线会不会冲突 | `git merge-tree --write-tree` 看退出码 |
| 挪完还要做什么 | 重跑按提交日期生成的文件，跑全量测试 |
| 工具看得到未提交改动吗 | 临时 index 加 `commit-tree` 拍快照 |

## 收尾

1. **主干看 PR 目标** —— 默认分支、`origin/HEAD`、最近提交日期都是间接信号，最近合并的 PR 合进了哪条，才是团队真实的工作流。
2. **起点一律 merge-base** —— 基线前进以后，两点 diff 会把别人的新提交显示成你的删除。
3. **空 diff 先数命中** —— pathspec 不匹配不报错；数出 0 个文件，「无差异」就不算数。
4. **零冲突只说明文本能合** —— 生成物和钉死清单的测试，要在新基线上重跑。
5. **规则本身也要被验证** —— 「按提交日期认主干」是经验库里自己总结的规则，用了一个多星期才被历史数据推翻。

这几次的共同点是：结论来自一条看起来正常的命令输出，而命令的输入没有核过。现在我下任何「没有差异」「只改了这些」的结论之前，先问两件事：比较的两端是什么；这条命令在一对已知有差异的输入上，能不能报出差异。后一条同样适用于测试，见[守卫测试的三个要求](/blog/testing/guard-tests-three-rules/)。多个仓库互相依赖时，每个仓库都要对着自己的主干出 diff，见[多任务并行的 worktree 用法](/blog/git-collab/worktree-multi-task/)。
