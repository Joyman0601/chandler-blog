---
# import-articles-sha256: 7cfdd3fe9f5be93292baf3ed3b8753784b03db5bce857c593409b55e5ae47503
# Imported by scripts/import-articles.mjs from posts/ai-workflow/context-compaction-cost.md
# Source date: 2026-10-10
title: "上下文花费的大头是重读前缀：用历史会话定压缩阈值"
description: "长会话每一轮的花费，大头是按缓存价重读前面的上下文。我从本机会话记录量出这件事，拿一百多个历史会话模拟自动压缩阈值，定在 30 万 token；上线两周后又发现压缩次数被低估，各道 hook 跟着重复触发。"
pubDate: 2026-09-10
tags: ["Claude Code","上下文管理","Hooks","AI 编程","复盘"]
series: ai-workflow
seriesLabel: "AI 辅助开发"
---

> 一句话总结：长会话的钱主要花在每一轮重读前缀上，省钱的杠杆是让上下文早点变短，而不是换哪种机制。我拿 110 个历史会话做模拟，把自动压缩从默认的约 96 万提前到 30 万 token，花费降到约 58%；再往下省得不多，压缩次数却翻几倍。压缩摘要核不了，所以前提是真相先落盘。

## 0. 起因：小任务做完就开新窗口，到底省不省

我用 Claude Code 时，一个窗口常常连着干大半天。10 月 10 日我冒出一个想法：一个小任务做完就开新窗口，虽然麻烦、慢一点，但按我的理解应该更省 token。动手做工具之前，我先让 Claude 拿我自己的会话记录量一下，不凭感觉。

量出来的结果比直觉还极端。后面几件事都从这里来：定了自动压缩阈值，写了一个「上下文闸」hook，两周后又回头修了一次。

## 1. 先量：每一轮的钱花在哪

Claude Code 把每个会话存成一个 JSONL 文件，每条助手消息带一个 `usage`，里面有四个数：

| 字段 | 含义 | 相对价格（普通输入记 1） |
|---|---|---|
| `input_tokens` | 没走缓存的普通输入 | 1 |
| `cache_creation_input_tokens` | 这一轮新写进缓存的内容 | 1.25 |
| `cache_read_input_tokens` | 从缓存里重读的前缀 | 0.1 |
| `output_tokens` | 输出 | 5 |

相对价格是按公开定价页的比例换算的，不同模型的输出倍数可能不同，用之前以定价页为准。一轮的花费大致是：

```text
一轮花费 ∝ 0.1 × 前缀 + 1.25 × 新写入 + 5 × 输出
```

前缀就是这一轮之前的整段上下文。设上下文已经到 90 万，这一轮只新读了一个 3 千 token 的文件，输出 1.5 千。重读前缀折合 9 万，新写加输出折合约 1.1 万，重读占了约 89%。上下文一长，不管这一轮干了多少活，钱都花在重读上。

当天量出来的结果（实测，10-10）：两周里最长的 14 个工作会话，都要到约 96 万 token 才自动压缩，因为默认阈值就是模型的上下文上限；压缩完落回约 7.5 万。只比缓存读和输出两项，每轮 85–92% 的花费是重读前缀，输出只占 8–15%。按这个算，过了 10 万就换窗口，花费能压到原来的 13–20%。

写这篇时（10-23），我用下面这个脚本复核了一次，这次把缓存写也算了进去：

```python
#!/usr/bin/env python3
"""从 Claude Code 的会话记录算两件事：花费里有多少是重读前缀，压缩发生在多大的上下文。
用法：python3 prefix_share.py <会话>.jsonl
按价格比例算（普通输入记 1）：缓存写 1.25、缓存读 0.1、输出 5。比例以官方定价页为准。
"""
import json
import sys

WEIGHT = {
    "input_tokens": 1.0,
    "cache_creation_input_tokens": 1.25,
    "cache_read_input_tokens": 0.1,
    "output_tokens": 5.0,
}
seen, cost, compacts = set(), dict.fromkeys(WEIGHT, 0.0), []

for line in open(sys.argv[1], errors="replace"):
    try:
        d = json.loads(line)
    except ValueError:
        continue
    if d.get("type") == "system" and d.get("subtype") == "compact_boundary":
        meta = d.get("compactMetadata") or {}
        compacts.append((meta.get("trigger"), meta.get("preTokens"), meta.get("postTokens")))
        continue
    msg = d.get("message") or {}
    usage = msg.get("usage")
    if d.get("type") != "assistant" or not usage or msg.get("id") in seen:
        continue
    seen.add(msg.get("id"))  # 一条消息按内容块会写成多行，usage 相同，只算一次
    for key, w in WEIGHT.items():
        cost[key] += (usage.get(key) or 0) * w

total = sum(cost.values()) or 1
for key, v in cost.items():
    print(f"{key:30s} {v / total:6.1%}")
for trigger, pre, post in compacts:
    print(f"压缩（{trigger}）：{pre} → {post} tokens")
```

脚本里有两个细节是踩过才知道的。一是同一条助手消息会按内容块写成好几行，`usage` 完全相同，不按消息 id 去重会重复计算，我看到的最多重复了 8 次。二是压缩在记录里是一条 `system` 消息，子类型 `compact_boundary`，带着压缩前后的 token 数。

按单轮上下文分档统计的结果（实测，10-23，本机 3 MB 以上的会话）：

| 单轮上下文 | 缓存读占这一轮花费 |
|---|---|
| 10 万以下 | 32% |
| 10–20 万 | 59% |
| 20–30 万 | 67% |
| 30–50 万 | 73%–76% |
| 80–90 万 | 81% |

算上缓存写，占比比 10-10 那次低一截，规律却一样：上下文越长，重读的占比越高，而且一直是最大的一项。同一件事换个口径，数字能差十几个百分点，所以写占比时，口径要写在数字旁边。

## 2. 新开窗口和原生压缩：落点差不多

确认了「早切」有用，下一个问题是怎么切。我让 Claude 对比两条路：一条是写续接文件、开新窗口，一条是 Claude Code 自带的压缩。数据如下（实测，10-10）：

| 项 | 原生自动压缩（13 次） | 新窗口 + 续接文件 |
|---|---|---|
| 触发时的上下文 | 中位 96.5 万，没有一次早于 96 万 | 自己决定 |
| 摘要体积 | 1.3 万–2.7 万字符，固定 9 节 | 3.5 千–1.3 万字符 |
| 切换后第一轮的上下文 | 4.9 万–9.1 万 | 5.6 万–6.1 万，再加上读续接文件和它点名的文件 |

两边切完都落回 6 万到 9 万。系统提示、指令文件、自动引入的目录这些固定前缀，本身就占约 5.6 万。省钱的关键是早切，不是用哪种机制。

两条路各有长处：

- **原生压缩**：一条命令，会话名不变，hook 按会话记的状态也不丢，摘要还会保留我发的全部消息的原话。短板是摘要在没有工具的状态下凭记忆写，里面的数字核不了；它只存在会话记录里，别的窗口读不到；它写的是「发生过什么」，不是「接下来做什么」。
- **续接文件**：写的时候有工具，分支、测试结果都能当场实测，写完还能过检查脚本；文件落在任务目录里，别的窗口、第二天都能接着用。代价是要花一轮写文件，开窗时还要分两条发消息（见[多窗口并行开发](/blog/ai-workflow/multi-window-parallel-dev/)）。

## 3. 能调的和不能调的

这一步查的是文档，Claude Code 官方文档的命令、环境变量、模型配置、hooks 几页：

- `/compact` 只能由人在输入框里打，模型、hook、skill 都触发不了。
- 自动压缩的阈值可以调：`/autocompact 300k`，或者 settings.json 里的 `autoCompactWindow`，或者环境变量 `CLAUDE_CODE_AUTO_COMPACT_WINDOW`。默认值是模型的上下文上限，这就解释了为什么 13 次压缩全在 96 万附近。
- 有 `PreCompact` 和 `PostCompact` 两个 hook 事件。前者只能拦，不能往摘要里加指令；后者能拿到摘要全文。

还有一个现场观察（实测）：我在一个开着的窗口里把阈值改成 15 万，这个窗口涨到 16 万也没压缩。设置可能只在会话启动时读取，改完要新开一个窗口看效果。

分工也就清楚了：同一件事做到一半，交给自动压缩；阶段结束、多窗口交接、隔天再接，才写续接文件。

## 4. 用历史会话模拟阈值

阈值定多少，我的直觉是「从最高拉到最低不一定最好」，有些活就是需要长一点的上下文。于是拿历史会话做模拟。

**做法**：取近 14 天里 110 个会话，每个至少 30 轮、峰值上下文至少 10 万。按每轮的上下文增长和输出回放；上下文过了阈值就压缩一次，压缩本身记为「读一遍全部上下文，再输出 8 千」，压缩后上下文落回 7.5 万。价格按第 1 节的比例算。

**结果**（实测，10-10，以默认阈值为 100%）：

| 阈值 | 相对花费 | 压缩次数（110 个会话合计） |
|---|---|---|
| 96 万（默认） | 100% | 14 |
| 50 万 | 73.5% | 67 |
| 40 万 | 65.0% | 101 |
| 30 万 | 57.5% | 154 |
| 25 万 | 53.2% | 224 |
| 20 万 | 49.1% | 333 |
| 15 万 | 45.3% | 578 |
| 12 万 | 43.6% | 991 |

花费有地板：压缩后上下文总要落回 7.5 万，阈值再低也省不出钱，只是压得更勤。从 40 万到 30 万多省 7.5 个点，只多压 53 次；从 30 万到 25 万只多省 4 个点，压缩次数却多了近一半。

**准确率那一侧**：看我的单次请求，一个请求内的上下文增长中位 1.1 万，p90 11 万，p95 18 万。阈值减去 7.5 万的落点，才是一个请求能用的空间。15 万只留下 7.5 万，一成的请求会做到一半被压；30 万留下 22.5 万，能盖住 p95。

两边一起看，定在 30 万。它是边际收益掉下去之前的最后一档，大多数请求也不会做到一半被打断。

模拟脚本的最小版本如下，把一批会话记录作为参数传进去：

```python
#!/usr/bin/env python3
"""拿历史会话模拟不同的自动压缩阈值：相对花费和压缩次数。
用法：python3 simulate.py <会话>.jsonl ...
假设：每轮新增的上下文按缓存写计价，其余前缀按缓存读计价；
压缩一次 = 读一遍全部上下文 + 输出 8k，压缩后上下文落回 FLOOR。
"""
import json
import sys

R, W, O = 0.1, 1.25, 5.0          # 缓存读、缓存写、输出相对普通输入的价格比例
FLOOR, SUMMARY_OUT = 75_000, 8_000


def turns(path):
    """每轮的（上下文增长, 输出）。真实压缩造成的回落记为 0 增长。"""
    seen, prev, out = set(), None, []
    for line in open(path, errors="replace"):
        try:
            d = json.loads(line)
        except ValueError:
            continue
        msg = d.get("message") or {}
        u = msg.get("usage")
        if d.get("type") != "assistant" or not u or msg.get("id") in seen:
            continue
        seen.add(msg.get("id"))
        ctx = sum(u.get(k) or 0 for k in
                  ("input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"))
        out.append((max(ctx - prev, 0) if prev is not None else ctx, u.get("output_tokens") or 0))
        prev = ctx
    return out


def simulate(ts, threshold):
    ctx, cost, n = 0, 0.0, 0
    for grow, output in ts:
        if ctx + grow > threshold:      # 到线就压缩
            cost += R * ctx + O * SUMMARY_OUT
            ctx, n = FLOOR, n + 1
        cost += R * ctx + W * grow + O * output
        ctx += grow
    return cost, n


sessions = [t for t in (turns(p) for p in sys.argv[1:])
            if len(t) >= 30 and sum(g for g, _ in t) >= 100_000]
base = sum(simulate(t, 960_000)[0] for t in sessions)   # 以默认阈值为 100%
print(f"{len(sessions)} 个会话")
for th in (960_000, 500_000, 400_000, 300_000, 250_000, 200_000, 150_000):
    runs = [simulate(t, th) for t in sessions]
    print(f"阈值 {th // 10_000:>3} 万：相对花费 {sum(c for c, _ in runs) / base:6.1%}，"
          f"压缩 {sum(n for _, n in runs)} 次")
```

写这篇时，我用这个脚本在最近的 125 个会话上重跑了一遍：30 万档约为默认阈值的 53%，曲线形状和当时一样（实测，10-23）。

## 5. 压缩的前提：真相先落盘

自动压缩省事，但有一个绕不开的问题：摘要是模型在没有工具的状态下凭记忆写的，谁也核不了。我吃过一次亏：一次代码审查的结论只留在聊天里，压缩后写进文件的只剩修法表，审查列出的 12 条小问题里有 10 条再没人提起。

所以压缩能用的前提是真相已经在盘上：决定写在 `DECISIONS.md`，现状写在 `STATUS.md`，真实调用的花费写在台账里。摘要只负责指路，不负责记事实。

我用一个 hook 把这条前提变成提醒和存档，叫它「上下文闸」，挂在三个事件上：

| 事件 | 做什么 |
|---|---|
| UserPromptSubmit | 上下文到 25 万（赶在 30 万自动压缩之前）就注入一段提醒：这一轮先把还只在对话里的决定、现状、花费落盘；正好到了阶段点，就改写续接文件 |
| PreToolUse | 上下文过 40 万、本会话还没写续接文件时，拦一次写文件或跑命令。这是兜底，只有自动压缩没生效才会走到这里 |
| PostCompact | 把压缩摘要原样存成任务目录里的 `compact-<时间>.md`，文件头注明「凭记忆写、未核」 |

上下文有多大，直接从会话记录里最后一条助手消息的 `usage` 算：`input + cache_read + cache_creation`。PostCompact 那一段最简单，最小版本是这样：

```python
#!/usr/bin/env python3
"""PostCompact hook：把压缩摘要原样存成文件。stdin 是 hook 输入的 JSON。"""
import json
import sys
import time
from pathlib import Path

data = json.load(sys.stdin)
summary = data.get("compact_summary") or ""
dest = Path.home() / ".claude" / "compacts" / f"compact-{time.strftime('%Y%m%d-%H%M%S')}.md"
dest.parent.mkdir(parents=True, exist_ok=True)
dest.write_text(
    f"# 压缩摘要（{data.get('trigger', '?')}，{time.strftime('%Y-%m-%d %H:%M')}）\n\n"
    "> 模型在没有工具的状态下凭记忆写的，数字和路径未核，当线索用。\n\n" + summary,
    encoding="utf-8",
)
```

```json
{
  "autoCompactWindow": 300000,
  "hooks": {
    "PostCompact": [
      { "hooks": [{ "type": "command", "command": "python3 ~/.claude/hooks/save_compact.py", "timeout": 10 }] }
    ]
  }
}
```

我自己的版本会从会话记录里推出当前的任务目录，把摘要存到那里，推不出来才放进一个公共目录。存下来的摘要变成了能看、能核、别的窗口也能读的文件，补回了续接文件的一半好处，几乎不花什么。

## 6. 两周后回头看：压缩次数被低估了

10-21 我回头拿各道 hook 的命中日志做了一次对账，发现一个上线前没想到的放大效应（实测）：

- 阈值改到 30 万以后，76 个会话平均每个压缩 3.5 次，模拟预测的是 1.4 次，连跑好几天的窗口压缩了 19 到 25 次。原因我推断是：有了自动压缩，我不再按阶段换窗口，一个窗口一开就是好几天。
- 我还有几个按关键词注入提示的 hook，例如经验库条目提示、项目卡片提示、必读文件核对。它们都按「一个会话只提示一次」去重，而去重状态每压缩一次就清零，于是每一段都从头触发。实际命中比上线前用历史回放预测的高 3 到 6 倍，项目卡片提示预测每会话 3.8 张，实际约 12.6 张。
- 必读文件核对的打回里，约 79% 是「自动压缩后要求重读」。

这不是哪个 hook 的 bug，是两个各自合理的决定叠在一起的结果。

第二天又按近 7 天的数据量了一次（实测）。各道 hook 拦下后引起的额外花费，约占全部会话花费的 13%；其中约 65% 是压缩后同一条又拦一遍、同一份文件又读一遍。压缩本身也很频繁：26 个会话压缩了 251 次，中位每 31 分钟、每 71 次调用压一次。压缩后的第一次调用就已经占了约 7.8 万（摘要约 1.2 万，其余是固定前缀），每一段真正能用的只有约 19 万。

把「每压一次，hook 要重来一遍」也算进去，最省钱的压缩线推算在 17 万到 24 万之间，30 万离它不远（推算，没有实测）。所以压缩线不动，改的是 hook：

1. 经验库条目提示：压缩后不再从头拦，同一条整个会话只拦一次。推送前检查这类必须每次都拦的除外。
2. 必须读全的长资料：第一次照旧由主模型自己分段读全，同时落盘一份要点清单，每条照原文摘、标出原文行号，由机器核行号是否盖全了原文。压缩后只要求重读这份清单，用到哪一节再回原文读那一节。交付前派一个新上下文的子代理拿原文核交付物，抓清单漏掉的。
3. skill 附带的参考文件，改成到了用它的那一步才要求读。

这几项刚改完，效果要再跑一段时间才知道。必读核对的设计见[长规范只读了三分之一就开工](/blog/ai-workflow/long-rulebook-partial-read/)，hook 本身怎么写见[用 Claude Code hooks 注入上下文、拦命令](/blog/ai-workflow/claude-code-hooks-inject-context/)。

## 收尾

1. **先量再改** —— 「小任务做完就换窗口更省」的直觉是对的，但量了才知道省在哪：省在上下文长度，不在机制。
2. **占比要带口径** —— 算不算缓存写，同一件事的占比能差十几个百分点。
3. **阈值看边际，也看单个请求的增长** —— 花费有地板；阈值减去落点，要盖住 p95 的请求增长。
4. **压缩前真相先落盘** —— 摘要核不了，只能指路；存下来的摘要也只当线索。
5. **改了全局参数，回头对账** —— 压缩次数一多，所有「每会话一次」的去重都会被一起放大。

下次再改这类全局参数，我会在改之前先列出所有按「会话」计数的东西，改完一周按日志对一次账。估 agent 类接口花费时是同一个道理，缓存读才是大头，见[估 agent 类接口的花费](/blog/billing-regression/agent-api-token-cost/)。
