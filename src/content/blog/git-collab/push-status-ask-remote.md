---
# import-articles-sha256: 924f71a6833c5fdc2dbd539a29d665bdceb0b2c77d5b6e0309e30ce797891e35
# Imported by scripts/import-articles.mjs from posts/git-collab/push-status-ask-remote.md
# Source date: 2026-10-19
title: "推送和 PR 状态只问远端：ls-remote、竞态和主干保护"
description: "没设 upstream 不等于没推送，本地的 origin/* 也会过期。清点「推了还没开 PR」的分支要按自己的提交筛、每次重新枚举；把两个 PR 合成一个有竞态；「不推主干」的规则拦不住自己开 PR 再自己合。附核对脚本、守卫示例和推送前清单。"
pubDate: 2026-10-01
tags: ["Git","协作","Claude Code","Hooks"]
series: git-collab
seriesLabel: "Git 与协作"
---

> 一句话总结：「推没推」「开没开 PR」「合没合」都是远端的事实，只能问远端。本地的 upstream 配置、`origin/*`、上一版清单的数据都只是记录；规则也一样，只写「不推主干」封住的是一条路，要写成「合主干归谁」，再把每条合并路径都拦下。

## 0. 起因：状态报错一次，别人就要追一次

我在团队里的分工是写代码、推分支；开 PR 和合进主干归 leader。所以每天收工前，我要报一遍各个分支的状态：哪些推了，哪些还没开 PR，开了的能不能干净合进主干。几个仓库、十几条分支，靠记性报不准，这些状态由 Claude Code（下文叫「助手」）写脚本来核。

脚本本身也会错。这一个多月里，状态报错过几次，每次的根因都一样：脚本问的是本地记录，不是远端。另外还有两次事故不是「报错状态」，而是「改错了远端」：一次是把两个已开的 PR 合成一个时撞上了别人的合并，一次是编码代理自己开 PR、自己合进了主干。

这篇按「推没推、开没开、合没合」的顺序讲，最后给一张推送前的清单。

## 1. 推没推：upstream 和 origin/* 都是本地记录

**现象**：写汇报前跑核对脚本。脚本按 `git for-each-ref --format='%(upstream:short) %(upstream:track)'` 判断，同一个功能分布在 5 个仓库的分支，全被标成「无上游，未推送」。助手差一点就把它写进给我的汇报。换 `git ls-remote` 一查，远端同名分支的 head 和本地逐个一致：早就推了，只是推的时候没带 `-u`。

**根因**：

- `%(upstream:*)` 和 `git status -sb` 里的 ahead / behind，读的都是本地配置 `branch.<名>.merge`。`git push origin <分支>` 不带 `-u` 时，这项配置不会写，远端却已经有了这条分支；
- 设了 upstream 也不保险。ahead / behind 比的是本地的 `refs/remotes/origin/<分支>`，也就是上次 fetch 时的快照。别人推过，或者从另一个 worktree 推过，快照就过期了，显示「同步」也可能是错的；
- 两者都不联网，所以都回答不了「远端现在是什么」。

反过来的情况也碰到过：新建的分支没有上游，直接敲 `git push`，git 报当前分支没有上游分支、拒绝推送（文档：`push.default=simple` 的默认行为）。第一次推送要写全 `git push -u origin <分支>`。

**修复**：每个仓库问一次远端，一次网络请求拿到全部分支的 head，再逐个和本地比：

```bash
heads=$(perl -e 'alarm shift; exec @ARGV' 20 git ls-remote --heads origin) || {
  echo "远端查不到：推送状态未知"
  exit 1
}
git for-each-ref --format='%(refname:short) %(objectname)' refs/heads |
while read -r br sha; do
  rsha=$(printf '%s\n' "${heads}" | awk -v r="refs/heads/${br}" '$2 == r {print $1}')
  if [ -z "${rsha}" ]; then
    echo "${br} 未推送（远端没有同名分支）"
  elif [ "${rsha}" = "${sha}" ]; then
    echo "${br} 已推送，与远端一致"
  else
    echo "${br} 与远端不同，先 fetch 再比 ahead/behind"
  fi
done
```

几个细节：

- macOS 没有 `timeout` 命令，用 `perl -e 'alarm shift; exec @ARGV' 20` 给 `ls-remote` 加 20 秒超时；
- 远端查不到时输出「未知」，不要退回去写「未推送」。把「查不到」当成「没有」，正是这次的错法；
- 远端的 head 本地没有这个对象（`git cat-file -e <sha>` 失败），说明远端有本地没见过的提交，要先 fetch；
- 有 upstream 的分支，也拿 `ls-remote` 的值和 `refs/remotes/origin/<分支>` 比一次，不一致就标「本地记录过期」。

## 2. 开没开 PR：按自己的提交筛，每次重新枚举

给 leader 的「推了、还没开 PR」分支清单，是助手生成的，出过两次错。

### 按分支顶端作者筛，会漏掉别人追加过的分支

第一版按「远端分支顶端的提交是我」来筛，漏了 4 条。这 4 条分支上，leader 追加过提交：合主干、补数据、接着开发。顶端作者就不是我了，可分支里我那部分工作还没进主干。另外有一个本地 worktree 比远端多 1 个提交，只看远端也看不出来。

判据要换成「`主干..分支` 这段里有没有我的提交」：

```bash
TRUNK=origin/integration
ME='me@example.com'
git fetch -q origin
git ls-remote --heads origin | while read -r sha ref; do
  br=${ref#refs/heads/}
  mine=$(git log --format=%ae "${TRUNK}..${sha}" | grep -cxF "${ME}")
  [ "${mine}" -gt 0 ] && echo "${br}：含 ${mine} 个我的未合入提交"
done

# PR 按分支名匹配，全部状态都要
gh pr list --repo OWNER/REPO --state all --limit 400 \
  --json headRefName,state --jq '.[] | "\(.headRefName) \(.state)"'
```

- 主干按团队实际的工作流取，不一定是默认分支（怎么认，见[出 diff 前先定主干和起点](/blog/git-collab/diff-range-trunk-merge-base/)）。全部提交都已进主干的分支，自然落选；
- `gh pr list` 的 `--limit` 要盖住清单涉及的整段时间，否则旧 PR 被截掉，会误判成「没开 PR」；
- 给开 PR 的人附上每条分支 `git merge-tree --write-tree --name-only <主干> <分支>` 的结果：退出码 0 就是能干净合，否则列出冲突文件；
- 本地 worktree 再扫一遍：`git rev-list --left-right --count origin/<分支>...HEAD` 右边大于 0，就是「已提交未推送」，单独列出来，问过再推。

### 重新测量不等于重新枚举

几天后出第二版，助手用脚本重新采集：远端 head、PR 状态、试合并结果全是现采的，看起来「每次都重新量」。leader 看完回了一句：「这个分支没看到」（转述）。

漏掉的是中间新推的一条分支。采集脚本的分支范围，读的是上一版的数据文件。第一版的范围按任务题目归组定下来，之后每一版都继承了这个冻结的集合。脚本把状态做成了实测，把范围做成了常量，而且常量藏在上一版的输出文件里，看代码不显眼。

做法：

- 范围每次从远端重新算，用上面那段 `ls-remote` 加「含我的提交」的判据，这才是全集；
- 任务题目当「标签」用，不当「范围」用。新枚举出来、匹配不到任何题目的分支，单独列成「上一版之后新增」，让人决定归哪题，不静默丢掉；
- 第二版开头的「相对上一版的改动」，除了状态变化，还要列范围变化：新增了哪几条，哪几条已合并退出。拿两版的分支集合做差集生成这一段，不靠记忆。

## 3. 推送前算主干前进了多少，也用远端的 sha

推送前我会判断一次：主干在我切出来以后前进了多少，要不要先合主干再验一遍。有一次助手 fetch 之后数 `merge-base..origin/main`，得到 0，就推了。推完用 `ls-remote` 核对，主干其实已经前进了一大截，其中一个文件和这条分支在同一行各加了一项，要先合主干再重验。那次 fetch 为什么没更新本地的 `origin/main`，事后没查清。

所以这一步也按远端实况算：

```bash
REMOTE_MAIN=$(git ls-remote origin refs/heads/main | cut -f1)
LOCAL_MAIN=$(git rev-parse origin/main)
[ "${REMOTE_MAIN}" = "${LOCAL_MAIN}" ] || echo "本地 origin/main 过期，重新 fetch 后再算"
git rev-list --count "$(git merge-base HEAD "${LOCAL_MAIN}")..${LOCAL_MAIN}"
```

## 4. 把两个已开的 PR 合成一个：中间有竞态

**现象**：有一次要求「一次只交一个 PR」，我选了把两个已开的 PR 合成一个：往其中一个 force-push 两部分代码，再改 PR 描述。就在这两步之间，同事把这个 PR 合进了主干，合进去的是 force-push 之前的版本。结果只有一半代码进了主干，PR 描述却已经改成了「两件事都做了」。

想把另一个 PR 重开时，平台拒绝了：rebase 改写了它的 head，原来的 head 已经不存在，这个编号就此作废。

**根因**：force-push 和改描述是两个独立的动作，不是原子操作，中间任何时刻都可能有人点合并。PR 的 head 被改写以后，平台不允许重开已关闭的 PR（实测）。

**修复**：补救分三步：PR 描述还原，加一段勘误说明；作废的编号关闭，留言指向新 PR；剩下的代码从主干新开一个 PR。

以后的做法是：PR 的粒度在开之前和 reviewer 定好，已经开出去的让它们各走各的。确实要调整已开的 PR，先在评论里说明，确认没人正在合并再动手；关闭的 PR 如果还要重开，必须在 force-push 之前重开。

## 5. 「不推主干」拦不住自己开 PR 再自己合

**现象**：一条多语种文档同步分支，在没有任何评审的情况下进了文档站的主干。查记录：从建 PR 到合并只隔 26 秒，执行者是另一个编码代理的会话。我当时给它的原话是「把这个分支合入 main」。它跑了 `gh pr create` 加 `gh pr merge`，合并那一刻，它自己的审视笔记里还列着几项没核完。

文档站的主干就是线上，合进去当场生效。一周后 leader 看到了，评价是「很严重的流程问题」（转述）。事后复查又查出 1 处示例照抄会请求失败，十来处同页说法不一致，只能从当前主干另开分支修复。

**根因**：我的规则里写的是动作「不推 main」，不是职责「合主干归谁」。`gh pr merge` 不是 `git push`，推送前的闸和规则都没覆盖它。这条路之外还有 `gh api` 调合并接口、网页上的合并按钮。托管平台默认允许作者合自己的 PR；主干如果没开分支保护，就没有第二道门。代理把「合入 main」当成可以直接执行的指令，它不知道我本人也不是合并人。

**修复**：两层。

第一层是规则的写法。写成职责：「合主干归 leader，push、`gh pr merge`、API 合并、网页按钮，任何方式都不由我和代理执行。」我说「合入 main」，代理要理解成「准备好给 leader 合」：推分支（经我批准），写好合并顺序说明，然后停下，并说明为什么停。给子代理的简报里也写明「不开 PR、不合主干」。

第二层是执行前的守卫。Claude Code 的 PreToolUse hook 能在命令执行前读到命令文本，并返回拒绝（文档：Claude Code hooks 文档里 `permissionDecision` 的说明）。最小示例：

```python
import json, re, sys

cmd = json.load(sys.stdin).get("tool_input", {}).get("command", "")
deny = [
    r"(^|[;&|]\s*)gh\s+pr\s+merge\b",
    r"(^|[;&|]\s*)gh\s+api\b.*/(merges|pulls/\d+/merge)\b",
    r"(^|[;&|]\s*)git\s+push\b[^;&|]*\b(main|master)\b",
]
if any(re.search(p, cmd) for p in deny):
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": "合主干归 leader：只推分支，不合 main",
    }}))
```

第三条正则会误拦分支名里带 `main` 的推送，比如 `feature/main-page`。我选择宁可误拦：被拦下时看一眼原因，确实不是推主干就换个写法。守卫拦不住网页按钮，那一层只能靠平台的分支保护，这归仓库管理员。我能做的是在自己这一侧把命令行的几条路全部封上。hooks 的更多写法，见[用 Claude Code 的 hook 往对话里注入上下文](/blog/ai-workflow/claude-code-hooks-inject-context/)。

已经合进去的情况怎么办：先查清是怎么合进去的（PR 的创建和合并时间、合并人、会话记录），再以当前主干为准复查那次写进去的内容。修复放在从主干新切的分支上，同样不自己合。

## 6. 推送前的自检清单

每次推分支、交给别人开 PR 之前，我过一遍这张表。

| 检查项 | 怎么核 |
|---|---|
| 目标是不是主干 | 是主干就停，任何合并方式都不由我执行，只交分支和合并顺序说明 |
| 失败是不是我引入的 | 失败项在干净基线上复现过，区分存量和新增 |
| 每个改动的文件都是有意改的 | `git status`、`git diff --stat` 过一遍；包管理器顺手改的元数据（比如 lock 文件里自动补的字段）不提交 |
| 凭证没进仓库 | 当前文件里没有，历史里也没有：`git log -p -S '<key 前缀>' --all` |
| 分支基底和 PR 目标匹配 | 从 `main` 切出的分支 PR 到另一条长期分支，会带上 `main` 多出的全部提交 |
| 多仓库依赖顺序 | 上游先合，下游钉到合并后的版本再合；依赖的修复不在下游 vendor 里 |
| 基线前进了 | 主干 sha 用 `ls-remote` 取；先 `merge-tree --write-tree` 演一遍，再定 rebase 还是 merge |
| 挪完基线 | 生成物重跑并 diff；跑全量测试，没跑全量就不写「全过」 |
| 只验编译 | `go build -o /dev/null ./...` |
| 推送卡住 | 先 `ssh -v` 看卡在哪个阶段，再查 SSH 配置里这条路有没有走代理 |
| 推完 | `ls-remote --heads origin` 比对远端和本地 head，再写「已推送」 |

表里引用的几条展开讲过：基线和 diff 范围见[出 diff 前先定主干和起点](/blog/git-collab/diff-range-trunk-merge-base/)，依赖和多仓见[多任务并行的 git 用法](/blog/git-collab/worktree-multi-task/)，SSH 和代理见 [Mac 开发机的日常排障](/blog/tooling/mac-dev-machine-ops/)。

## 收尾

1. **状态只问远端** —— upstream 配置和 `origin/*` 都是本地记录，`ls-remote` 一次请求就能拿到全部分支的真实 head。
2. **查不到写「未知」** —— 把「查不到」当成「没有」，就会把已推送报成未推送。
3. **判据看自己的提交** —— 别人在你的分支上追加过提交，顶端作者就不是你了。
4. **范围每次重新枚举** —— 状态现采、范围沿用上一版，新推的分支永远进不了清单。
5. **规则写职责，守卫拦路径** —— 「不推 main」只封一条路，「合主干归 leader」才封得住全部。

回头看，这几件事都是把一个本地的、过去的记录，当成了远端的、现在的事实。现在我写任何「已推送」「没开 PR」「已合并」之前，先问自己：这句话的依据是这一刻从远端拿到的，还是本地存着的？如果是后者，先去问远端。
