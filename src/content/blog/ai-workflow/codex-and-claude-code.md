---
# import-articles-sha256: 19e806eee7fb0def28eaa0936096ef1562cd0e939c99e5c4abeafd8f99b8a33e
# Imported by scripts/import-articles.mjs from posts/ai-workflow/codex-and-claude-code.md
# Source date: 2026-10-15
title: "同一套流程搬到 Codex：skill、hook 和子代理的对应"
description: "我在 Claude Code 里用顺了一套 skill 和 hook，后来想让 Codex 在同一个工作区里照着跑。指令文件和 skill 格式基本通用，麻烦出在 hook 的工具名、加密的子代理消息和沙箱上；有一道搬过去的闸，派子代理那一步在 Codex 里从来没拦过。"
pubDate: 2026-09-18
tags: ["Codex","Claude Code","Skill","Hooks","多代理"]
series: ai-workflow
seriesLabel: "AI 辅助开发"
---

> 一句话总结：Claude Code 和 Codex 的指令文件、skill 格式、hook 事件大体能一一对上，照着搬就能跑起来，但「跑起来」和「真的生效」是两回事。hook 匹配的工具名、子代理消息能不能读、沙箱里能写哪里，都要在目标那边实测；我有一道搬过去的闸，因为工具名写错，派子代理那一步在 Codex 里一次都没拦过，也没报错。

## 0. 起因

我平时主要用 Claude Code，三周左右用顺了一套东西：全局的 CLAUDE.md 写工作约定；几个常用的 skill，其中代码审视是团队的，每日汇总和多窗口拆任务是我自己写的；还有一组 hook（读取守卫、审视闸、按关键词提示经验库条目）。10 月 11 日开始在同一个工作区里也用 Codex，我希望它照同一套流程干活，而不是另起一套规矩。

这篇按时间讲搬的过程：先对一遍概念，再搬两个 skill，再接 hook，最后让 Codex 自己复述一遍流程，用来查漏。文中「实测」指我在本机跑出来的，「文档」指两边官方文档的说法。

## 1. 先对一遍：两边的概念怎么对应

| 概念 | Claude Code | Codex | 依据 |
|---|---|---|---|
| 指令文件 | `CLAUDE.md`（全局在 `~/.claude/`，项目里一份） | `AGENTS.md`（全局在 `~/.codex/`，项目里一份） | 文档 |
| 生成指令文件 | `/init` | 也有一个内置的初始化提示：先查有没有 `AGENTS.md`，有就不动，没有才写一份贡献者指南 | 文档 + 实测 |
| skill | `SKILL.md`（`name`、`description`、正文），放在 `.claude/skills/` | 同样的 `SKILL.md` 格式，放在项目的 `.agents/skills/` 或用户级 skill 目录，用 `$名字` 调用 | 文档 + 实测 |
| 读文件 | 有 Read 工具，按 `offset` / `limit` 分段 | 没有 Read，全走 shell，输出上限是模型自己给的 `max_output_tokens` | 实测 |
| 改文件 | Edit / Write | `apply_patch` | 实测 |
| 子代理 | Agent 工具，带 `subagent_type` | `spawn_agent`，带 `task_name`、`message`，可以关掉继承父会话的上下文 | 实测 |
| hook | `settings.json` 里配 | `hooks.json` 里配，事件名基本相同（`UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`Stop`、`SubagentStop`），新 hook 要人在 `/hooks` 里信任一次，定义改了要重新信任 | 文档 + 实测 |
| 跨窗口传消息 | 同一个会话树里能列出其他代理、直接发消息 | 没有对应工具，改用登记表加只追加的 inbox 文件 | 实测 |
| 自动审批 | 自动模式下有分类器判断能不能执行 | 有一个审查代理，每次给出风险等级、授权程度、放不放行和理由 | 实测 |
| 常驻上下文 | 全局 CLAUDE.md 引入的经验库目录页常驻，hook 按关键词注入条目正文 | 不会自动注入，开工时要自己读 | 实测 |

两点补充：

- **我这边 Claude Code 也会读工作区的 `AGENTS.md`。** Codex 10 月 11 日在工作区根目录生成了一份 `AGENTS.md`，之后我把多窗口协作、本地 mock 测试的约定都追加在里面。翻会话记录发现，最近 40 个 Claude Code 会话里有 39 个，开头的上下文都带着这份文件（实测）。所以两边共用的规矩我只写在 `AGENTS.md` 一处；只对某一边成立的，才分别写进 `CLAUDE.md` 或 Codex 的全局 `AGENTS.md`。
- **两边都不让代理改自己的配置。** Codex 装 skill 时要往工作区根目录的 `.codex/`、`.agents/` 写入口，被自动审批拒了，这两个目录在当前权限下是只读的。Claude Code 的自动模式也一样，写它自己的设置文件和会话记录会被拒。所以凡是要动代理自身配置的安装步骤，我一开始就留给自己在终端里跑，代理只负责把命令写好交出来。

## 2. 搬第一个 skill：代码审视

团队的代码审视 skill 是按 Claude Code 的用法写的，`SKILL.md` 加一组检查卡和脚本。我问 Codex 能不能直接用，它的判断分得很清楚（实测，10 月 11 日）：

- **格式兼容**：`SKILL.md` 的结构符合 Codex 的 skill 规范。
- **但不会自动加载**：它放在一个普通项目目录里，Codex 只从 skill 目录里发现 skill。另外它引用了另一个复核 skill、hook 和外部脚本，要把这些依赖都接上才跑得完整。

搬的时候，审查方法本身一个字没改，只加了一层适配：

1. 在工作目录、几个主仓库和已有的 worktree 里装 skill 入口，一共 60 处。之后新建的 worktree 要再跑一次安装脚本才有。
2. 新写一份「Codex 执行约定」放在 skill 的参考目录里，`SKILL.md` 把它列为必读。约定里写了只有 Codex 才需要知道的事：用 `$名字` 调用；派子代理用 Codex 自己的参数，不要传 Claude 的 `subagent_type`；没有可用的独立子代理时，要明说复核这一步没做，不能把主会话的自审写成独立复核；hook 要人去 `/hooks` 里信任。
3. 写 12 个集成测试。

有一个意外收获：Codex 给适配层写测试时，顺带发现了原版检查器的两个漏洞，一个会放过缺了审查项的报告，一个是证据包没核对报告里写的基线分支（实测）。搬家相当于换一个人从头读一遍代码，原来没测到的地方会暴露出来。

这份「Codex 执行约定」后来在 Claude Code 这边惹了麻烦。我的读取守卫会核对 skill 里列的必读文件读没读全；Claude 会话用这个 skill 时，也被要求去读这份只对 Codex 有用的文件，一天里被拦了好几次，每次都得写一句「跳过必读：这份只适用于 Codex」才放行（实测，10 月 17 日）。后来改成在 `SKILL.md` 里分两行写：通用的必读一行，「必读（Codex）」另起一行，读取守卫只在 Codex 会话里认后一行。**只对某一个工具成立的说明，单独放一个文件，必读也只对那个工具生效。**

## 3. 搬第二个 skill：每日汇总

第二个是从会话记录汇总每天做了什么的 skill（做法见[从会话记录汇总每天做了什么](/blog/ai-workflow/daily-report-from-sessions/)）。这次我没让 Codex 改原版，只让它参照原版另写一个自己的（实测，10 月 12 日）。它改了这几处：

- **两种会话都读。** Codex 的会话记录按日期分目录存，每行是 `type` 加 `payload`，开头一条带 cwd 等会话信息；Claude Code 按项目分目录，每行是 `type`、`message`、`timestamp`。新版两种都解析，跨天和时区的处理照原版。
- **查不到的写「未统计」。** 试跑时发现有的仓库没配作者身份，按作者数提交会数出 0。它改成显示「未统计」，免得把「没法数」报成「没有」。
- **远端查询失败就标「未知」**，不当成没有。
- 生活类话题留到成稿时再按语义过滤，脚本里不硬写。

一共 12 项测试。到这一步，两边就有了两个**同名**的 skill，背后是两份实现。一周后这件事咬了我一口，见第 5 节。

## 4. hook：先以为 Codex 没有，其实早就接上了

10 月 15 日我在 Claude Code 里做读取守卫：模型声明要「读全」的文件，hook 在每轮结束前、子代理交回前，按会话记录核对哪些行真的进了上下文，没读全就打回去补读。做完写总结时，Claude 写的是「Codex 不支持 hook，那边只能看它自己写的回执」。

这句话是错的。接着排优化项时，它去翻 Codex 的配置，发现 hook 功能已经是稳定版，本机早就挂着 hook 在跑，审视闸的日志里还有拦截记录，正是 10 月 11 日搬代码审视 skill 时装的（实测）。Claude 对另一个工具的了解是旧的，所以**对方支不支持某个功能，要看对方的配置和日志，不能凭印象。**

既然能接，就先量 Codex 那边读文件的情况（实测，截至 10 月 15 日）：70 个会话、6187 次工具输出，其中 711 次被截断，56 个会话碰到过。截法是从中间砍，只留头尾，中间换成一行「…N tokens truncated…」。被截的输出上限就是模型自己给的 `max_output_tokens`，多数在 1000–5000，最多约 1 万。被截得最多的恰好是最需要读全的：`SKILL.md`、审视报告、多窗口协作约定。

Codex 这边的修法是在全局 `AGENTS.md` 里写一条读法规则，我现在用的是这样：

```markdown
## 读文件要读全

- 规范、清单、SKILL.md 这类要读全的文件：一段一条 `sed -n '起,止p' <文件>`，每段不超过约 2 万字节，`max_output_tokens` 给 10000。不要 `cat` 整份，也不要把几段拼进一条命令。
- 输出里出现 `tokens truncated` 或 `truncated output`，就是这一段没读全：缩小范围重读，不要拿着头尾继续干。
- 写了「必读」的文件就读全，不要先读一部分，再看会不会被拦。
```

写进去之后，截断比例的变化（实测，10 月 23 日重跑）：

| 时间段 | 有工具输出的会话 | 工具输出 | 被截断 | 比例 |
|---|---|---|---|---|
| 10-11 到 10-14 | 62 | 6095 | 692 | 11.4% |
| 10-15（当天改规则） | 18 | 179 | 22 | 12.3% |
| 10-16 之后 | 33 | 5231 | 145 | 2.8% |

前后跑的任务不一样，不能全算在这条规则头上，但方向是对的。统计脚本很短，可以直接拿去查自己的 Codex 会话：

```python
"""数一数 Codex 会话里有多少次工具输出被截断，以及被截的那次调用读的是哪些文件。"""
import collections, json, re, sys
from pathlib import Path

TRUNC = re.compile(r"tokens truncated|truncated output")
DOC = re.compile(r"[\w./~-]+\.(?:md|txt|json|patch)\b")

root = Path(sys.argv[1] if len(sys.argv) > 1 else "~/.codex/sessions").expanduser()
total = cut = 0
sessions = set()
docs = collections.Counter()
for f in root.rglob("*.jsonl"):
    calls = {}
    for line in f.open(encoding="utf-8", errors="replace"):
        try:
            r = json.loads(line)
        except json.JSONDecodeError:
            continue
        if r.get("type") != "response_item":
            continue
        p = r.get("payload", {})
        kind = p.get("type", "")
        if kind in ("custom_tool_call", "function_call"):
            calls[p.get("call_id")] = str(p.get("input") or p.get("arguments") or "")
        elif kind.endswith("_call_output"):
            total += 1
            out = p.get("output")
            out = out if isinstance(out, str) else json.dumps(out, ensure_ascii=False)
            if TRUNC.search(out):
                cut += 1
                sessions.add(f.name)
                for d in set(DOC.findall(calls.get(p.get("call_id"), ""))):
                    docs[Path(d).name] += 1

print(f"工具输出 {total} 次，被截 {cut} 次（{cut / max(total, 1):.0%}），涉及 {len(sessions)} 个会话")
for name, n in docs.most_common(5):
    print(f"  {n:>4}  {name}")
```

文件名那一栏只能当线索：Codex 一次工具调用常常并行跑好几条命令，命令里出现过的文件都会被算进去，不一定就是被截的那个。

接 hook 的过程中，又碰到四处和 Claude Code 不一样的地方，全是实测出来的（Codex 0.162.1）：

1. **派子代理的工具名对不上。** hook 收到的工具名是命名空间和工具名直接拼在一起的 `collaborationspawn_agent`，照文档写的 matcher `collaboration\.spawn_agent` 匹配不到。
2. **派子代理的消息是密文。** 不管是 hook 收到的，还是会话记录里存的，`message` 字段都是一串 `gAAAA…` 开头的密文。在 Claude Code 里，我是把「必读：…」写进子代理提示词，让 hook 去读；在 Codex 里谁也读不到这一行。改成派之前，父线程先跑一条登记命令，hook 按明文的 `task_name` 去查登记。
3. **命令跑在沙箱里。** 那条登记命令写不了 `~/.claude` 下的状态目录，所以它只把登记打成一行输出，由跑在沙箱外的 hook 去父线程的会话记录里找。
4. **`codex exec --json` 里看不到 hook 给人看的提示。** Claude Code 会在终端显示一行「Stop says: …」，Codex 的非交互模式下没有。

还有一处两边都适用：我一开始在 `AGENTS.md` 里写了「这次确实用不上，就写一行『跳过必读』」这个出口，结果模型还没被拦，就先写了一行跳过。删掉以后，这个出口只出现在 hook 的拦截消息里（实测）。**给模型的常驻规则里不要写「可以不做」的出口，出口只在拦下它的那一刻给。**

最要命的是第 1、2 两条的连带后果：10 月 11 日搬过去的审视闸，matcher 用的是同样的写法，检查的又是 `message` 字段。所以派审视子代理那一步，它在 Codex 里**从来没拦过**，也从来没报过错（实测）。闸不触发是不会报错的，只能拿一个「应该被拦」的用例在目标环境里跑一遍，看它拦不拦。

## 5. 让 Codex 复述一遍流程，查出我文档里的错

10 月 19 日，我让 Claude 写了一份给其他代理读的文档，讲这台机器上做工作任务时 skill 怎么串着用：分几个阶段，每个阶段用哪个 skill，哪几步有闸。发给 Codex 时，提示词末尾加了一段，要它先复述、别动手：

```text
读完先不动手，回我四行：
1. 我手上的任务属于哪一类，要走哪几个阶段；没有任务就写「暂无」。
2. 每个阶段用哪个 skill，以及各自 SKILL.md 的绝对路径。
3. 哪几步有闸会拦。
4. 文档里和你当前环境对不上的地方（路径不存在、skill 不在列表里）；没有就写「无」。
```

前三行用来看它读懂没有，答错一眼就能看出来。真正有用的是第 4 行。Codex 回了两处（实测）：

- 它那边还注册了一个每日汇总的 skill，可我在文档里写的是「其余 skill 没有 Codex 版」。这就是第 3 节那个同名、两份实现的 skill。
- 它那边经验库的目录不会自动注入，文档没交代 Codex 开工时怎么调经验。

我让 Claude 逐个核了 Codex 实际的 skill 目录和 hook 配置，文档的错比 Codex 指出的还多。这套工作流程里我在 Claude Code 这边一共挂了六道 hook：读取守卫、审视闸、经验库提示、项目说明卡片、页面规范闸、上下文闸（[hook 那篇](/blog/ai-workflow/claude-code-hooks-inject-context/)讲的是其中四类，没讲审视闸和项目说明卡片）。Codex 里只接了两道，读取守卫和审视闸；另外四道都没有。项目说明卡片在 Claude Code 里靠 hook 自动推，在 Codex 里是另一个按需调用的 skill。

错的根源是写文档时，照着 Claude 这边的配置去推 Codex 那边。**把流程搬到另一种代理上，先列清它实际装了哪些 skill、挂了哪些 hook，再写说明；同名的 skill 在两边可能是两份实现，要写清楚以哪份为准。**

## 6. 我现在怎么分工

这一节不是哪个工具更好的结论，只是我目前的用法。

- **Codex** 主要跑流程已经定好的任务：每日汇总、按回归规范跑一遍测试、调研类的读文档，还有多窗口任务（10 月 14 日那次 7 个窗口全开在 Codex 里）。多窗口时我在第一条消息里给每个窗口一个「逻辑身份」，窗口之间靠登记表和 inbox 文件传消息（细节见[多窗口并行开发](/blog/ai-workflow/multi-window-parallel-dev/)）。
- **Claude Code** 是新规矩先落地的地方：读取守卫这类闸大多先在这边写好、测好，再接到 Codex 上（Codex 那边的适配层有的是 Codex 自己写的，见第 2、3 节）。原因很实际，第 5 节数的那六道 hook 在 Claude Code 里都有，Codex 只接了两道，新规矩在 Claude Code 里先拦得住，我才放心往外搬。

## 收尾

把一套 skill 和 hook 从 Claude Code 搬到 Codex（或者反过来），我现在按这张清单走：

- [ ] 先列目标那边**实际**的 skill 目录、hook 配置、指令文件，不从这边推。
- [ ] 两边都要守的规矩写进共用的 `AGENTS.md`；只对一边成立的写进各自的全局文件。
- [ ] skill 的方法不动，只加一份「某工具执行约定」放在参考目录里；必读只对那个工具生效。
- [ ] 同名 skill 在两边是不是同一份实现，写清楚以哪份为准。
- [ ] hook 的 matcher 用目标那边 hook 实际收到的工具名，别照文档写；拿一个「应该被拦」的用例在目标环境里跑一遍，确认真拦。
- [ ] 子代理的消息在目标那边读不读得到；读不到就在派之前用命令登记。
- [ ] 要动代理自身配置的安装步骤（工作区的 `.codex/`、`.claude/` 设置）留给人做，代理交出可以原样粘贴的命令；新 hook 要人去信任。
- [ ] 读文件的规则写进全局指令：分段读，每段给够输出上限，看到截断标记就重读。
- [ ] 让目标代理读完说明先复述四行，第 4 行专门问「和你的环境对不上的地方」。

搬家本身不难，概念几乎能一一对上。难的是对上之后，有几处看起来对、其实没生效，而且不报错。读取守卫和 hook 的写法见[用 hook 往对话里注入上下文](/blog/ai-workflow/claude-code-hooks-inject-context/)，长文件被截断的问题见[长规范只读了一部分](/blog/ai-workflow/long-rulebook-partial-read/)。
