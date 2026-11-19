---
title: "Windows 代理之谜：为什么管理员模式不用开代理就能连"
description: "梳理 Windows 的三层代理和 Clash 的 TUN 模式、Java 默认的代理行为，以及「管理员模式能直连」这个还没复现查清的现象该怎么验证。"
pubDate: 2026-01-18
tags: ["Windows", "代理", "网络", "开发环境"]
series: "dev-env"
seriesLabel: "开发环境与排错"
---

> 本文记录一个困惑我的现象：普通模式必须开代理才能访问外部 API，
> 管理员模式却能直连；以及 Clash「系统代理」和控制面板「LAN 设置」为何不同步。前者的原因我还没查清，第四节写了推测和验证方法。

## 现象描述

- **普通模式** CMD/PowerShell/IDEA：必须开代理（Clash）才能和外部 API 对话，否则一直 `retrying`。
- **管理员模式**：不开代理、不设 `setx` 也能正常对话。
- 更诡异：普通模式下 `echo %http_proxy%` **为空**，`netsh winhttp show proxy` 也显示「直接访问」，却依然连不上。

---

## 一、Windows 的三层代理体系

很多人以为代理只有一处开关，其实 Windows 有**三套互相独立**的代理机制：

| 层级 | 控制位置 | 谁在用 | 与 `netsh winhttp` 同步 |
|------|---------|--------|------------------------|
| **WinINET 代理** | 控制面板 → Internet 选项 → 连接 → LAN 设置 | IE、Chrome、绝大多数桌面程序 | 不同步 |
| **WinHTTP 代理** | `netsh winhttp show/set proxy` | Windows Update、部分命令行/服务 | 就是这一层 |
| **环境变量代理** | `http_proxy` / `https_proxy` | curl、Python、Go 等命令行工具和运行时（各自约定是否读取） | 不同步 |

Java 默认不在这三层里。它既不读 WinINET 系统代理，也不读 `http_proxy` 环境变量，代理要靠启动参数指定：

- `-Dhttps.proxyHost=127.0.0.1 -Dhttps.proxyPort=7890`（HTTP 请求用 `http.` 开头的同名参数）；
- 或 `-Djava.net.useSystemProxies=true`，让 Java 去读系统代理设置。这个开关默认是 `false`。

> 更正：这张表原来把 Java 同时列进了 WinINET 和环境变量两层，两处都不对。依据是 Oracle 的 Java 网络属性文档：`http.proxyHost` 等默认为空，`java.net.useSystemProxies` 默认为 `false`。

关键结论：**这三层互不同步**。`netsh winhttp` 显示「直接访问」、环境变量为空，并不代表没有代理在生效——可能是 **WinINET 层**或 TUN 模式（代理软件建一块虚拟网卡，在网卡层接管流量）在拦截流量。

---

## 二、为什么环境变量为空却仍被代理影响

如果用过 Clash / V2RayN 等工具，它的「系统代理」开关可能：

1. **写 WinINET 注册表**（旧版 Clash for Windows）：

```bash
reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyEnable
reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyServer
```

若返回 `ProxyEnable=0x1`、`ProxyServer=127.0.0.1:7890`，说明 WinINET 层代理已启用，且**只对当前用户生效**。

2. **启用 TUN / 虚拟网卡模式**（Clash Verge、Metacubex、新版 CFW）：
   - 不改注册表，而是通过系统网络驱动直接接管所有出站流量转发到本地端口。
   - 因此控制面板 LAN 设置里**那一项始终不勾选**，但流量照样被劫持。

---

## 三、Clash「系统代理」≠ LAN 设置勾选项

这正是开头疑问的答案：

| 现象 | 含义 |
|------|------|
| Clash 开系统代理，LAN 设置**有勾** | Clash 正在修改 WinINET 注册表（HTTP 代理模式） |
| Clash 开系统代理，LAN 设置**没勾** | Clash 实际启用 **TUN / FakeIP 模式**，直接劫持网卡流量 |

判断当前模式：
- 看 Clash 日志是否有 `TUN Mode: ON`；
- 或查注册表 `ProxyEnable`：`0x1` 走 HTTP 代理，`0x0` 但仍能上网 = TUN 拦截。

---

## 四、为什么管理员模式行为不同（我的推测，未复现验证）

当时我的解释是「管理员账户不继承普通用户的代理设定，所以直连出网」。这个解释站不住：

- 用 UAC「以管理员身份运行」时，通常还是同一个用户，只是拿到了提权后的令牌。`HKCU` 下的 WinINET 设置是同一份。
- TUN 模式工作在网卡层，是系统级的，不区分哪个用户、有没有提权。

所以「管理员模式能直连」的真实原因我没有查清。可能的方向有：两种模式下跑的其实不是同一个客户端或同一套配置；提权后的进程环境变量不同；或者当时代理软件的状态前后变过。这些都没有复现记录，只是推测。

要验证，可以按下面的步骤各做一遍，两种模式用同一个客户端：

1. 关掉代理软件的系统代理和 TUN，记下状态。
2. 普通终端和管理员终端各跑一次 `whoami`、`set | findstr /i proxy`，确认用户和环境变量是否相同。
3. 两个终端用同一条命令访问外部接口，例如 `curl -v https://目标地址`，看连接的是哪个 IP、是否经过 `127.0.0.1:7890`。
4. 再访问一个回显出口 IP 的服务，对比两边的实际出口。
5. 打开代理软件的连接日志，看两次请求有没有经过它。

出口相同、日志都没有记录，说明两边都是直连，差别在客户端；出口不同，再顺着进程环境和代理规则查。

---

## 五、VPN / 代理为何让 HTTPS「发得出去、收不回来」

一个相关现象：本地接口（如 `/api/rag/ask`）开 VPN 时报
`Remote host terminated the handshake`（TLS 握手被中断）。

链路其实是：

1. Postman 调本机 `localhost:19090/api/rag/ask`；
2. Spring Boot 在内存里做 embedding 检索；
3. Spring Boot 调外部大模型的 HTTPS 地址，**这一步受代理影响**；
4. Spring Boot 把答案返回给 Postman。

Postman 访问 `localhost` 不受影响，但 **Java 进程访问外部 HTTPS** 会受代理影响。开 VPN 时握手被断的常见原因：

- 域名被代理软件解析成 fake-ip（代理软件返回的占位地址，如 `198.18.x.x`），代理一关，连接就指向不存在的地址；
- 浏览器、Postman 走系统代理，但 Java 进程默认不走系统代理，也不读 `http_proxy` 环境变量；
- TUN 接管流量，但 Java 的 TLS 连接与代理链路不兼容，握手被断。

---

## 六、排查与解决命令清单

```bash
# 查 WinHTTP 层
netsh winhttp show proxy

# 查 WinINET 层（用户级系统代理）
reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyEnable
reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyServer

# 查环境变量
echo %http_proxy%
echo %https_proxy%
```

解决方式：

```bash
# 关闭 WinINET 系统代理
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" /v ProxyEnable /t REG_DWORD /d 0 /f

# 重置 WinHTTP 代理
netsh winhttp reset proxy
```

- 或在 Clash GUI 里关掉「System Proxy / TUN 模式」开关；
- Java 进程要走代理：启动参数加 `-Dhttps.proxyHost=127.0.0.1 -Dhttps.proxyPort=7890`，或加 `-Djava.net.useSystemProxies=true` 让它跟随系统代理；
- Java 进程要直连：去掉上面这些参数即可。`useSystemProxies` 默认就是 `false`，再显式写一遍不起作用；TUN 模式在网卡层接管流量，Java 参数管不到，要在代理软件里关 TUN 或加直连规则；
- 若确实需要代理：保持代理程序运行，确保 `127.0.0.1:7890` 有进程监听。

---

## 一句话总结

> Windows 上的代理分 WinINET、WinHTTP、环境变量三层，外加代理软件的 TUN 模式，即使环境变量和 WinHTTP 都为空，流量仍可能被接管；Java 默认三层都不读。管理员模式能直连的原因我还没复现查清。Clash 的「系统代理」开关与控制面板「LAN 设置」并非同一套机制。
