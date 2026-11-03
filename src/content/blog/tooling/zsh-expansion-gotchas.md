---
# import-articles-sha256: 4f4f05e088c0fc1c96403920c84b0eb53ab98877623c8feebf8b56c46158f703
# Imported by scripts/import-articles.mjs from posts/tooling/zsh-expansion-gotchas.md
# Source date: 2026-10-09
title: "zsh 和 bash 3.2 的七个展开坑：写法定死才不复发"
description: "macOS 的默认 shell 是 zsh，自带的 bash 停在 3.2。从 Linux 和 bash 习惯带过来的命令，会在变量后的冒号、开头的等号、不加引号的星号、变量后的中文等地方静默出错。七个坑各给现象、根因和写法，附一行能扫出「变量后紧跟中文」的 perl。"
pubDate: 2026-09-09
tags: ["zsh","命令行","macOS","开发环境"]
series: tooling
seriesLabel: "开发环境与工具"
---

> 一句话总结：zsh 的展开规则和 bash 有七处不同，最危险的几处不报错，只是把参数悄悄改掉。变量后面紧跟冒号或中文就写 `${VAR}`，给程序看的 `*` 和以 `=` 开头的参数加引号，不拿 `path`、`status` 当变量名，列表要拆开就用 `${=VAR}` 或数组，`grep -E` 的可选组写 `(a)?`。

## 0. 起因：同样的坑，记下来以后又踩了好几次

换到 macOS 以后，我的终端和 Claude Code 跑命令用的都是 zsh，macOS 自带的 `/bin/bash` 是 3.2。手里的命令和脚本习惯，大多来自 Linux 上的 bash；而日常跑的命令，大部分其实是 Claude Code（下文叫「助手」）写的，它的写法也是 bash 的习惯。

头几周碰到的报错五花八门：`ambiguous argument`、`==== not found`、`no matches found`、`read-only variable`、`unbound variable`、`illegal pid`。每个单独查都不难，查完也记进了笔记。可接下来两周里，助手写的命令里同样的坑又出现了好几次：给 git 的 `rev:path` 前面放变量，冒号后的字母被吃掉；分隔线 `echo =====` 让后面整段命令都没执行；bash 3.2 的脚本里一个变量后面跟了全角分号，`set -u` 当场中止。

这说明光知道没用，写法要变成默认的。这篇把七个坑各讲一遍，最后给一张检查清单和一行扫描命令。下文的「实测」都是在 macOS 自带的 zsh 和 `/bin/bash` 上跑的。

动手之前，先弄清命令到底由谁执行。交互终端和 Claude Code 的 Bash 工具，用的都是当前账号的默认 shell，在 macOS 上就是 zsh；脚本则由第一行的 shebang 决定，`#!/bin/bash` 在 macOS 上就是 3.2。苹果一直没有升级它，公开资料里的说法是 bash 4 起换成了 GPLv3 许可。想用新版 bash，要自己装，再把 shebang 写成 `#!/usr/bin/env bash`，并确认 PATH 里先找到的是新版。拿不准时跑两条命令看一眼：

```bash
ps -p $$ -o comm=
bash --version | head -1
```

同一段命令，在终端里敲、放进脚本里跑、交给 Claude Code 执行，可能是三个不同的解释器。下面每一条都注明了它出在哪个 shell 里。

## 1. 变量后紧跟「冒号加字母」，被当成修饰符

**现象**：

```zsh
T=origin/main
git show "$T:common/config.go"
```

```text
fatal: ambiguous argument 'origin/mainommon/config.go': unknown revision or path not in the working tree.
```

冒号和路径的首字母一起没了。换个路径又正常，看着像偶发。

**根因**：zsh 的历史修饰符（`:h` 取目录、`:t` 取文件名、`:u` 转大写……）也作用于参数展开。`$T:c` 里的 `:c` 被当成修饰符，冒号和 `c` 一起被吃掉。实测下来，首字母是 a、c、e、h、l、q、r、t、u 时中招；s 开头时可能直接报 `bad substitution` 并中止；p、d 开头碰巧不受影响，`"$T:$x"` 也正常。这是展开语法本身，双引号挡不住。`chown $USER:staff file` 同样会中招。

**写法**：变量后面紧跟冒号时，一律加花括号。

```zsh
git show "${T}:common/config.go"
chown "${USER}:staff" file
```

## 2. 以等号开头的词，被当成命令路径

**现象**：打一条分隔线：

```zsh
echo =====
```

```text
zsh: ==== not found
```

更麻烦的是在 `zsh -c` 和 `eval` 里：报错之后，同一段剩下的命令全部不执行。Claude Code 把一串命令交给 shell 执行时就是这种情况。助手的一条「打分隔线，再跑测试」的命令就栽在这里，测试一行都没跑。

**根因**：zsh 默认打开 `EQUALS` 选项，`=foo` 会被替换成命令 `foo` 的完整路径，相当于 `$(which foo)`。`=====` 被当成「找一个叫 `====` 的命令」，找不到就报错。

**写法**：

```zsh
echo '====='
printf '%s\n' '-----'
```

## 3. 不加引号的星号，被当成文件名展开

**现象**：

```zsh
grep -rl 'TODO' --include=*.py .
```

```text
zsh: no matches found: --include=*.py
```

grep 根本没有启动。单条命令看得见报错，放进循环或者 `$(...)` 计数时就看不见了，每一轮都得 0，很容易当成「真的没命中」。

**根因**：zsh 默认打开 `NOMATCH`。含 `*`、`?`、`[...]` 的词先做文件名展开，当前目录里没有匹配，就报错、整条命令不执行。bash 在展开不到时会把原词原样传下去，所以同一条命令在 bash 里能跑。

**写法**：给程序看的模式一律加单引号，或者整条加 `noglob` 前缀。计数得 0 时，先看 stderr 里有没有 `no matches found`。

```zsh
grep -rl 'TODO' --include='*.py' --exclude-dir='.venv' .
noglob find . -name *.py
```

## 4. 拿 path、status 当变量名

**现象**：一个循环里写了 `path=/v1/$ep`，之后 `curl`、`cat`、`ls` 全报 `command not found`。另一处写了 `status=$(curl ...)`：

```text
zsh: read-only variable: status
```

脚本当场中断。而这一行的 curl 已经发出去了，结果却没记下来；重跑之前，得先清掉上一轮请求的副作用。

**根因**：zsh 里小写的 `path` 是和 `PATH` 联动的数组，给它赋值就等于改了 `PATH`。同类的还有 `fpath`、`cdpath`、`manpath`、`mailpath`。`status` 是只读的特殊变量，等于 `$?`。这些名字在 bash 里都是普通变量（文档：zsh 手册的 Parameters Used By The Shell 一节）。

**写法**：换名，比如 `ep_path`、`http_code`。一次性脚本第一次跑，先用一个没有副作用的用例试通。

## 5. 变量后面紧跟中文，被并进变量名

这一条 bash 3.2 和 zsh 都有，表现还不一样。

**现象**：bash 3.2 开了 `set -u` 时：

```bash
NEW=abc
echo "提交 $NEW，完成"
```

```text
NEW�: unbound variable
```

脚本中止，前面已经执行的步骤没有清理。不开 `set -u` 时，输出变成「提交 ��完成」：值丢了，逗号也成了乱码。

zsh 里 `"$NEW，"` 正常，`"[$NEW中]"` 却输出 `[]`，开了 `-u` 时报 `NEW中: parameter not set`。

最容易误判的一点：加上 `LC_ALL=C`，两边都恢复正常。于是很自然地以为是终端编码的问题。

**根因**：bash 3.2 在 UTF-8 locale 下，把大于等于 0x80 的单个字节算成变量名的合法字符，吃掉了中文字或全角标点的第一个字节，剩下的字节成了乱码。zsh 按 locale 把中文字（不含全角标点）算作字母，整个字并进了变量名。`LC_ALL=C` 让两者都只认 ASCII 字母，所以看起来「修好了」，其实只是掩盖。

**写法**：中文和全角标点前面的变量，一律写 `${VAR}`。`set -u` 留着，让错误当场报出来，而不是静默变空。

```bash
echo "提交 ${NEW}，完成"
```

写完含中文输出的脚本，先用这一行 perl 扫一遍。它只读不改，报出「`$名字` 后面紧跟非 ASCII 字符」的行号：

```bash
perl -ne 'print "$ARGV:$.: $_" if /\$[A-Za-z_]\w*[^\x00-\x7F]/; close ARGV if eof' script.sh
```

零输出再跑。要批量修，可以用同样的正则给变量加花括号，改完再扫一遍、再跑一遍：

```bash
perl -pi -e 's/\$([A-Za-z_][A-Za-z0-9_]*)(?=[^\x00-\x7F])/\${$1}/g' script.sh
```

## 6. 变量不分词

**现象**：

```zsh
L="123 456"
kill $L
```

```text
zsh:kill:1: illegal pid: 123 456
```

一个进程都没杀。把「命令加参数」存进变量也是一样：

```zsh
R="python3 ./tool.py"
$R --test x
```

```text
zsh: no such file or directory: python3 ./tool.py
```

报错里的「文件名」中间带着空格，这就是线索。

**根因**：bash 对不加引号的变量展开做分词，zsh 默认不做（`SH_WORD_SPLIT` 关闭），整串成了一个参数。

**写法**：要拆就明说，或者一开始就用数组；命令简写用函数。

```zsh
kill ${=L}
L=(123 456)
kill $L
R() { python3 ./tool.py "$@"; }
```

杀进程之后，确认进程或端口确实没了，不要只看 kill 的退出码。

## 7. grep -E 的空分支，报错退出

**现象**：推送前用一条 grep 扫 diff 里有没有私钥：

```bash
git diff origin/main...HEAD | grep -cE 'BEGIN (RSA |)PRIVATE KEY'
```

输出是一行 `empty (sub)expression` 的报错，计数那一栏是空的，乍看像「0 命中」。退出码是 2。

**根因**：POSIX 的扩展正则不允许空的选择分支。macOS 自带的 BSD grep 按标准拒绝；Claude Code 的 Bash 工具里，`grep` 被包成了一个转给 ugrep 的 shell 函数，同样拒绝（实测）。GNU grep 接受这种写法，所以从 Linux 上抄来的正则，到这里就坏了。

**写法**：可选的组写成 `(RSA )?`。

```bash
printf '%s\n' 'BEGIN PRIVATE KEY' | grep -cE 'BEGIN (RSA )?PRIVATE KEY'
```

扫描类命令要分清三种退出码：0 是命中，1 是没命中，2 是出错。用在 `$(...)` 或循环里时，退出码 2 要当失败处理。最稳的做法是先拿一条一定该命中的样例跑一次，确认它能报出来。

## 8. 交给别人粘贴的命令块：按对方的用法实测

上面七条是自己写命令时的坑。还有一类是写给别人执行的命令：拿到的人会整段复制、粘贴进自己的终端。助手写过一段这样的示例：

```text
tool send "你好" --verbose   # 用默认配置
tool send "你好" profile=<配置名> --verbose
tool raw '{"name": "x", ...}'
```

整段粘贴进 zsh 以后，三行各坏各的：

- 第一行的注释没被丢掉，`#` 和后面的字变成了参数，请求里多出一个叫 `#` 的字段，被接口以「不支持的参数」拒绝。zsh 的交互模式默认不认 `#` 注释（`INTERACTIVE_COMMENTS` 关闭），只有脚本里才认；bash 的交互模式是认的，所以这个坑在自己的脚本里测不出来；
- 第二行报 `zsh: no such file or directory: 配置名`。尖括号在任何 shell 里都是重定向，`<配置名` 是「从文件配置名读输入」；占位符放在行尾时，则直接报语法错误；
- 第三行的省略号让 JSON 解析直接报错。

还有一条示例漏了必填参数，第一次真实执行才发现，说明它从没被跑过。粘贴的人看到的是一屏报错，第一反应是「功能坏了」。

**写法**：

- 一条命令一个代码块，至少一行一条，行内不带注释，解释写在代码块外面；
- 占位符换成真实可用的值。确实要对方填的，用不含 shell 元字符的写法，并在代码块外说明；
- 给工具加一个只打印、不发送的 `--dry` 开关，交出去之前把示例逐条空跑一遍。不花钱、没有副作用的那几条，直接真跑。

## 9. 检查清单

| 检查项 | 写法 |
|---|---|
| 变量后紧跟冒号加字母（`rev:path`、`user:group`） | `${VAR}` |
| 变量后紧跟中文或全角标点 | `${VAR}`；写完用 perl 扫一遍 |
| 给程序看的 `*`、`?`、`[...]` 模式 | 加单引号，或 `noglob` |
| 以 `=` 开头的参数 | 加单引号 |
| 变量名 | 不用 `path`、`fpath`、`cdpath`、`manpath`、`status` |
| 空格分隔的列表传给命令 | `${=VAR}` 或数组 |
| 「命令加参数」的简写 | 函数，不用字符串变量 |
| `grep -E` 的可选组 | `(a)?`，不写 `(a|)`；区分退出码 1 和 2 |
| 计数得 0 | 先看 stderr 有没有报错 |
| 给别人粘贴的命令 | 一行一条、不带行内注释和尖括号，逐条跑过 |

最后一个小插曲。我让助手给这类报错写过自动提示：命令失败时按报错文本匹配，匹配上就把对应的笔记提示出来。其中一条按 `kill: illegal pid` 匹配，从来没触发过，因为 zsh 的真实报错是 `zsh:kill:1: illegal pid`，中间多了函数名和行号。按报错文本做匹配的规则，要拿真实的报错原文去测，不能照着记忆里的样子写。这类 hook 怎么写，见[用 Claude Code 的 hook 往对话里注入上下文](/blog/ai-workflow/claude-code-hooks-inject-context/)。

## 收尾

1. **花括号是默认写法** —— 变量后面紧跟冒号、中文、全角标点，不加花括号就可能被改掉，而且不报错。
2. **引号挡得住 glob，挡不住修饰符** —— `*` 和 `=` 开头的参数加引号就好；`$T:c` 在双引号里照样被吃。
3. **0 命中先看 stderr** —— `no matches found` 和 `empty (sub)expression` 都会让计数变成 0 或空。
4. **`LC_ALL=C` 不是修法** —— 它让中文问题消失，同时也让你找不到根因。
5. **给别人的命令按对方的用法测** —— 交互式 zsh 不认行内注释，尖括号是重定向。

这些坑的共同点是：在 bash 里能跑，就以为在 zsh 里也能跑。我现在的习惯是把写法定死，不靠每次回想规则：变量一律带花括号，模式一律带引号，扫描命令先拿一条该命中的样例跑一遍。环境本身的其他问题，见 [Mac 开发机的日常排障](/blog/tooling/mac-dev-machine-ops/)。
