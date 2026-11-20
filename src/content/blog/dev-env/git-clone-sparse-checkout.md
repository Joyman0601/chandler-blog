---
title: "Git 克隆大仓库失败与稀疏检出实战排错"
description: "克隆 RuoYi-Vue-Plus 这类大仓库时碰到 early EOF、稀疏检出找不到模块、推送连不上本地代理三个问题：浅克隆和按需拉取先克隆下来，sparse-checkout 只检出要的模块，再清掉残留的 Git 代理。"
pubDate: 2025-12-20
tags: ["Git", "排查", "开发环境"]
series: "dev-env"
seriesLabel: "Windows 开发环境排错"
---

> 本文整理自一次实际操作 RuoYi-Vue-Plus 仓库时遇到的克隆失败、稀疏检出与代理冲突问题。

## 一、克隆大仓库时的 `early EOF` 错误

克隆大型仓库（如 Gitee 上的 RuoYi-Vue-Plus）时常见报错：

```text
error: RPC failed; curl 56 Failure when receiving data from the peer
error: 2241 bytes of body are still expected
fetch-pack: unexpected disconnect while reading sideband packet
fatal: early EOF
fatal: fetch-pack: invalid index-pack output
```

**根因**：网络传输中途断开。在网络不稳定 + 仓库体积大时尤其常见。

### 解决方案（按推荐顺序）

**1. 浅克隆，减少传输量**

只要最新代码、不需要完整历史时最有效：

```bash
git clone --depth 1 https://gitee.com/dromara/RuoYi-Vue-Plus.git
```

后续若需要补全历史（**必须先 `cd` 进仓库目录**）：

```bash
cd RuoYi-Vue-Plus
git fetch --unshallow
```

> 注意：在仓库外层目录执行 `git fetch --unshallow` 会报
> `fatal: not a git repository`，因为当前目录不是 git 仓库。

**2. 部分克隆，先不下载文件内容**

`--filter=blob:none` 让 Git 先只拉提交和目录结构，文件内容等检出时才按需下载。一次要传的数据变少，断线的机会也跟着变少：

```bash
git clone --filter=blob:none https://gitee.com/dromara/RuoYi-Vue-Plus.git
```

> 更正：这一步原来写的是调大 `http.postBuffer` 和 `http.maxRequestBuffer`，两条都不管用。`http.postBuffer` 只管 Git 向服务器 POST 的数据，克隆时大块数据是服务器回的响应，调它没用；`http.maxRequestBuffer` 不是 Git 的配置项。

**3. 换用 SSH 或镜像**

```bash
git clone git@gitee.com:dromara/RuoYi-Vue-Plus.git
```

**4. 检查网络**

`curl 56` 多为丢包/连接被关闭，可尝试有线网络、更稳定的 Wi-Fi 或临时热点。

---

## 二、稀疏检出（sparse-checkout）只下载部分模块

浅克隆 + 稀疏检出可以只检出需要的子模块，速度快、占用小：

```bash
git clone --depth 1 --filter=blob:none --sparse https://gitee.com/dromara/RuoYi-Vue-Plus.git
cd RuoYi-Vue-Plus
git sparse-checkout set --cone ruoyi-admin ruoyi-framework
```

`--sparse` 让克隆完只检出根目录的文件，`set` 再指定要哪些目录。旧写法 `git sparse-checkout init --cone` 已被官方文档标为弃用，现在一条 `set --cone` 就够了。

进入稀疏模式后，命令行分支提示会变成 `(5.X|SPARSE)`。

### 常见问题：提示某模块找不到

例如运行时提示 `ruoyi-common/extend/modules` 模块找不到。

**原因**：稀疏检出只检出了 `set` 指定的目录，其它目录仍在远程但未检出到本地。

**解决方法**：

```bash
# 方法 1：追加需要的目录（可写完整深层路径），add 在现有列表上追加
git sparse-checkout add ruoyi-common/extend/modules

# 也可以用 set 重列一遍，set 会整体替换列表，原来的目录要一起写上
git sparse-checkout set ruoyi-admin ruoyi-framework ruoyi-common

# 方法 2：彻底关闭稀疏检出，检出全部文件
git sparse-checkout disable

# 方法 3：确认远程分支上是否真的存在该路径
git ls-tree -r origin/5.X --name-only | grep "ruoyi-common/extend/modules"
```

若方法 3 无输出，说明该路径在当前分支上确实不存在（可能版本/目录重构），需确认分支是否正确（如 `5.X`、`master`），用 `git branch -a` 查看分支列表。

---

## 三、Git 推送时的本地代理报错

```text
fatal: unable to access 'https://github.com/.../xxx.git/':
Failed to connect to 127.0.0.1 port 7890 after 2092 ms: Couldn't connect to server
```

**原因**：之前用 `setx` 设置过[代理环境变量（永久变量）](/blog/dev-env/windows-proxy-mystery/)，Git 会读取它并尝试走 `127.0.0.1:7890`，但代理程序此刻没运行，端口无人监听 → 连接失败。

```bash
setx http_proxy http://127.0.0.1:7890
setx https_proxy http://127.0.0.1:7890
```

### 解决方法

```bash
# 取消 Git 代理（全局）
git config --global --unset http.proxy
git config --global --unset https.proxy

# 清空系统环境变量代理（覆盖为空）
setx http_proxy ""
setx https_proxy ""

# 验证当前 Git 是否还在用代理
git config --global --get http.proxy
git config --global --get https.proxy

# 验证环境变量（Windows CMD）
echo %http_proxy%
echo %https_proxy%
```

> 也可到「系统设置 → 高级系统设置 → 环境变量」里手动删除 `http_proxy`、`https_proxy`，**删除后需重新打开命令行窗口**才生效。

---

## 小结

| 场景 | 关键命令 |
|------|---------|
| 大仓库克隆失败 | `git clone --depth 1` |
| 补全历史 | `cd 仓库 && git fetch --unshallow` |
| 只要部分模块 | `git sparse-checkout set --cone 模块...` |
| 追加模块 | `git sparse-checkout add 模块...` |
| 恢复全部文件 | `git sparse-checkout disable` |
| 取消 Git 代理 | `git config --global --unset http.proxy` |
