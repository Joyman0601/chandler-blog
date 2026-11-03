---
# import-articles-sha256: 5294e9098906a955f1a803ad254425bd01d016614dc0d1ef62fc5764281bea88
# Imported by scripts/import-articles.mjs from posts/frontend/first-load-bundle-lighthouse.md
# Source date: 2026-09-29
title: "首屏包体与 Lighthouse：共享注册表把全量文案打进首屏"
description: "一个迁移完的页面 Lighthouse 稳定比同类页面低 3 分。查出两个原因：复用的共享估算器把全量注册表和多语言文案带进首屏，HTML 又刚好跨过模拟网络的一个 RTT 阈值。顺带记下本地生产构建会打到正式第三方、本地命令给出假结果这两类坑。"
pubDate: 2026-08-15
tags: ["前端","性能","Lighthouse","Next.js","开发环境"]
series: frontend
seriesLabel: "前端实践"
---

> 一句话总结：复用共享组件前先看它背后 import 了什么，不在首屏的大模块用 `next/dynamic` 加 `ssr: false` 移出去；比较 Lighthouse 分数前先排除 HTML 跨过 RTT 阈值的阶梯效应，至少跑 3 次取中位数，并且在请求层拦住正式的第三方。

## 0. 起因：两个同类页面，分数稳定差 3 分

页面迁移做完后要过一道性能验收：Lighthouse 移动端性能分不低于 90，跑 3 次取中位数，并且和一个已上线的同类页面同条件对比。

有一个图像模型页的分数稳定比对照页低。不是某一次低，是每一轮都低，差 1–2 分，最多 3 分。两个页面的结构几乎一样，首屏 JS 的传输量也差不多。一开始当成了波动，多跑几次以后排除了这个解释。

最后查出两个原因，叠在一起：

1. 价格区复用的一个共享组件，把一个覆盖几十个模型的注册表和一份多种语言的文案整个带进了首屏包；
2. 页面的 HTML 文档刚好比 Lighthouse 模拟网络的一个阈值多了几百字节，凭空多等了一轮 RTT（往返时延）。

这篇先讲这两个原因，再讲跑 Lighthouse 时自己踩到的两类环境坑：本地生产构建会连到正式的第三方服务，以及本地命令给出的假结果。

## 1. 共享估算器：为了「同数」，带进了全量数据

**现象**：低分的页面 TBT（总阻塞时间）比对照页多了约 60ms。`mainthread-work-breakdown` 里脚本执行时间明显更长，注水（hydration）阶段多出一段长任务。对比两边的 chunk，多出来的那个只出现在几个复用了同一个估算器的页面上。

**根因**：价格区要和站点的价格总览页永远显示同一个数，最直接的办法是复用总览页的估算器组件。这个组件在模块顶层从一个覆盖几十个模型的注册表里取自己的配置，调用方又从总览页的多语言文案里取文案。注册表和文案都是大对象字面量，tree-shaking 摇不掉，整个进了首屏包，注水时还要全部执行一遍。

传输量差得不多，是因为这类数据压缩率很高；但执行时间不看压缩后的体积，这就是 TBT 能差出 60ms 的原因。

**修复**：把用到估算器的那一小块拆成单独的客户端文件，大注册表和文案只在这个文件里 import，调用方改成按需加载。

```tsx
// PricingSection.tsx：调用方不再静态引入估算器
import dynamic from 'next/dynamic'

const SharedEstimator = dynamic(() => import('./SharedEstimator.client'), {
  ssr: false, // ← 关键：只在客户端加载，不进首屏包
  loading: () => <div className="h-[420px] md:h-[360px] lg:h-[320px]" aria-hidden />, // 按实测高度占位
})

export function PricingSection() {
  return (
    <section id="pricing">
      {/* 首屏需要的静态内容照常渲染 */}
      <SharedEstimator />
    </section>
  )
}
```

几个细节：

- **为什么要 `ssr: false`**。当时的分析结论是：App Router 下默认的 `ssr: true` 仍会在 HTML 里预载这个 chunk，只有关掉服务端渲染才能真正移出首屏。这一条没有单独做对照实验验证，是读文档和产物得出的。
- **占位高度要实测**。各个断点都量一遍估算器加载后的真实高度，`loading` 占位设成同样的高度，否则加载完成时页面会跳，CLS（累计布局偏移）变差。改完 CLS 是 0（实测）。
- **测试要改成异步等待**。组件变成异步挂载以后，原来的 `getBy…` 会在它出现之前就找，要改成 `await findBy…`。

最后加一条守卫，防止以后有人又把它改回静态引入。断言打在「模块有没有被执行」这个行为上，而不是去 grep 源码：

```ts
// PricingSection.guard.test.ts：渲染调用方时，大注册表模块不应该被执行
const mockEvaluated: string[] = [] // jest.mock 工厂只能引用 mock 开头的变量
jest.mock('@/data/modelRegistry', () => { mockEvaluated.push('registry'); return { registry: {} } })
jest.mock('@/messages/pricingOverview', () => { mockEvaluated.push('copy'); return { copy: {} } })

test('价格区首屏不加载全量注册表和多语言文案', async () => {
  const { PricingSection } = await import('./PricingSection')
  expect(PricingSection).toBeDefined()
  expect(mockEvaluated).toEqual([]) // 静态引入时这里会是 ['registry', 'copy']
})
```

**结果**（实测，同一轮）：

| 指标 | 改前 | 改后 | 同类对照页 |
|---|---|---|---|
| 首屏 JS | 275 kB | 223 kB | — |
| Lighthouse 性能分 | 82 | 89 | 85 |
| TBT | 82ms | 26ms | — |
| CLS | — | 0 | — |

**代价**：估算器不再出现在服务端渲染的 HTML 里。这对 SEO 影响很小（它是交互组件），但还是写进了交付说明。更彻底的做法是把注册表按模型拆、文案按语言拆，让所有用到它的页面都受益，那要动共享代码，不在这次的范围里。

## 2. HTML 多了 404 B：Lantern 的 RTT 阶梯

估算器移出去以后分数上来了，但还有一个奇怪的地方：低分页面的 FCP（首次内容绘制）、速度指数，以及文档解析任务的起点，都比对照页整齐地晚了约 150ms。`render-blocking` 这类审计两边完全一样。

**根因**：Lighthouse 默认的移动端节流不是真的限速，而是模拟出来的。它的模拟器叫 Lantern，参数是 RTT 150ms、吞吐 1638.4 Kbps，按 TCP 慢启动一轮一轮估算下载时间。按 Lighthouse 13 源码里的参数复算：初始拥塞窗口 10 段，之后每轮翻倍，上限 21 段，每段 1460 B。

```text
10 + 20 + 21 = 51 段 × 1460 B = 74,460 B   ← 一个轮次边界
```

HTML 文档的传输大小（压缩后）一旦超过这个边界，哪怕只多一个字节，也要整整多等一个 RTT。这 150ms 会把 FCP、LCP 和后面依赖它的所有请求一起往后推，分数阶梯式下降。

那个页面正好踩在这里（实测）：

- 文档 74,864 B，超出边界 404 B，FCP 1.96s；同类页面 1.81s。
- 估算器改成仅客户端加载以后，它不再出现在 HTML 里，文档降到 73,746 B，FCP 回到 1.51s。这一轮里还有 JS 减少的影响，不全是 RTT 的功劳。

查这个问题，看 Lighthouse 报告 JSON 里的两个字段就够了：

```bash
# 文档的传输大小，以及第一个长任务（文档解析）的开始时间
node -e '
const r = require(require("path").resolve(process.argv[1]));
const doc = r.audits["network-requests"].details.items.find((i) => i.resourceType === "Document");
const first = r.audits["long-tasks"].details.items[0];
console.log("document transferSize:", doc.transferSize, doc.transferSize > 74460 ? "← 跨过阈值" : "");
console.log("first long task start:", first && first.startTime);
' ./lh-run-1.json
```

两个页面一个在阈值上、一个在阈值下，第一个长任务的开始时间就会整齐地差约 150ms。

这个阶梯只在 Lantern 模拟下成立。改了 RTT、吞吐，用桌面预设，或者用 `--throttling-method=devtools`，阈值都会变或者不存在。真实用户多下几百字节几乎感觉不到。它的意义在于：**离阈值很近的页面，加一点内容就可能掉 1 分以上**。和同类页面比较时，先排除它，再去怀疑代码。

## 3. 跑 Lighthouse 的几条规矩

单次 Lighthouse 分数的波动比预想的大。一次验收里，同一个页面 5 次的分数是 96、94、93、87、87，中位数 93；对照页是 90、93、94、90、91，中位数 91（实测）。只跑一次，两个页面谁高谁低完全可能反过来。

后来固定的做法：

1. **至少 3 次取中位数**，3 次不稳就加到 5 次。
2. **服务启动后先预热一次，不计分**。第一次是冷启动，分数会低几分：有一次冷启动跑出 88，预热后是 91。
3. **两个页面交替跑**，不要先跑完 A 的 5 次再跑 B。机器状态随时间变化，交替跑能让两边吃到同样的干扰。
4. **`NO_NAVSTART` 就重跑**。Lighthouse 偶尔报这个错，是录制失败，和页面无关。自动重跑一次，并让两页的有效次数一致。

写成脚本大概是这样：

```bash
#!/usr/bin/env bash
# lh-compare.sh：两页交替跑，各预热一次，各取 5 次有效结果
set -u
A="$1"; B="$2"; N=5
run() { npx lighthouse "$1" --port=9222 --only-categories=performance \
          --output=json --output-path="$2" --quiet; }

run "$A" /dev/null; run "$B" /dev/null          # 预热，不计分
for i in $(seq 1 "$N"); do
  for page in A B; do
    url="${!page}"; out="lh-${page}-${i}.json"
    until run "$url" "$out" && ! grep -q NO_NAVSTART "$out"; do
      echo "重跑 $page #$i"
    done
  done
done
for page in A B; do
  printf '%s: ' "$page"
  for f in lh-"$page"-*.json; do node -p "Math.round(require('./$f').categories.performance.score*100)"; done \
    | sort -n | tr '\n' ' '; echo
done
```

`--port=9222` 是因为要自己启动 Chrome，再让 Lighthouse 连上去，原因在下一节。

## 4. 本地生产构建，会打到正式的第三方

Lighthouse 要在生产构建上跑才有意义，于是在本地做了一次生产构建。构建日志里写着：同时加载了本地环境文件和生产环境文件。

**第一层问题：环境文件是合并的**。本地文件只覆盖同名键，本地没有的键（统计 ID、客服插件的地址和 token）取的是生产值。也就是说，本地跑的每一次 Lighthouse，页面都会加载正式的统计脚本和客服插件。

先用 Lighthouse 的 `--blocked-url-patterns` 拦了统计和客服的域名，统计请求确实变成了 0。但控制台出现了一条 frame-ancestors 的报错，指向客服的域名。翻网络记录，每次运行都有一次对正式客服 `/widget` 的 Document 请求，返回 200。18 次运行就是 18 次请求（实测）。

**第二层问题：URL 拦截管不到跨进程的 iframe**。`--blocked-url-patterns` 作用在主页面上，客服插件的 iframe 是跨进程的独立目标，拦截规则没有带到它身上。客服系统加载 widget 时可能会创建匿名访客，测试流量就进了正式的客服后台。漏出去的那几轮结果删掉了，换了拦截方式重跑，影响（哪个系统、多少次、什么时间）如实写进了给验收人的说明。

**修复**：自己启动 Chrome，给它单独配一个 PAC（代理自动配置）文件，把要拦的域名指向一个不存在的代理，再让 Lighthouse 连上这个 Chrome。PAC 对所有进程都生效，包括跨进程的 iframe（实测）。

```js
// block.pac：要拦的宿主域名指向不存在的代理；不写「; DIRECT」就不会回退
function FindProxyForURL(url, host) {
  if (host === 'localhost' || host === '127.0.0.1') return 'DIRECT'
  if (dnsDomainIs(host, 'analytics.example.com') ||
      dnsDomainIs(host, 'chat-widget.example.com') ||
      dnsDomainIs(host, 'chat-sdk.example.com')) return 'PROXY 127.0.0.1:9'
  return 'DIRECT' // 本机有系统代理时换成它，保持测量条件不变
}
```

```bash
PAC=$(base64 < block.pac | tr -d '\n')
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless=new --remote-debugging-port=9222 --user-data-dir="$(mktemp -d)" \
  --proxy-pac-url="data:application/x-ns-proxy-autoconfig;base64,${PAC}" &
npx lighthouse http://localhost:3000/<页面> --port=9222 --output=json --output-path=lh-1.json
```

中间试过两条不通的路：

- **`--host-resolver-rules` 做 DNS 层拦截**。本机开着系统 HTTP 代理时，Chrome 把域名交给代理去解析，这条规则被绕过了：映射成 `~NOTFOUND` 以后，请求照样返回 200（实测）。hosts 文件推断同理，没测。先用 `scutil --proxy`（macOS）看有没有系统代理。
- **按文件名拦**。在 Playwright 里一开始用文件名的正则拦，只拦到了同源的客服 SDK 文件；SDK 随后对客服宿主域发的 `/widget` 请求没被拦。拦截表要列宿主域名：统计域、客服宿主域、SDK 所在域各一条。

Playwright 那边简单一些：在 context 上注册的 `route` 对 iframe 同样生效。拦完还要用监听器核实，不能只看控制台：

```ts
// 按宿主域名拦截，并核实拦截确实生效
const BLOCKED = new Set(['analytics.example.com', 'chat-widget.example.com', 'chat-sdk.example.com'])
await context.route((url) => BLOCKED.has(url.hostname), (route) => route.abort())

const leaks: string[] = []
page.on('requestfailed', (r) => console.log('已拦截', new URL(r.url()).hostname))
page.on('response', (r) => { if (BLOCKED.has(new URL(r.url()).hostname)) leaks.push(r.url()) })
// …跑完第一个页面就检查一次
if (leaks.length) throw new Error(`第三方请求漏出：${leaks.length} 次`)
```

核对泄漏也要按宿主域名比对。用 URL 子串（「包含 chat」）会把同源的 `localhost/…chat-sdk.js` 误报成泄漏。

还有三个小坑：

- 用 Playwright 的 `connectOverCDP` 连上自起的 Chrome 验证 PAC 时，结束不要调 `browser.close()`。对 CDP 连上的浏览器，它会把那个 Chrome 关掉，后面 `lighthouse --port` 就一直等端口。
- **每跑完一次就检查**报告的 `network-requests` 里有没有被拦域名（状态码在 1–599 之间就算漏了），一旦发现立即中止，不要等全部跑完。
- 只做验收时，直接调底层命令（`next build`、`next start -p <端口>`）。仓库的构建脚本可能有 `pre` 钩子改写受跟踪的文件，`start` 脚本可能写死了别人正在用的端口。

## 5. 本地命令的假结果：先怀疑工具环境

跑性能验收的那几天，本地命令给过好几次「看起来正常」的假结果。共同点是：命令没真正执行，但输出看起来像成功。

**新 worktree 里 `npx tsc` 报「0 错误」**。git worktree 是干净检出，不带 `node_modules`。`npx tsc` 在本地找不到 TypeScript 的 `tsc`，就去 npm 上装了一个同名的占位包来跑。它的 stderr 是一句 "This is not the tsc command you are looking for"，退出码 1。当时的命令是 `npx tsc --noEmit | grep <文件>`，管道只看 stdout，过滤后什么都不剩。「没有输出」在类型检查里正是成功信号（实测）。

**macOS 没有 `timeout`**。`timeout 600 npx tsc …` 在 macOS 上退出码 127（命令不存在），同样被当成「跑过了」。

**`pnpm install` 退出码 1，但依赖其实装好了**。新版 pnpm 遇到带构建脚本、又没有声明是否允许运行的依赖，会报 `ERR_PNPM_IGNORED_BUILDS` 并以 1 退出，顺手生成一个未跟踪的 `pnpm-workspace.yaml` 模板。依赖其实已经落盘。`pnpm exec next dev` 也会先做这道检查，直接退出，端口一直不通。

**dev server 和 build 共写 `.next`**。包体检查报「构建产物缺少某条路由」，和改动毫无关系；停掉同一目录的 dev server 以后就没了。

现在的固定写法：

```bash
ls node_modules/.bin/tsc || pnpm install --frozen-lockfile   # 判依赖看 .bin，不看退出码
./node_modules/.bin/tsc --noEmit -p tsconfig.json; echo "exit=$?"   # 不用 npx，带上退出码
git status --short                                            # 看有没有工具生成的未跟踪文件
lsof -i :3000 || ./node_modules/.bin/next build               # 构建前确认 dev server 已停
```

给子任务派活时，命令路径也写死成 `./node_modules/.bin/…`，并要求汇报「0 错误」时附上命令和退出码。

## 收尾

1. **复用共享组件前看它 import 了什么** —— 全量注册表和全语言文案是大对象字面量，摇不掉，还要在注水时执行。
2. **不在首屏的就按需加载** —— `next/dynamic` 加 `ssr: false`，占位按实测高度，守卫断言模块没被执行。
3. **分数差 1–2 分先查 RTT 阶梯** —— 看文档 `transferSize` 是否跨过约 74.4KB，第一个长任务是否整齐晚 150ms。
4. **Lighthouse 至少 3 次取中位数** —— 预热、交替跑、`NO_NAVSTART` 重跑。
5. **本地生产构建先拦第三方** —— 按宿主域名拦，iframe 用 PAC，用监听器逐次核实。
6. **判依赖看 `.bin`，不看退出码** —— `npx tsc` 的「0 错误」可能是占位包。

这次排查里最费时间的，是一开始把稳定的分差当成了波动。下次两个页面的分数有稳定差距，我会先把两份报告的 `network-requests` 和 `long-tasks` 并排打出来：多出来的 chunk 和整齐的 150ms，比分数本身更能说明问题。
