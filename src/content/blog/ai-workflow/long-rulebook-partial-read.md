---
# import-articles-sha256: b5b3219df32ed3a7a817c027edfb3d489dcc6e3f51d85c32143175e73de66bdf
# Imported by scripts/import-articles.mjs from posts/ai-workflow/long-rulebook-partial-read.md
# Source date: 2026-10-06
title: "长规范只读了不到三分之一就开工：规则清单、检查卡和读取守卫"
description: "一份近九百行的页面规范，AI 每次都挑两节读完就动手。翻会话记录查到它读了哪几行，再把「整读」做成留下文件的动作，让规则在写文件那一刻出现；后来又发现工具会截输出，读全要由 hook 按读取记录核。"
pubDate: 2026-08-27
tags: ["Claude Code","Hooks","上下文管理","前端","AI 编程"]
series: ai-workflow
seriesLabel: "AI 辅助开发"
---

> 一句话总结：AI「记不住长规范」，多数时候不是记不住，而是根本没读到。先翻会话记录，查规范被谁读了哪几行；再把「整读」做成一个会留下文件的动作，让规则在写对应文件的那一刻出现；最后别信「已读完」这句回执，要用 hook 按真正进了上下文的行去核。

## 0. 起因：规范写得很清楚，页面照样漏

前端有一类页面，我们有一份很长的规范：889 行、约 96 KB，306 条规则。其中只有 16 条有契约测试盯着，其余全靠读的人照做。新建或迁移一个这类页面时，我让 AI 先读规范再动手。交出来的页面却总有规范里明文规定过的问题：标题层级不对、区块顺序不对、多语言词表漏了几项。每次都不一样，但每次都有。

我最初的猜测，和很多人一样：规范太长，上下文太长，模型记不住。顺着这个思路，能想到的修法是「压缩前重读一遍」「把规范拆成几个小文件」。

这两个修法都没做。先做的是另一件更便宜的事：翻会话记录，看规范到底被读了哪几行。

## 1. 先查会话记录：规范到底被读了哪几行

Claude Code 的会话记录是 JSONL（每行一个 JSON 对象）格式：每行一条记录，模型发起的工具调用在 `type: "assistant"` 记录的 `message.content` 里，是 `type: "tool_use"` 的块，`input` 里就是参数。所以「谁读了这个文件、读了哪几行」可以直接从记录里抽出来。子代理的记录在主会话记录旁边的 `subagents/` 目录下，一起扫。

```python
#!/usr/bin/env python3
"""列出历史会话里对某个文件的每一次读取：谁读的、用什么读的、读了哪几行。

  python3 who_read.py <文件名片段> ~/.claude/projects/<项目目录>/*.jsonl
子代理的记录在「主会话记录去掉 .jsonl」/subagents/ 下，一起传进来就行。
"""
import json
import re
import sys

SED = re.compile(r"sed\s+-n\s+['\"]?(\d+),(\d+)p")


def reads(path, target):
    for line in open(path, errors="replace"):
        try:
            rec = json.loads(line)
        except ValueError:
            continue
        if rec.get("type") != "assistant":
            continue
        for block in rec.get("message", {}).get("content", []) or []:
            if not isinstance(block, dict) or block.get("type") != "tool_use":
                continue
            inp = block.get("input", {})
            if block.get("name") == "Read" and target in inp.get("file_path", ""):
                start = inp.get("offset", 1)
                yield "Read", f"{start}–{start + inp['limit'] - 1}" if "limit" in inp else f"{start}–末尾"
            elif block.get("name") == "Bash" and target in inp.get("command", ""):
                cmd = inp["command"]
                spans = [f"{a}–{b}" for a, b in SED.findall(cmd)]
                yield "Bash", "、".join(spans) or cmd[:60]


if __name__ == "__main__":
    target, files = sys.argv[1], sys.argv[2:]
    for f in files:
        for tool, span in reads(f, target):
            print(f"{f.rsplit('/', 1)[-1][:8]}  {tool:4}  {span}")
```

这只是第一步的粗筛：它记的是「发起了读取」，不是「读到了」。后者要看工具结果，第 5 节会说到。

跑出来的结果很整齐（实测）：最近五次做这类页面的会话，规范每次的读取范围几乎一样，都是两条 `sed -n`：第 19–139 行（第 0 部，共用硬规则）和第 598–720 行（搭建模板）。加起来 244 行，不到全文的三分之一。页头、几个功能区块、多语言细则所在的那几部，在主会话里一次都没打开过。

也就是说，「记不住」解释不了这里的问题：大半份规范根本没进过上下文。

## 2. 五个叠加的原因

继续往前翻，看这个范围是怎么定下来的。原因有五个，按影响排：

1. **规范的前言把两节标成了总纲。** 前言醒目地把第 0 部称为硬规则、把第 4 部称为操作清单。模型很自然地把这两节当成摘要，把其余当成可以跳过的细则。写规范的人本意是导读，读规范的模型拿它当目录裁剪。
2. **读取范围是模型自己定的，而且定在开工之前。** 我让一个窗口给另一个工作窗口写任务提示，读哪几行就是那份提示里写好的。后面的窗口照提示读，错误在提示写成时就已经发生了。
3. **子代理代读，再转述。** 有几次是让一个通用子代理分段读完规范，再交回一份摘要。摘要把「至少 3 个 H2 要带上主名词」压成了「遵守标题层级」，细节在转述时丢了。子代理交回的东西天然是摘要，规范里最值钱的恰恰是那些具体的数字和枚举。
4. **读和写隔得很远。** 规范在会话的第 100 条消息左右读，页面在第 400 到 1200 条之间写，中间经过压缩。这条成立，但它只解释「读过的为什么丢」，解释不了「没读过的」。
5. **规范按页面区块组织，干活按文件组织。** 写一个配置文件时，和它有关的规则散在规范的五处。写那个文件的那一刻，没有谁会回头把五处都翻一遍。

前三条是「没读到」，后两条是「读到了也会丢」。所以单做「压缩前重读一遍」不够，只能补第 4 条。

## 3. 第一件事：整读，并落成一份规则清单

「整读」如果只是一句要求，最后会被执行成一句「已读完」。所以我把它做成一个会留下文件的动作：

- 开工时，主会话自己用 Read 读完这次要用到的整部：共用部、本页型对应的部、对应的搭建模板、词表附录；
- 读完写一份 `<页面>.rules.md`，每行一条：规范节号、一条能打勾的断言、落点文件、状态；
- 不让子代理代读规范再转述。

```markdown
| 节号 | 断言 | 落点文件 | 状态 |
|---|---|---|---|
| 2.3 | 页面至少 3 个 H2，每个都带页面主名词 | content.ts | ☐ |
| 2.7 | 区块顺序：概览 → 示例 → 参数 → 常见问题 | page.tsx | ☐ |
| 5.1 | 新增的文案键在全部语种的词表里都有 | i18n/*.json | ☐ |
| 6.4 | 新页面在站点地图和导航登记处都登记了 | registry.ts | ☐ |
```

这份文件有三个用处：压缩之后能重读，而且比规范原文短得多；交付时逐条引用它，哪条没做一眼可见；它本身就是「读过」的证据。写不出断言的那几节，说明没读，或者没读懂。

## 4. 第二件事：按文件的检查卡，在写文件那一刻出现

规则清单解决「读没读」，解决不了第 5 条「写的那一刻想不起来」。所以第二件事，是把规范按「要写的文件」重排成二十来张检查卡：配置、文案、各功能区块、登记点……每张只有断言和节号，不复述原文。

卡片是从规范派生出来的，规范一改，卡片就可能过时。所以每张卡的 front matter 记下它引用的规范标题，用脚本核对这些标题在规范里还在不在。这一步真抓到过问题：有一批卡最早是从规范的一份旧副本派生的，几个标题后来已经改了名。

然后用一个 `PreToolUse` 的 hook，在写文件的那一刻把卡片送进去。匹配 Write、Edit，也匹配 Bash 里的写入（`>`、`tee`、`sed -i`、`cp`、`mv`）。只挂 Write 和 Edit 会漏掉一半写入，见 [hooks 那篇](/blog/ai-workflow/claude-code-hooks-inject-context/)的第 6 节。它只在「从写入路径往上找得到这份规范」的仓库里起作用，所以主仓和所有 worktree 都管，别的仓库零开销。

判断逻辑写成最小形式是这样：

```python
def on_pre_write(path, session):
    repo = walk_up_until(path, has="docs/page-spec.md")   # 找不到规范：不是这类仓库，放行
    if not repo or not in_scope(path):
        return None
    if not session.passed:
        if fresh_rules_file(repo, since=session.started):   # 本会话写过规则清单：放行
            session.passed = True
        elif session.denies < 2:                            # 最多拒两次，防止卡死
            session.denies += 1
            return deny(kickoff_card(ranges_from_headings(repo), kind_of(path)))
    return inject(cards_for(path, kind_of(path)) - session.shown)   # 每张卡一个会话只出现一次
```

几个细节：

- **拒绝理由里给出要读的行号范围**，而且是按规范当前的标题现算出来的，规范改了也不会指错位置。
- **只拒两次。** 两次之后放行，并在日志里记一笔。闸本身出错时，宁可漏拦，也不能把人卡死。
- **判「本会话写过规则清单」不能只看工具事件**：清单可能是用脚本写的，或者上一个中断的会话写的。所以 `fresh_rules_file` 比的是文件修改时间和会话开始时间。

装好的当天，它在搭建它的那个会话里就真的拦下了两次页面写入（实测），拒绝理由里的行号范围和规范当前的标题对得上。

## 5. 另一种漏读：工具把输出截了

一周多以后，我在另一组文件上碰到了同样的症状：审视清单写得很清楚，复核结果却漏掉其中一段规则。这次的猜测是「文件太大」，提的修法是按约 400 行拆文件。

还是先查记录。这次我回放了全部会话记录（约 150 个主会话、310 个子代理）里读规则文件的工具调用，在工具结果里找截断标记。找到三道硬上限（实测）：

| 通道 | 上限 | 超了之后模型看到什么 |
|---|---|---|
| Bash 输出（`cat`、`sed -n`） | 约 30,000 字节 | 前 2 KB 预览，加一个全文另存的路径 |
| 命令以非零退出码结束 | 输出截到 10,000 字符 | 头尾都在，中间少一段，只留 `[N characters truncated]` |
| Read 工具 | 25,000 token | 直接报错，要求带 offset / limit 分段 |

实际撞上的情形：

- **拼接命令失败，后半截没执行，中间又被截。** 一个复核子代理读规范时自己拼了 `sed -n …; echo ======; sed -n …`。zsh 里以 `=` 开头的词会被当成「去查这个命令的路径」，`echo ======` 直接报错；同一行后面读附录的那条 `sed` 就没执行（细节见 [zsh 展开那篇](/blog/tooling/zsh-expansion-gotchas/)）。命令失败又触发 1 万字符截断，中间一段规则也没了。连续 5 次复核都是这样，没有任何报错提示让人发现。被从中间截断的 25 次输出里，23 次是失败的命令，15 次是这种 `echo =====` 拼接。
- **一次 `cat` 超过 30 KB，只拿到预览。** 规则文件被转存 22 次。多数后来用 Read 读了转存文件；也有 4 个子代理之后再没读，拿着 2 KB 预览接着干。

写这篇文章时，帮我整理素材的助手自己又踩了一次：它想对照两个脚本的开头，顺手敲了 `sed -n 1,45p a.py; echo =====; sed -n 1,80p b.py`，得到 `==== not found`，第二个文件没读到。

「按 400 行拆」为什么不行：上限按字节算，不按行。我量过，中文为主的 Markdown 大约 108 字节一行、2.2 字符一个 token。30 KB 的 Bash 上限在密集的规范里约等于 280 行，在每行都是长表格的文件里不到 170 行。按行数定拆分线，有的块超限，有的切得过碎。

修法：

1. 规则文件用 Read 读，不用 `cat` / `sed` 拼接；需要分段时用 offset / limit，一段控制在 2 万字节以内。
2. 拆文件按标题拆，单位用字节，并配一份 manifest 列全「第 k / N 段」。
3. 给子代理的提示里写明读取方式（「用 Read 读 X，分 N 段」）；真要分隔，用 `printf '%s\n' '-----'`。
4. 结果里出现 `Output too large`、`characters truncated`、`exceeds maximum allowed tokens` 任一个，就当这次没读。

分段计划可以用脚本算，按标题切，每段不超过 2 万字节：

```python
#!/usr/bin/env python3
"""把一份长 markdown 按标题切成若干段，每段不超过 MAX 字节，打印 Read 的 offset / limit。"""
import re
import sys

MAX = 20_000          # 低于 Bash 输出约 30,000 字节的转存线，给行号前缀和长行留余量
PREFIX = 8            # Read 每行带行号前缀，按多 8 字节估


def cost(line):
    return len(line.encode()) + 1 + PREFIX


def plan(path):
    lines = open(path, encoding="utf-8").read().split("\n")
    heads = [i for i, s in enumerate(lines) if re.match(r"#{1,3}\s", s)] + [len(lines)]
    segs, start, size = [], 0, 0
    for a, b in zip([0] + heads, heads):           # 以「一个标题到下一个标题」为单位往段里装
        block = sum(cost(s) for s in lines[a:b])
        if size and size + block > MAX:
            segs.append((start, a))
            start, size = a, 0
        size += block
        while size > MAX:                          # 单节本身超限：按行硬切
            cut, acc = start, 0
            while cut < b and acc + cost(lines[cut]) <= MAX:
                acc += cost(lines[cut])
                cut += 1
            if cut == start:                       # 一行就超限：只能单独成段
                acc, cut = cost(lines[cut]), cut + 1
            segs.append((start, cut))
            start, size = cut, size - acc
    if start < len(lines):
        segs.append((start, len(lines)))
    return segs


if __name__ == "__main__":
    segs = plan(sys.argv[1])
    for k, (a, b) in enumerate(segs, 1):
        print(f"{k}/{len(segs)}  Read offset={a + 1} limit={b - a}")
```

拿一份 28 KB 的计划文档试，它切成 1–63 行和 64 行起两段，切点正好落在一个二级标题上；拿一份「一行 3 万字节 + 400 行中文」的构造文件试，超长的那一行单独成段，其余每段都在 2 万字节以内，段与段首尾相接、不重不漏。

这些规则也不全靠模型自觉。我把它挂成 `PostToolUse` + `PostToolUseFailure` 的 hook：读文档的命令一被截，就把这份分段计划注入进去。判「被转存了」要看字节数，不能找标记：交给 hook 的 stdout 只有前 30,000 字节，里面没有 `Output too large` 字样。

## 6. 「读全」由 hook 按读取记录核

到这里还剩一个口子：「已读 1–N/N 段」是模型自己写的回执，写了不等于读了。

所以同一个 hook 再多做一件事：按会话和代理 id，记下真正进了上下文的行。对 Read，就是工具结果里返回的起始行和行数；对 `sed -n`、`cat`、`head`、`tail`，只认没被截断、没接管道、没重定向的那些。核对时，拿要求读的分段和这些行的并集去比，逐段报「没读」或「缺第 x–y 行」。读法不重要，模型怎么分段都行，只看并集。

拿同一个证据包试过（实测）：按分段 Read 的子代理核出来读全 8/8 段；按要求 `cat` 整份规范的那个子代理只核出 3/8 段，规范的 5 段全是「没读」，它自己也承认只看到了预览。

核对要自动触发，不能靠「记得跑一下」。约定是：skill 正文、给子代理的任务提示、交接给新窗口的消息里，都单独写一行 `必读：路径……`（没有也写「无」）。hook 在两个时刻拿读取记录去比：

- **子代理交回前**：交回也是一次工具调用，`PreToolUse` 匹配它，没读全就拒绝，理由里给出补读的段；`SubagentStop` 兜底；
- **主会话每轮结束前**：`Stop` 返回 `{"decision": "block", "reason": …}`。

同一处最多拦 2 次。主会话确实用不上某份必读时，可以在回复里写一行「跳过：原因」放行，记进日志。实测：一个子代理只读了前 10 行就想交回，被拦一次，照给出的两段补读，然后改了结论再交；我发的消息里带了必读、模型没读就想结束，也被拦了一次。

压缩还要单独处理。压缩之后，压缩前读过的原文只剩摘要。所以会话记录里每个压缩边界开一个新窗口，读取只认本窗口的；压缩前还在用的必读，压缩后要重读。必读可以写成 `路径#标题`，只要求这一节，标题挪了行号跟着走。

长资料在压缩后整份重读，代价不小（压缩后的重读占了多少，见[上下文花费那篇](/blog/ai-workflow/context-compaction-cost/)第 6 节）。我现在在试另一种做法：8 KB 以上的必读资料，读全后写一份要点清单，照原文摘，每条标原文行号范围，行号要盖全原文。压缩后只要求读这份清单，用到哪节再回原文读；交付前另派一个新上下文的子代理拿原文核交付物。这个做法还在试行，效果还没有结论。

## 7. Codex 也一样，只是截法不同

Codex 那边截断的样子不同：输出截在模型自己给的 `max_output_tokens` 处，也是从中间砍。我统计了 70 个会话、6187 次工具输出，711 次被截（实测）。它没有 Read 工具，读文件全走命令，所以写法是在全局 AGENTS.md 里明确要求先出分段计划，再一段一条 `sed -n`，`max_output_tokens` 给到 10000。写了之后，模型就照着分段读全了。

Codex 的子代理任务消息在 hook 收到时是密文，写在消息里的必读行谁也读不到，只能在派子代理之前，由父线程用一条命令把必读登记下来。两边工具的其他差异，写在[另一篇对比](/blog/ai-workflow/codex-and-claude-code/)里。

## 收尾

AI 漏了长文档里的规则，别急着下「记不住」的结论。按这个顺序查：

1. **查读了哪几行**：从会话记录里抽出对这个文件的每一次读取，主会话和子代理都算。没读到的，谈不上记住。
2. **查是谁定的范围**：任务提示、规范前言、子代理转述，都可能在开工前就把范围裁掉了。
3. **查读到的有没有被截**：工具结果里找截断标记；拼接命令和失败命令最危险。
4. **把「读」做成产出物**：读全之后写规则清单，每行一条能打勾的断言。
5. **让规则在写文件的时刻出现**：按文件重排成检查卡，hook 在写入前送进去。
6. **「读全」交给机器核**：按真正进了上下文的行算，在交回前、每轮结束前自动核。

回头看，这件事里最有用的一步是最便宜的那一步：花十分钟翻会话记录。它把「模型记不住」这个没法修的问题，换成了「前言写法、提示范围、转述损耗、工具截断」这几个能修的问题。
