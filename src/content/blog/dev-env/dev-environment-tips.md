---
title: "开发环境实用技巧合集：Maven Profile / Docker / WSL / 终端输出重叠"
description: "汇总 Maven 多 Profile、查看已停止容器、WSL 访问 Windows 文件、终端流式输出重叠等几个高频小问题及其原理。"
pubDate: 2026-03-06
tags: ["Maven", "Docker", "WSL", "开发环境"]
series: "dev-env"
seriesLabel: "Windows 开发环境排错"
---

> 本文汇总几个独立但高频的开发环境小问题及其原理。

## 一、Maven 同时勾选 dev 和 local 会有影响吗？

Maven Profile 是一套独立的构建配置块，常见的有 `dev`（开发）、`local`（本机调试）、`prod`（线上）：

```xml
<profiles>
  <profile>
    <id>dev</id>
    <properties><db.url>jdbc:mysql://localhost:3306/devdb</db.url></properties>
  </profile>
  <profile>
    <id>local</id>
    <properties><db.url>jdbc:mysql://localhost:3306/localdb</db.url></properties>
  </profile>
</profiles>
```

**同时启用多个 profile 会怎样？**

```bash
mvn clean package -Pdev,local
```

Maven 会合并这些 profile 的配置。同名属性冲突时，**POM 里后声明的 profile 覆盖先声明的**，和 `-P` 后面写的顺序无关。Maven 官方文档「Profile Order」一节写明：同一个 POM 里多个 profile 同时激活时，后定义的优先，和 profile id、激活顺序都无关。

| 情况 | 结果 |
|------|------|
| 两个 profile 设不同属性 | 都保留 |
| 两个 profile 设相同属性（如 `db.url`） | POM 里后声明的覆盖先声明的；上例中 `-Pdev,local` 和 `-Plocal,dev` 结果都是 `localdb` |
| 不同依赖版本差异大 | 可能编译成功但运行异常 |

**结论**：同时勾选不会报错，但可能造成配置互相覆盖。**建议每次只启用一个 profile**。Spring Boot 项目通常无需多 profile 同时打包，运行时指定即可：

```bash
java -jar app.jar --spring.profiles.active=dev
```

---

## 二、查看 Docker 已停止的容器

`docker ps` 默认只显示运行中的容器，加 `-a` 显示全部：

```bash
# 所有容器（运行 + 停止）
docker ps -a

# 只看已停止（Exited）的
docker ps -a --filter status=exited

# 查看退出原因/状态码
docker inspect <容器ID> | grep -A 3 Status

# 清理所有已停止的容器
docker container prune
```

STATUS 列：`Up ...` = 运行中，`Exited (...) ... ago` = 已停止。

---

## 三、WSL 中访问 Windows 本地文件

WSL 与 Windows 文件系统互通。Windows 盘符挂载在 `/mnt/<盘符>`：

| Windows 路径 | WSL 路径 |
|--------------|----------|
| `C:\Users\你\Desktop` | `/mnt/c/Users/你/Desktop` |
| `E:\data\test.txt` | `/mnt/e/data/test.txt` |

```bash
ls /mnt/c                       # 列出 C 盘
cd /mnt/c/Users/你/Desktop       # 进入桌面
explorer.exe .                  # 在当前目录打开 Windows 资源管理器
```

**反向访问**（Windows 看 WSL 文件）：资源管理器地址栏输入 `\\wsl$`，可看到各发行版的 Linux 文件系统。

**路径互转**：

```bash
wslpath -w /mnt/d/Projects/MyApp        # WSL → Windows: D:\Projects\MyApp
wslpath "C:\Users\你\Desktop"            # Windows → WSL: /mnt/c/Users/你/Desktop
```

> 注意：在 `/mnt/c` 频繁读写大量小文件会比 WSL 自身 ext4 慢；不要改 `/mnt/c/Program Files` 等系统目录。

---

## 四、管理员模式 CMD/PowerShell 与流式输出「行重叠」

现象：在管理员模式终端里看流式输出，输出行重叠、闪烁、覆盖错乱。管理员模式下代理表现也不一样，那是另一个问题，见 [Windows 代理之谜](/blog/dev-env/windows-proxy-mystery/)。

**原因**：流式输出（streaming）会用 ANSI/VT100 控制码（如回车 `\r`、清行 `\x1b[K`）原地刷新当前行。传统控制台窗口（conhost）里，VT（Virtual Terminal）序列解析要由程序自己调用 `SetConsoleMode` 打开 `ENABLE_VIRTUAL_TERMINAL_PROCESSING`，或者在注册表里全局打开，和是不是管理员无关。程序和宿主窗口都没打开时，控制符没被正确理解，旧文本没被清除，新内容叠上去：

```text
我
我懂
我懂了
我懂了我懂你...   ← 每次少清几位旧内容
```

**解决方案**：

| 方法 | 说明 |
|------|------|
| 用 **Windows Terminal** | 完整支持 ANSI/VT，不会重叠（推荐） |
| 用 **VS Code / IDEA 内置终端** | 同样支持流式刷新（实测可用） |
| 用 **WSL / Linux bash** | 原生 VT 控制台 |
| 必须用传统 CMD 时 | 开启注册表 VT 支持：<br>`reg add HKCU\Console /f /v VirtualTerminalLevel /t REG_DWORD /d 1` |

**一句话**：行叠加、闪烁是因为当前控制台没有开 VT 序列解析，流式刷新的控制符没被渲染。管理员模式下更容易碰到，是因为从开始菜单或右键「以管理员身份运行」打开的 CMD / PowerShell，在默认终端没改成 Windows Terminal 的系统上（比如 Windows 10）落在传统 conhost 窗口里，而平时用的是 Windows Terminal 或 IDE 终端。日常调试流式输出请优先用 Windows Terminal / VS Code / IDEA 终端。
