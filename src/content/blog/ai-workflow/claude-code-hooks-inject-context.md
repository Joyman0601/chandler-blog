---
# import-articles-sha256: 9d632744b89acc7541889e689af75a2b359e09c0c685b1e8f1d775a24e928b6c
# Imported by scripts/import-articles.mjs from posts/ai-workflow/claude-code-hooks-inject-context.md
# Source date: 2026-09-30
title: "Claude Code hooks：提示拦不住命令，要拒绝一次"
description: "给 AI 编程助手装了几类 hook 之后的复盘：事前提示随结果一起到，拦不住这一次；失败的命令走另一个事件；大段输出会被截成预览；关键词规则要先拿历史会话回放调噪音。"
pubDate: 2026-08-22
tags: ["Claude Code","Hooks","上下文管理","AI 编程"]
series: ai-workflow
seriesLabel: "AI 辅助开发"
---

> 一句话总结：hook 是 Claude Code 在固定事件上确定执行的脚本，能把一段文字送进模型的上下文，比「希望模型自己想起来」可靠得多。但事前的提示拦不住正在执行的命令，要拦就返回一次拒绝；失败的命令走 `PostToolUseFailure`；单次输出太长会被截成预览（实测 8 KB 完整到达、1.5 万字符被截）；关键词规则要先拿历史会话回放，把噪音调掉再上线。

## 0. 起因：想让经验在「做到那一步」时自己出现

我用 Claude Code 做日常开发一个多月，攒了一个经验库（怎么搭的见[另一篇](/blog/ai-workflow/agent-knowledge-base/)），也写了几份很长的规范和检查清单。问题是它们只在模型「想起来」的时候才有用。skill 要等模型判断需要才加载；写在 CLAUDE.md 里的规则读过一遍，几百轮对话之后就淡了。

我要的是另一种东西：模型准备 `git push` 时，推送清单自己出现；测试失败时，「先在干净基线上复跑」自己出现；开始写某个页面文件时，这个文件该守的规则自己出现。这类「在某个时刻必须发生」的事，Claude Code 里只有 hook 能做。harness（Claude Code 的运行框架）在每个事件上都会确定地执行你配的命令。命令的输出可以作为上下文交给模型，也可以直接拒绝这次工具调用。

前后一个月，我在 Claude Code 里陆续挂了六道 hook，这篇讲其中四类：

- **经验卡片**：命令、报错、要写的文件路径命中某条经验的触发规则，就把那条经验的正文送进上下文；
- **读取守卫**：记下长文件实际读进了哪几行，被截断时提示分段重读，交回前核对「必读」有没有读全；
- **上下文闸**：上下文涨到一定程度先提醒落盘，再涨就拦下写操作，直到写好交接文件；
- **页面规范闸**：第一次写页面文件前，要求先整读规范并写出规则清单，之后每写一个文件弹出对应的检查卡。

下面讲做这些 hook 时踩的坑，以及事件怎么选。下面的结论除特别标注外都是实测，环境是 2026 年 9–10 月的 Claude Code。

## 1. 先搞清楚 hook 的输入和输出

hook 脚本从 stdin 读一段 JSON，向 stdout 打印一段 JSON。输入里常用的字段有 `session_id`、`transcript_path`（会话记录的路径）、`cwd`、`hook_event_name`、`tool_name`、`tool_input`；工具执行之后的事件还带 `tool_response`。

我用到的事件和用途：

| 事件 | 时机 | 我拿它做什么 |
|---|---|---|
| `SessionStart` | 会话开始 | 记会话开始时间，清理过期状态 |
| `UserPromptSubmit` | 发出一条消息时 | 按消息内容注入提示 |
| `PreToolUse` | 工具执行前 | 注入提示，或者拒绝这次调用 |
| `PostToolUse` | 工具成功之后 | 按输出注入提示，记下读了什么 |
| `PostToolUseFailure` | 工具失败之后 | 同上，专门接失败的命令 |
| `Stop` / `SubagentStop` | 主会话或子代理这一轮要结束时 | 该做的没做完就打回去 |
| `PostCompact` | 上下文压缩之后 | 把压缩摘要存成文件，清零提醒状态 |

配置写在 `settings.json` 的 `hooks` 段，按事件和工具名（`matcher`）挂命令：

```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash",
        "hooks": [{ "type": "command", "command": "python3 ~/hooks/deny_once.py", "timeout": 5 }] }
    ],
    "PostToolUse": [
      { "matcher": "Bash",
        "hooks": [{ "type": "command", "command": "python3 ~/hooks/on_output.py", "timeout": 5 }] }
    ],
    "PostToolUseFailure": [
      { "matcher": "Bash",
        "hooks": [{ "type": "command", "command": "python3 ~/hooks/on_output.py", "timeout": 5 }] }
    ]
  }
}
```

`matcher` 之外还可以加 `if`，写法和权限规则一样（`Read(~/notes/**)`、`Bash(git *)`），条件不满足时连进程都不起。

几条基础经验：

- 脚本自己兜住所有异常，以退出码 0 结束，错误写进日志文件。hook 报错会打断正常的工具调用。
- 一个启动 Python、再读几十个小文件的 hook，每次约 40–80 毫秒。挂在每条 Bash 上可以接受。
- 改 `~/.claude/settings.json` 里的 hook，正在运行的会话立即生效，不用重启。前提是会话启动时这个文件就已经存在。
- 先用管道喂一段假的 stdin 把脚本测通，再写进配置；写进去以后，用一条无害但能触发的命令确认它真的触发了。zsh 的 `echo` 会把 `\n` 转成换行，喂 JSON 要用 `printf '%s'`。
- hook 的输出在会话记录里是 `type: "attachment"` 的条目，不是 user 或 assistant 消息。按消息类型解析会话记录的脚本看不到它们。

## 2. 事前提示拦不住：要拦就拒绝一次

**现象**：第一版经验卡片挂在 `PreToolUse` 上，命中规则就返回 `additionalContext`。库里有一条经验说：`pnpm exec` 会先做依赖安装检查，只想起 dev server 时直接跑 `./node_modules/.bin/next dev`。演示时模型执行 `pnpm exec next dev`，卡片确实出现了，但出现在命令结果的旁边：命令已经跑完，端口没起来。模型当时的说明是「这一次命令已经跑了，提示拦不住它」。

**根因**：`PreToolUse` 返回的 `additionalContext` 不会阻止工具执行，它是和工具结果一起交给模型的。模型看到提示时，这一步已经发生了。对「执行后看报错」的提示，这没关系；对「执行前必须先看清单」的提示，就等于没有。

**修复**：要拦，就返回拒绝。

```json
{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "推送前先过一遍推送清单……过完原样重跑这条命令即可。"}}
```

命令不执行，模型把 `permissionDecisionReason` 当成工具报错收到，照着做完再重跑。为了不让同一条规则反复拦，我用「每个会话拦一次」：按会话 id 记一个标记，第一次命中返回拒绝，第二次放行。如果模型已经读过那份清单（另挂一个 `PostToolUse` + `Read` 的 hook 记下来），第一次也直接放行。

最小实现如下。`simple_commands` 是把整条命令拆成简单命令的函数，第 5 节给出：

```python
#!/usr/bin/env python3
"""PreToolUse（Bash）：命中规则的命令，每个会话先拒绝一次，理由里写清要先做什么。"""
import json
import os
import re
import sys
from pathlib import Path

from split import simple_commands

STATE = Path(os.environ.get("DENY_ONCE_STATE", Path.home() / ".cache/deny-once"))
RULES = [  # (规则名, 正则, 拒绝理由)
    ("push", re.compile(r"^git\s+push\b"),
     "推送前先过一遍推送清单（失败归属、仓库卫生、依赖顺序）。过完原样重跑这条命令即可。"),
]


def main():
    data = json.load(sys.stdin)
    if data.get("tool_name") != "Bash":
        return
    cmds = simple_commands(data.get("tool_input", {}).get("command", ""))
    sid = data.get("session_id", "unknown")
    for name, pat, reason in RULES:
        if not any(pat.search(c) for c in cmds):
            continue
        mark = STATE / f"{sid}.{name}"
        if mark.exists():              # 本会话已经拦过一次：放行
            return
        STATE.mkdir(parents=True, exist_ok=True)
        mark.touch()
        print(json.dumps({"hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": reason,
        }}, ensure_ascii=False))
        return


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:           # hook 自己出错，不能连累正常的工具调用
        with open(STATE.parent / "deny-once.err", "a") as f:
            f.write(f"{exc!r}\n")
    sys.exit(0)
```

拿假的 stdin 喂三次：同一会话的 `git -C repo push origin HEAD` 第一次被拒、第二次放行，`git commit -m "git push"` 不触发。

代价是每条命中的命令多一次重试，外加理由文字占的上下文。我当时的取舍是效果优先：宁可多一次重试，也要让经验赶在命令之前到。省的那一档也留着，一个开关改回去，就退成「照常执行、提示随结果到」。

同样的「拒绝」可以用在两个结束点上：

- `Stop` 打印 `{"decision": "block", "reason": "……"}`，模型这一轮不会结束，把 reason 当作反馈接着做；
- 子代理交回报告也是一次工具调用，`PreToolUse` 匹配它返回拒绝，子代理会照理由补做再交；`SubagentStop` 做兜底。

这两处一定要限次（同一件事最多拦 2 次），并留一个出口，比如回复里写一行「跳过：原因」就放行并记日志，否则可能死循环。另外，hook 输出里的 `systemMessage` 只显示在终端里给人看，不进模型上下文，适合用来告诉我「这里放弃核对了」。

## 3. 失败的命令走另一个事件

**现象**：有一条经验按报错原文触发：测试输出里出现 `--- FAIL:`，就提示「先在干净基线上复跑，再判断是不是存量失败」。如果只把它挂在 `PostToolUse` 上，测试失败时什么都不会出现。

**根因**：`PostToolUse` 只在工具成功时触发。退出码非 0 的 Bash 走的是 `PostToolUseFailure`，输出放在 `error` 字段里，不在 `tool_response` 的 stdout / stderr 里。最需要提示的，恰好是失败的那些命令。

**修复**：同一个脚本两个事件都挂，读输出时两个字段都看。

```python
def command_output(data):
    """PostToolUse 和 PostToolUseFailure 共用：取这条命令的输出文本。"""
    if data.get("hook_event_name") == "PostToolUseFailure":
        return str(data.get("error", ""))
    resp = data.get("tool_response") or {}
    return f"{resp.get('stdout', '')}\n{resp.get('stderr', '')}"
```

还有一个相关的坑：hook 拿到的工具结果也被截过。Bash 输出 96 KB 时，`PostToolUse` 收到的 `tool_response.stdout` 只有前 30,000 字节，截在字符边界上，里面也没有「输出太大、已另存」的标记。按输出内容判断的 hook 只看得到前 3 万字节；要判断「这次输出被转存了」，得看 stdout 的字节数是不是顶到了约 30,000。这个上限在[长规范那篇](/blog/ai-workflow/long-rulebook-partial-read/)里还会出现。

## 4. 输出也有上限：大段内容不走 hook

**现象**：经验库的第二版想在会话开始时把全部条目的目录注入进去，约 1.5 万字符。管道测试里输出完整，我就上线了。下一个会话开头才看到真实效果：这段输出被存成了文件，模型只拿到 2 KB 预览和一个文件路径。

**根因**：harness 对 hook 的单次输出有长度上限，超了就转存，只给预览。管道测试绕过了 harness，所以发现不了。实测 1.4 KB 到 8 KB 的输出都完整到达。

**修复**：

- 要常驻的大段内容（目录、规范）不走 hook。生成成文件，在 CLAUDE.md 里用一行 `@路径` 引入，随全局指令进每个会话的上下文。
- 走 hook 的内容自己控制总长。我设的是一次最多 9000 字符、最多 5 张卡片，放不下的卡片退成一句话摘要。
- 去重：同一会话里同一条只出现一次。

注入得多不等于有用。每条注入都占上下文，不相关的提示还会让模型学会忽略后面相关的那条。所以要有条数上限，还要记命中日志（只记时间、会话、规则，不记对话原文），后面调规则全靠它。

## 5. 关键词规则：先拿历史会话回放，再上线

经验卡片靠正则触发：命令以 `git push` 开头、输出里出现 `ERROR 1137 (`、要写的文件路径以 `.sql` 结尾……凭想象写的正则，大半是噪音。我的做法是上线前把历史会话全部喂给同一个匹配函数回放一遍，逐条看命中位置前后的原文，再收紧规则。

第一次回放用了 28 条规则、87 个历史会话。三轮下来，平均每个会话的触发数从 3.0 降到 1.8，剩下的逐条看过，都是该提示的地方。去掉的噪音有四类：

| 噪音来源 | 例子 | 处理 |
|---|---|---|
| 命令名出现在别的命令的参数里 | `grep -n "go build" Dockerfile`、`which ffprobe` | 规则以 `^` 开头，只从一条简单命令的开头匹配 |
| 出现在引号或 heredoc 的文字里 | 提交说明里写着 `git push` | 拆命令时引号里不拆，heredoc 正文丢掉 |
| 读到了记载这个错误的文档 | `cat` 一个注释里提到某个报错的 SQL 文件 | 报错规则写原样格式 `ERROR 1137 \(`，不只写错误码 |
| 信号太宽 | 单个 pid 的 `kill $p` 命中「列表变量不分词」 | 命令侧区分不出来就删，只留报错侧 |

「拆成简单命令」是这里的关键。最小做法：按未转义的 `;`、`&`、`|`、换行、括号、反引号切开，引号里不切，`2>&1` 里的 `&` 不算；heredoc 正文先整段去掉；每段再去掉 `sudo`、`nohup`、`do`、`VAR=x` 这类前缀，以及 `git -C <路径>`、`git -c k=v` 这类全局选项。

```python
import re

HEREDOC = re.compile(r"<<-?\s*(['\"]?)(\w+)\1[^\n]*\n.*?\n\s*\2[ \t]*(?=\n|$)", re.S)
LEAD = re.compile(r"^\s*(?:(?:sudo|nohup|time|then|do|else|exec)\s+|\w+=\S*\s+)*")
GIT_OPTS = re.compile(r"^git\s+(?:-[cC]\s+\S+\s+)+")


def simple_commands(command):
    """把一整条命令拆成简单命令：引号里不切，heredoc 正文先整段去掉。"""
    text = HEREDOC.sub("", command)
    parts, buf, quote = [], [], None
    i = 0
    while i < len(text):
        ch = text[i]
        if quote:                      # 引号里：只找配对的引号
            buf.append(ch)
            if ch == quote:
                quote = None
        elif ch in "'\"":
            quote = ch
            buf.append(ch)
        elif ch == "\\":               # 转义：连同下一个字符原样保留
            buf.append(text[i:i + 2])
            i += 1
        elif ch == "&" and text[i - 1:i] in (">", "<"):   # 2>&1 里的 & 不是分隔符
            buf.append(ch)
        elif ch in ";&|\n()`":
            parts.append("".join(buf))
            buf = []
        else:
            buf.append(ch)
        i += 1
    parts.append("".join(buf))
    out = []
    for p in parts:
        p = GIT_OPTS.sub("git ", LEAD.sub("", p)).strip()
        if p:
            out.append(p)
    return out
```

这样 `^git\s+push\b` 一条规则，既能命中 `for r in a b; do git -C "$r" push; done`，又不会被 `git commit -m "fix: git push hang"`、`grep -n "git push" notes.md` 或 heredoc 正文里的 `git push` 误触。这几个例子我都拿这段代码跑过。还有一个坑：引号状态一旦被带撇号的英文（don't）弄乱，后半条命令会整段失配，所以 heredoc 要先整体去掉，再做引号扫描。

回放工具要输出三样东西，缺一样都调不动：

1. 每条规则在多少个会话里触发，按会话去重，和线上的去重口径一致；
2. 每次命中位置前后几十个字符的原文，每条规则留两三个来自不同会话的例子；
3. 从未触发的规则清单。

回放必须调用和线上同一个匹配函数、同一套跳过条件，不另写一份，否则数字对不上。

回放有两个盲区：

- **只能量多报，量不了漏报**。历史里该提示却没有规则的地方，不会出现在回放结果里。漏报靠线上日志补：常被模型自己翻出来读、却从没提示过的条目，就该给它补规则。
- **预测会和上线后差好几倍**。「写文件前拦」回放预测每会话 2.4 次，上线后实际约 9 次：规则没变，变的是压缩次数，而「已提示过」的去重每压缩一次就清零。经过和对策见[上下文花费那篇](/blog/ai-workflow/context-compaction-cost/)的第 6 节；这里只记结论：改了压缩阈值，就要按真实的压缩点重新回放。

回放按消息触发的规则时，还要先剔掉不是我在主对话里亲手发的记录：子代理的任务书（`isSidechain: true`）、压缩后的摘要（`isCompactSummary: true`）、skill 展开的正文（`isMeta: true`）。它们在会话记录里也是 `type: user`，但不会触发 `UserPromptSubmit`。不剔的时候我数出 293 个「会话」、871 条消息，剔掉以后只剩 100 个主会话、662 条，频率被高估了约三倍。

## 6. 只挂 Write 和 Edit，会漏掉一半写入

按文件路径触发的规则（「写报告文件前先看某条」「写 SQL 前先看某条」），直觉上挂在 `Write|Edit` 上就够了。我拿 8 天的会话记录数了一下：经 Write / Edit 的写入约 2000 次，经 Bash 的写入（重定向、`tee`、`sed -i`、`cp`、`mv`、内联脚本写文件）约 1800 次，接近一半。

所以按路径触发的 hook 也要挂在 Bash 上，从命令里解析出写入路径。解析不可能百分之百准。我的做法是写一个「这条命令会被认成写哪些文件」的调试命令，拿历史会话里的真实命令回放核对。

反过来还有一个坑。有一道闸靠「本会话写过某文件」放行，比如「本会话写过审视清单，才允许派复核子代理」，它只看 Write / Edit 事件。模型用脚本把清单填完、机器检查全绿，去派子代理时被连拦两次，对清单做了一处真实的 Edit 之后才放行。文件是上一次会话（中断前）写的，也是同样的结果，因为闸只认本会话的事件。写闸的一方，判「写过」除了看工具事件，还要比文件的修改时间和会话开始时间；用闸的一方，要被闸认的文件，最后一次改动走 Edit。

## 7. 几类闸各挂在哪些事件上

| 闸 | 要解决的问题 | 挂的事件 | 动作 |
|---|---|---|---|
| 经验卡片 | 经验在做事的那一刻到场 | `PreToolUse`（Bash、Write、Edit、Skill），`PostToolUse` 和 `PostToolUseFailure`（Bash），`UserPromptSubmit` | 命令和写文件前拦一次；报错、消息命中时注入 |
| 读取守卫 | 长文件真的读全了 | `PostToolUse` 和 `PostToolUseFailure`（Bash、Read），`PreToolUse`（派子代理、子代理交回），`Stop`，`SubagentStop` | 记读取、被截断时提示分段；交回和结束前核必读 |
| 上下文闸 | 压缩前把真相落盘 | `UserPromptSubmit`，`PreToolUse`（写操作），`PostToolUse`（Write），`PostCompact` | 到软阈值提醒；到硬阈值拦写操作，只放行写交接文件；压缩后存摘要 |
| 页面规范闸 | 写页面前读全规范 | `SessionStart`，`UserPromptSubmit`，`PreToolUse`（Write、Edit、Bash 里的写入） | 第一次写页面文件先拦，要求写规则清单；之后按文件弹卡 |

选事件时我问自己三个问题：

1. **要赶在动作之前，还是事后提示就行？** 之前就用 `PreToolUse` 拒绝，事后就用 `PostToolUse` 注入。
2. **成功和失败都要管吗？** 要管失败，就把 `PostToolUseFailure` 一起挂上。
3. **这件事的「完成」落在哪个时刻？** 读全规范落在「写第一个页面文件前」，核必读落在「交回前」「这一轮结束前」，落盘落在「压缩前」。时刻找对了，闸才能只在该出现的地方出现。

页面规范闸还有一个省事的设计：从写入路径往上找规范文件，找得到才起作用。这样主仓和所有 worktree 都管，别的仓库零开销。

我还试过一种不挡输入的语义判断：hook 加 `"asyncRewake": true` 在后台跑，脚本里用 `claude -p --model haiku` 起一个小模型，对着全部条目挑和这条消息相关的；脚本以退出码 2 结束时，stderr 的内容会作为一条通知插进对话。几个实测细节：

- 子进程要加 `--setting-sources ""`，不加载我配的 hook，否则它会触发同一个 hook，无限递归；
- 关掉思考（环境变量 `MAX_THINKING_TOKENS=0`），一次从 9–24 秒降到 3–4 秒，答案一样，其中约 2.5 秒是命令行工具（CLI）自身的启动；
- 让小模型答编号，不要答路径，答路径时它会把目录名抄错；
- 插进来的通知会被当成我发的一条消息，再走一遍 `UserPromptSubmit` 的全部 hook，包括判断脚本自己，所以脚本要认出通知并跳过；
- 结果晚于回复到达时，会把模型叫醒多跑一轮，所以只在真有东西要说时才用退出码 2。

机制是通的，效果却不行：全开 8 天，抽样核对后不相关的超过一半，最后关掉了。经过和数据写在[经验库那篇](/blog/ai-workflow/agent-knowledge-base/)里。

## 8. 自动模式下，有几类操作只能交给人

最后一个坑和 hook 本身无关，但装 hook、迁移配置时一定会碰到。Claude Code 的自动模式（auto mode）用分类器审每条命令，有几类专门的拒绝：

| 被拒的操作 | 拒绝类别 |
|---|---|
| 覆盖项目的 `.claude/settings.local.json` | `[Self-Modification]` |
| 往 `~/.claude/projects/<派生名>/` 写 memory 或会话记录 | `[Session Transcript Tampering]` |
| 一条脚本批量 `rm -rf` 多处缓存 | `[Irreversible Local Destruction]` |
| 同一对话里被拒过一次之后，再用 `rm -rf` 删别的目录 | `[Auto-Mode Bypass]` |
| 停掉正在运行的容器、停 Docker Desktop | `[Interfere With Workloads]` |

这几类拒绝看的是结果，不看意图：我在对话里明说「我同意，你来做」之后，写 `~/.claude/projects/` 的命令照样被拒。拒绝说明里也写明了，同样的结果换个工具、拆小、换路径再做，都算绕过。

我的做法：

1. 计划里有这几类步骤，动手前就标成「人工执行」，不和正常步骤写在一条命令里，免得正常步骤陪着被拒。第一次迁移时，助手把装字体和换权限文件写进了同一条命令，整条被拒。
2. 其余步骤由助手照常做完。交给我的命令每行都能原样粘贴：真实路径，没有行尾注释，没有尖括号占位。
3. 删除、停服务这类，写成一个带 `--dry-run` 的脚本，每步先打印再执行，失败时打印还原方法，交给我跑一条命令。不碰服务的验证先做掉：`zsh -n` 查语法，在配置文件的副本上跑改配置的那一步。

## 收尾

1. **提示和拒绝是两件事** —— `additionalContext` 随结果到，拦不住这一次；要赶在动作之前，就返回一次拒绝。
2. **成功和失败分两个事件** —— 按报错触发的 hook 要同时挂 `PostToolUseFailure`。
3. **大段内容不走 hook** —— 实测 8 KB 完整到达、1.5 万字符被截成预览；常驻内容用 `@路径` 引入。
4. **规则先回放再上线** —— 用和线上同一个匹配函数；改了压缩阈值，再回放一次。
5. **写入不只走 Write 和 Edit** —— 接近一半的写入在 Bash 里。
6. **每道闸都要限次、留出口、兜住异常** —— 拦满两次放行，写理由可以跳过，脚本自己出错不能连累正常的工具调用。

回头看，做 hook 最费时间的不是写脚本，而是选时刻。同一条经验，放在命令执行后是噪音，放在执行前是帮助；同一份规范，开工时注入一次会被淡忘，写文件那一刻弹出对应的几条才有用。下次再想让 AI「记住」什么，我会先问两件事：它应该在哪个事件上出现，出现时要不要拦。
