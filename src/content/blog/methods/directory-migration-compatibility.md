---
# import-articles-sha256: 266304fec78b4269cea868fe95c008f7dcb7156c5aa8d7010f924224b9dca563
# Imported by scripts/import-articles.mjs from posts/methods/directory-migration-compatibility.md
# Source date: 2026-11-02
title: "整理项目目录：迁移后仍要按旧入口验证"
description: "研究目录整理涉及脚本、报告、相对链接和仍在运行的任务。一次迁移让我把文件位置与使用入口分开：先盘点依赖，再生成操作清单，保留必要兼容路径，最后分别核内容完整、链接语义、Git 状态和回滚条件。"
pubDate: 2026-11-02
tags: ["工作方法","文档","命令行","Git"]
series: methods
seriesLabel: "工作方法"
---

> 一句话总结：整理目录是一场路径迁移；文件都还在，只能证明没丢，旧报告、脚本和运行中的任务能否继续找到同一份内容，还要另外验证。

## 0. 起因：分类更清楚，使用入口却可能断掉

我的研究目录逐渐混用了两种结构：一部分按日期保存，一部分直接按项目命名。项目内部又混着报告、来源、过程笔记、会话归档和交付快照，时间久了很难找到真正入口。

最初看起来只是把文件挪进几个子目录。但盘点后发现，已有报告和脚本引用旧的绝对路径，有些 HTML 使用相对链接，还有后台任务持续写状态文件。直接移动，目录会整齐，使用关系却会被改掉。

我最后保留日期分组，为独立项目建立集中入口，把适合移动的静态维护材料归类；含复杂相对链接的文档留在原位，通过索引组织。已有 Git 跟踪内容也不在这次整理中顺手改写。

下面是这次整理提炼的方法，只管文件系统这一层，项目本身能不能跑要另外验。

## 1. 分类之前：先分清对象与依赖

我先把目录里的东西按使用方式分组，而不是按扩展名分组。

| 对象 | 主要依赖 | 处理思路 |
|---|---|---|
| 对外或已发报告 | 固定入口、配套图片和相对链接 | 优先保留完整目录与原入口 |
| 静态过程材料 | 历史引用、检索路径 | 可归类，记录新旧映射 |
| Git 跟踪文件 | 仓库根、工作树状态、工具配置 | 本次保留原位，用索引连接 |
| 运行状态文件 | 进程持有路径、持续写入 | 先确认所有者与运行状态 |
| 缓存和构建产物 | 工具预期位置、可重建条件 | 单独盘点，不混入文档迁移 |

这张表的作用是限定动作。看到一个文件名像日志，不足以判定可以移动；看到目录叫临时，也不代表没人使用。

我还区分「内容分类」和「物理搬迁」。读者需要按用途找到材料，不一定要求每个文件都换位置。索引、说明页和链接已经能解决一部分查找问题，成本更低。

分类要靠盘点结果，不靠看文件名。下面三条命令分别回答：哪些文件写死了旧的绝对路径，目录里有哪些符号链接、指向哪里，此刻有没有进程开着这个目录下的文件。

```zsh
OLD=/path/to/old-root          # 迁移前的绝对路径（占位）
ROOT=${1:-/path/to/project}    # 要整理的目录

print '== 写死旧绝对路径的文本文件'
grep -rIl -- "${OLD}" "${ROOT}"            # -I 跳过二进制，-l 只列文件名

print '== 符号链接和它们的目标（断链标 BROKEN）'
find "${ROOT}" -type l | while IFS= read -r l; do
  if [[ -e "$l" ]]; then print -r -- "$l -> $(readlink "$l")"
  else print -r -- "$l -> $(readlink "$l")  BROKEN"; fi
done

print '== 此刻开着这个目录下文件的进程'
lsof +D "${ROOT}"   # 只看得到此刻开着的；间歇写入的进程要多看几次
```

在一个假目录上跑的结果（一个后台进程开着 `state/run.log`，用户名换成了 `me`）：

```text
== 写死旧绝对路径的文本文件
/tmp/blogfix-aw/inv/root/scripts/run.sh
/tmp/blogfix-aw/inv/root/reports/index.md
== 符号链接和它们的目标（断链标 BROKEN）
/tmp/blogfix-aw/inv/root/scripts/broken.md -> ../missing.md  BROKEN
/tmp/blogfix-aw/inv/root/scripts/index-link.md -> ../reports/index.md
== 此刻开着这个目录下文件的进程
COMMAND   PID USER FD   TYPE DEVICE SIZE/OFF     NODE NAME
sleep   19363 me     3w   REG   1,17        0 54914390 /private/tmp/blogfix-aw/inv/root/state/run.log
```

`lsof +D` 会递归扫整棵树，大目录要等一会儿；macOS 上它有输出时退出码也可能是 1，看输出，不看退出码。它只能看到这一刻开着的文件，每隔几分钟写一次、写完就关的任务，要靠所有者确认。

## 2. 旧路径：把它看成已经发布的入口

一个路径被脚本、报告或他人保存后，就形成了使用约定。迁移前，我会为每个计划移动的对象记录：旧路径、新路径、对象类型、是否留兼容入口、由谁使用。

兼容入口有多种形式。文件系统内可以是符号链接，网页可以是重定向，命令行工具可以保留旧命令包装。选择取决于使用者真正怎样访问，不能只选自己验证起来方便的一种。

例如，本地符号链接可以帮助旧绝对路径继续工作，但将目录打包、复制到不支持相同链接语义的环境后，情况可能不同。如果交付目标是离线 HTML，就应按解压后的入口验证，不能只看开发机上的链接。

我这次只验了本机目录，跨平台打包没验，报告里也照这个范围写。

## 3. 相对链接：同一文件也可能走向不同目标

我最需要留意的是「文件没变，链接却变了」。下面是重新编写的目录例子：

![notes/ 目录下两个子目录：draft/ 里放 report.html，assets/ 里放 diagram.svg](figures/directory-migration-compatibility-notes-tree.svg)

假设报告通过 `../assets/diagram.svg` 引用图片。把报告单独移到 `notes/archive/draft/`，相同字符串会尝试定位另一层目录。文件摘要完全一致，浏览器也可能打不开图片。

即使保留指向报告的旧符号链接，也应分别用旧入口和新入口打开。不同使用工具可能按访问 URL、物理路径或解析后的路径处理相对引用；只验证「链接指向同一 inode」不足以回答最终页面引用。

下面这段可以直接复现。它把报告搬进 `archive/draft/`，旧位置留一个符号链接，再用无头浏览器分别打开两个入口；图片加载成功或失败时，页面会改自己的标题：

```zsh
mkdir -p notes/{draft,assets,archive/draft}
print '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>' > notes/assets/diagram.svg
cat > notes/archive/draft/report.html <<'HTML'
<img src="../assets/diagram.svg"
     onload="document.title='图片已加载'" onerror="document.title='图片加载失败'">
HTML
ln -s ../archive/draft/report.html notes/draft/report.html   # 旧入口留兼容链接

for p in draft archive/draft; do   # CHROME 指向本机的 Chrome 或 chrome-headless-shell
  print -n "${p}: "
  "$CHROME" --headless --virtual-time-budget=2000 --dump-dom "file://$PWD/notes/${p}/report.html" 2>/dev/null |
    grep -o '<title>[^<]*</title>'
done
```

我用 Chromium 的无头版跑的结果：

```text
draft: <title>图片已加载</title>
archive/draft: <title>图片加载失败</title>
```

同一个文件，从旧入口打开，`../assets/` 按地址栏的 URL 算成 `notes/assets/`，图片在；从新入口打开，算成 `notes/archive/assets/`，图片不在。浏览器按 URL 解析相对路径，不会先把符号链接换成物理路径。反过来，先取 `realpath` 再拼路径的脚本，从两个入口得到的都是 `notes/archive/assets/`。所以旧入口通过，不代表新入口也通过；检查器和浏览器的结论也可能相反。

这次迁移还发现报告向目录树之外引用资料。处理时需要核具体目标，再决定保留原位、调整结构或加兼容桥。不能为了让检查器显示目标存在，随意创建一个同名文件。

**链接有效的预期是找到原目标内容。** 一个路径从不存在变为存在，只是最低一层检查；如果它误指到另一份同名报告，使用者仍会拿到错误材料。

## 4. 执行清单：每一项移动都有反向记录

真正移动前，我先形成机器可读的清单，再核冲突。下面是通用示意，不是原任务的数据。

```json
[
  {
    "operation": "move-file",
    "source": "notes/draft/context.md",
    "destination": "notes/_maintenance/context.md",
    "compatibility": "symlink",
    "expected_type": "regular-file",
    "sha256": "<盘点时算出的摘要>"
  }
]
```

清单应在写入前检查目标是否已有内容、旧路径是否已经是链接、源是否仍与盘点时相同。执行后再记录实际结果，计划与执行日志分开保存。

我不会用执行日志里的一条「成功」替代现场核对。进程可能在移动后、写记录前中断，也可能只完成一半操作。恢复时要对照源、目标和兼容入口的实际状态。

回滚也不是简单反向遍历。如果迁移后已有新文件写入目标目录，直接移回可能覆盖内容。回滚预检应核目标身份、占位冲突和新增写入，满足条件才执行。我这次保存了回滚清单并完成预检，没有为了展示可逆而再把全部目录搬一遍。

下面是一个只处理「移动文件 + 旧路径留符号链接」的最小脚本，读上面那种清单。不加参数只预检、打印要做什么；加 `--apply` 才动手；`--rollback` 换成反向，预检核的是「旧路径还是本次留的链接」「目标从迁移后没被改过」。任何一项不过，整批都不动：

```python
#!/usr/bin/env python3
"""按清单移动文件、在旧路径留符号链接。默认只预检和打印；加 --apply 才动手；--rollback 换成反向。"""
import hashlib, json, os, sys
from pathlib import Path

def sha(p): return hashlib.sha256(Path(p).read_bytes()).hexdigest()
def link_text(src, dst): return os.path.relpath(dst, src.parent)

def precheck(op, rollback):
    src, dst = Path(op["source"]), Path(op["destination"])
    if not rollback:
        if src.is_symlink() or not src.is_file(): return "源不是普通文件（已经迁过？）"
        if dst.exists() or dst.is_symlink(): return "目标已存在"
        if sha(src) != op["sha256"]: return "源在盘点之后被改过"
    else:
        if not src.is_symlink() or os.readlink(src) != link_text(src, dst): return "旧路径不是本次留的链接"
        if not dst.is_file() or sha(dst) != op["sha256"]: return "目标在迁移之后被改过"

def main(plan, apply, rollback):
    ops = json.load(open(plan))
    bad = [(op["source"], e) for op in ops if (e := precheck(op, rollback))]
    for s, e in bad: print("拒绝", s, "：", e)
    if bad: return 1                                  # 有一项不过，整批都不动
    for op in ops:
        src, dst = Path(op["source"]), Path(op["destination"])
        print("执行" if apply else "预演", "回滚" if rollback else "移动", src, dst)
        if apply and not rollback:
            dst.parent.mkdir(parents=True, exist_ok=True)
            src.rename(dst); src.symlink_to(link_text(src, dst))   # 旧路径留兼容链接
        elif apply:
            src.unlink(); dst.rename(src)
    return 0

sys.exit(main(sys.argv[1], "--apply" in sys.argv, "--rollback" in sys.argv))
```

在假目录上依次跑预演、执行、重复执行、目标被改后回滚、恢复内容后回滚：

```text
$ python3 migrate.py plan.json
预演 移动 notes/draft/context.md notes/_maintenance/context.md
$ python3 migrate.py plan.json --apply
执行 移动 notes/draft/context.md notes/_maintenance/context.md
$ python3 migrate.py plan.json --apply            # 第二次：源已经是链接
拒绝 notes/draft/context.md ： 源不是普通文件（已经迁过？）
$ python3 migrate.py plan.json --rollback         # 目标在迁移后被追加了一行
拒绝 notes/draft/context.md ： 目标在迁移之后被改过
$ python3 migrate.py plan.json --rollback --apply # 内容恢复后
执行 回滚 notes/draft/context.md notes/_maintenance/context.md
```

摘要比对是最严的条件：迁移后正常写入的文件也会被拒绝回滚。这正是想要的结果，有新写入就该人来决定怎么合，不该被脚本覆盖。

## 5. 四层验证：完整性、入口、仓库与运行状态

这次我分别验证四类预期，避免把一个总数当作完成证据。

第一层是内容完整性。普通文件比对摘要；符号链接比对链接目标；目录检查条目类型和映射关系。对无需修改的材料，整理前后字节应一致。对仍在写入的状态文件，不能套用静态摘要结论，需要先处理并发条件。

第二层是入口。旧兼容路径、新导航和代表性外部相对引用分别检查。有条件时按真实使用工具打开 HTML、运行只读命令，确认路径解析的结果。

第三层是 Git 状态。整理前保存各仓库的 HEAD、已跟踪改动和未跟踪文件清单；整理后按原路径核对。本来就有未提交内容，不能把它当成整理制造的新变化，更不能为了得到干净状态而清掉。

第四层是运行状态。仍在运行的任务是否使用旧目录、是否持续写入，需要所有者和进程证据。一个静态扫描器看不到所有打开的文件句柄，也不能自动判断服务已经闲置。

这次文件摘要、兼容入口、导航目标和原 Git 状态都核过，说明文件系统整理做完了；每个项目的服务和功能能不能用，要各自另验。

## 6. 导航与维护：迁移后只保留一个内容维护点

兼容入口解决了旧引用，也容易带来新的困惑：看起来两处都有同一份文件，以后该改哪一处。

我会在总索引说明新的维护位置，并让旧入口只承担兼容作用。过程记录继续记真实目标，新增链接尽量指向维护入口。避免复制两份正文，让它们随着修改逐渐分叉。

兼容链接也应有清单。将来确认旧引用已迁走，可以按清单评估是否移除；没有使用情况证据，就不凭目录看起来重复而删除。

最后留下的应是能回答问题的入口：想看结论去哪里，想核证据去哪里，想继续工作先读什么。目录的层数多少是次要的，读者不用猜哪一份才有效更重要。

## 收尾

1. **先核依赖** —— 静态材料、仓库文件和运行状态采用不同处理方式。
2. **迁移留清单** —— 新旧路径、对象身份和兼容入口都可追溯。
3. **按使用验证** —— 字节没丢、链接没断、目标没变分别检查。

下次整理目录，我会先画出使用入口，再设计分类。目录树是给人找东西的；它能继续承接旧使用方式，整理才算完成。
