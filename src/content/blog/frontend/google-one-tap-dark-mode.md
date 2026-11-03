---
# import-articles-sha256: e779c4c38a30c4f07a4dc5ef8ceb88e553b60ec7150a897b37c83737a27dda41
# Imported by scripts/import-articles.mjs from posts/frontend/google-one-tap-dark-mode.md
# Source date: 2026-10-12
title: "Google One Tap 暗色模式白框：查清根因和条款前提"
description: "线上反馈 Google One Tap 在暗色模式下出现白色矩形、弹窗里也没有条款提示。记录不用真实凭证在本地复现的办法、白框的根因是 color-scheme 不一致、条款「没配置」的前提为什么不成立，以及视觉通过和真实登录通过要分开判定。"
pubDate: 2026-09-17
tags: ["前端","登录","CSS","Playwright","验收"]
series: frontend
seriesLabel: "前端实践"
---

> 一句话总结：One Tap 的白框不是边框，是站点根节点的 `color-scheme: dark` 和 Google iframe 内部文档不一致，浏览器给透明画布补了一层不透明背景；只对 One Tap 的 iframe 设 `color-scheme: normal`，再显式传 `color_scheme` 就能修好。条款链接其实早就配了。视觉修好、登录能不能走通，是两个要分开验的验收点。

## 0. 起因：两个线上问题，「看看线下能不能测」

站点首页接了 Google One Tap：用户没登录时，页面右上角会弹出一张 Google 账号卡片，点一下就能用 Google 账号登录。产品那边报了两个问题（转述）：

1. 系统和站点都是深色、清掉本站 Cookie 以后，在登录注册页以外的任意页面刷新，One Tap 弹窗周围出现一圈白色矩形；
2. 弹窗里没有用户条款和隐私政策的提示。

我拿到问题时问的是：「是还没有设置吗？这些是线上的问题，你看看线下能不能测。」这件事我主要交给 Codex 去查，我负责验收和最后的手测。这篇按查的顺序写：先在本地复现，再找白框的根因，然后核条款的前提，最后讲验证，以及视觉修好以后真实登录为什么要单独验。

## 1. 不用真实凭证，在本地复现

本地环境一开始就有个障碍：没有配 One Tap 的 OAuth Client ID。真实的 Client ID 只对授权过的域名生效，本地拿到也走不通真实登录。

复现的做法是把「Google 那一侧」换成自己的夹具：

- 页面用真实的本地 Next.js 页面，挂原来的 One Tap 组件，不改业务代码；
- 用 Playwright 模拟系统主题、清掉 Cookie；
- 把 Google 的客户端脚本拦下来，换成一段桩代码，它按 Google 的 DOM 结构插一个 iframe；
- iframe 指向另一个端口上的夹具页面，保证它和线上一样是跨域的；夹具页面用 Google 当前公开的外层和内部 CSS，账号内容是假的。

整个过程不发送任何登录凭据。最小化以后大概是这样：

```ts
// repro.spec.ts：系统深色 + 站点深色 + 跨域 iframe，复现白框
import { test } from '@playwright/test'

const FIXTURE = 'http://127.0.0.1:4100/picker.html' // 另一个端口 = 跨域

const GSI_STUB = `
  window.google = { accounts: { id: {
    initialize(opts) { window.__gsiInit = opts },          // 记下传进来的参数，后面断言用
    prompt() {
      const box = document.createElement('div')
      box.id = 'credential_picker_container'
      const f = document.createElement('iframe')
      f.src = '${FIXTURE}'
      f.style.cssText = 'border:0;width:391px;height:220px;background:transparent'
      box.appendChild(f); document.body.appendChild(box)
    },
  } } }`

test('暗色下的 One Tap 白框', async ({ browser }) => {
  const context = await browser.newContext({ colorScheme: 'dark' }) // 模拟系统深色
  await context.route(/accounts\.google\.com\/gsi\/client/, (r) =>
    r.fulfill({ contentType: 'text/javascript', body: GSI_STUB }))
  const page = await context.newPage()
  await page.goto('http://localhost:3000/<任意非登录页>')
  await page.mouse.move(200, 200) // 组件在用户交互后才触发
  await page.waitForSelector('#credential_picker_container iframe')
  await page.screenshot({ path: 'mocked-dark-dark.png' }) // 文件名标明是模拟内容
})
```

用模拟内容截的图，Codex 在文件名和报告里都标明了「模拟账号内容」，和真实账号的截图分开放。它能证明渲染机制，证明不了「线上用户看到的就是这个」。

## 2. 白框不是边框：浏览器补的不透明画布

本地 Chromium 复现出了「深色面板外面一圈白色矩形」（实测）。第一反应是边框，但 Google 外层样式里的 border 已经是 0，白框不是 CSS 边框。

**根因**：站点在深色模式下给根节点设了 `color-scheme: dark`。Google 的 iframe 内部文档没有声明同样的色彩方案。CSS Color Adjustment 规范规定了这种情况：嵌入文档的色彩方案和 iframe 元素所在页面不一致时，浏览器不能让 iframe 的画布保持透明，要给它补一层不透明的背景（文档）。于是本来透明的 iframe 四周，露出了一块浅色画布。

一个不依赖 Google 的最小复现：

```html
<!-- parent.html：站点根节点是 dark -->
<style>:root { color-scheme: dark; background: #111; }</style>
<iframe src="http://127.0.0.1:4100/child.html"
        style="border:0;width:300px;height:160px;background:transparent"></iframe>

<!-- child.html：透明背景，没有声明 color-scheme -->
<style>body { margin: 0; background: transparent; }
       .card { margin: 20px; height: 120px; border-radius: 8px; background: #131314; }</style>
<div class="card"></div>
```

打开 `parent.html`，深色卡片四周会是一圈浅色。在 iframe 上加 `color-scheme: normal`，或者让子文档也声明 `color-scheme: dark`，浅色就没了。

**修复**：子文档是 Google 的，改不了，只能改 iframe 元素这一侧。修复只对 One Tap 的两种 iframe 入口设 `color-scheme: normal`，其他 iframe 保持深色：

```css
/* 只隔离 Google One Tap 的两种 iframe 结构，恢复透明画布 */
#credential_picker_container iframe,
#credential_picker_iframe {
  color-scheme: normal;
}
```

范围要收这么窄，是因为站点里还有别的 iframe（比如嵌入的文档、视频），它们依赖继承来的深色方案。用一条全局的 `iframe { color-scheme: normal }` 会把它们一起改坏。本地回归里专门测了「无关的 iframe 仍然是 dark」。

## 3. 弹窗内部的配色：显式传 color_scheme

白框去掉以后还有一个疑问：Google 弹窗内部的深浅配色，是不是也依赖继承来的色彩方案？隔离了 iframe，会不会让弹窗内部退回浅色？

实测的结论是：系统和站点都是深色时，隔离 iframe 以后，iframe 里的媒体查询仍然读到深色，Google 的深色样式保留，内容背景是 rgb(19,19,20)；浅色时是 rgb(255,255,255)（实测）。

但系统和站点不一致时，弹窗里的媒体查询未必和站点一致，比如系统浅色、站点深色，弹窗就可能是浅色，和站点不搭。Google Identity Services 的 `initialize` 接受一个 `color_scheme` 参数，可以显式指定弹窗用哪种配色（[文档](https://developers.google.com/identity/gsi/web/reference/js-reference#color_scheme)）。初始化时传入站点当前解析出来的主题：

```ts
// 初始化 One Tap 时，用站点自己的主题，而不是系统主题
function resolvedSiteTheme(): 'light' | 'dark' {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light'
}

google.accounts.id.initialize({
  client_id: CLIENT_ID,
  callback: onCredential,
  color_scheme: resolvedSiteTheme(), // ← 新加：系统和站点不一致时服从站点
})
```

有两个边界要写进交付说明：

- **主题只在初始化时读一次**。弹窗出现以后再切站点主题，它不会跟着变。要跟着变就得关掉再重新弹，这会改变原来的触发生命周期，这次没有做。
- **系统深色、站点浅色时，Google 弹窗仍然是深色**（实测）。这一格显式参数没能覆盖，属于 Google 那一侧的行为，单独列出来，不算这次修复的范围。

## 4. 条款：「还没设置」这个前提不成立

第二个问题是「弹窗里没有条款提示」。最直接的猜测是条款链接没配，但这个猜测可以先验证，不用改任何配置。

Chrome 上的 One Tap 已经改走 FedCM（浏览器的联合身份凭证管理接口）。Google 为每个 OAuth Client ID 提供一份公开的 FedCM 客户端元数据，里面就有条款和隐私政策的链接。Codex 从线上公开的 One Tap 脚本里找到实际在用的 Client ID，再在不带 Cookie、不带任何账号凭据的情况下读取这份元数据。返回结果里 `privacy_policy_url` 和 `terms_of_service_url` 都在，指向站点自己的条款页和隐私页（实测）。

所以「没配置」不成立。那为什么用户没看到？Google 的文档区分了两种界面（文档）：

- **首次授权**：这个 Google 账号从没授权过这个站点，会显示同意页，里面有条款和隐私链接；
- **返回用户**：已经授权过，只显示账号选择，不再显示同意文案。

而「清掉本站 Cookie」只清了站点这一侧的登录状态，不等于撤销 Google 那一侧的授权。用老账号复现，看到的是返回用户的界面，本来就没有条款提示。条款问题因此没有改代码，验收方法改成：首次授权的账号和已授权的账号分开测。

## 5. 验证：模拟、线上对照、真机

修复本身只有两个文件、十来行。验证花的时间比修复多得多，因为每一类证据能证明的东西不一样。

**本地模拟**（实测）：

- 已有的主题测试 78 项通过；
- 8 个模拟浏览器场景：系统和站点的四种深浅组合、站点跟随系统、两种 iframe 结构、无关 iframe 仍为深色；
- 登录页和注册页不注入 Google 脚本、不弹 One Tap；
- 桩代码里记下的 `initialize` 参数，`color_scheme` 和实际站点主题一致。

**线上对照**。修复上线以后，在线上页面里用脚本把 iframe 的样式改回旧值，白框能再次出现；恢复新样式，白框消失（实测）。这个反向对照比「修复后没看到白框」有说服力：它证明白框确实是这条样式管的，而不是这次碰巧没触发。

**白框检测器**。手机上肉眼看截图不稳定，Codex 写了一个按像素判断的检测器：在弹窗内容的外圈取一圈像素，统计接近白色的比例。用之前，先拿修复前的旧截图跑一次，必须判出白框（正例）；再拿修复后的截图跑一次，必须判不出（反例）。两头都对了，才拿它去判新截图。

```ts
// white-ring.ts：内容框外圈 6px 内，接近白色的像素占比
import { PNG } from 'pngjs'
import { readFileSync } from 'node:fs'

export function whiteRingRatio(file: string, box: { x: number; y: number; w: number; h: number }) {
  const png = PNG.sync.read(readFileSync(file))
  let white = 0, total = 0
  for (let y = box.y - 6; y < box.y + box.h + 6; y++) {
    for (let x = box.x - 6; x < box.x + box.w + 6; x++) {
      const inside = x >= box.x && x < box.x + box.w && y >= box.y && y < box.y + box.h
      if (inside || x < 0 || y < 0 || x >= png.width || y >= png.height) continue
      const i = (y * png.width + x) * 4
      total++
      if (png.data[i] > 230 && png.data[i + 1] > 230 && png.data[i + 2] > 230) white++
    }
  }
  return white / total // 深色页面上，白框截图接近 1，修复后接近 0
}
```

**真机和其他浏览器**（实测）：

- 一台 Android 16 真机上，「登录注册页不加载 One Tap」的 8 项检查通过，Firefox 四种系统 / 站点主题组合通过，检测器没检出白框；
- 桌面 Chrome 确认实际走的是 FedCM 调用；
- 原生 Safari 的自动化被系统设置挡住了（「允许远程自动化」没开），这一格留作待验。

还有一个提醒写进了验收清单：如果弹窗是浏览器原生的 FedCM 窗口，而不是网页里的 iframe，它根本不受页面 CSS 控制。先在 DOM 里确认弹窗是不是那两个 iframe 节点，再判断修复对它有没有效。

## 6. 视觉通过以后，真实登录要单独验

白框的验证基本完成以后，开始测真实登录。这一步当时没能走完。

**自动化浏览器被 Google 拦了**。脚本打开的浏览器登录 Google 时，被提示「这个浏览器可能不安全」。Google 的帮助文档里，自动化控制正是会触发这个提示的原因之一（文档）。同一台机器上的普通 Chrome 能正常登录 Google。所以这只能说明测试环境的表现，不能当成站点登录的缺陷。脚本也改成：遇到这个提示就立刻停下，不让人反复输入账号。

**我自己手测，结果分成三条**：

| 流程 | 结果 |
|---|---|
| A：普通的「用 Google 登录」按钮 | 通过 |
| B：首页 One Tap | 当时没走通：选完账号后弹窗静默消失，没有验证码，没有报错，也没有进入登录状态 |
| C：主题和条款的组合 | 未完成：多数时候 Google 提示根本不出现 |

**中间有一个被我推翻的推断**。在这之前，Codex 在一次自动化复测里看到 Cloudflare Turnstile 验证码的控件尺寸是 0×0，推断「验证码被藏起来了，用户点不到，所以登录失败」。我手测时验证码一直是可见的，这个推断和我看到的对不上。我们先撤回了这个根因，原来的采样保留，但不再把它当成 B 失败的证据。

这件事给我的教训是：**我手测看到的和脚本采样的 DOM 冲突时，先撤回那个过强的结论**，而不是去解释为什么人工看错了。0×0 可能只是某个时刻的状态，也可能是另一个元素，它本来就不足以支撑「这就是原因」。

**代码里有线索，但还没有证据链**。自动化复测时，Google 的凭证回调确实捕获到了，但验证码 token 是空的，之后也没有发出业务登录请求。读组件代码，有三处可能造成静默结束：

- 拿到 Google 凭证后，最多等 5 秒验证码 token；
- token 为空就直接返回，不提示用户；
- 登录异常被一个空的 `catch` 接住。

这是「可能的原因」，还没有同一轮的完整日志证明实际走了哪个分支。下一步要把整条链关联起来：凭证回调 → 验证码 token 或超时 → Firebase 登录 → 业务后台。不管最后是哪一环，这类「提前 return」和空 `catch` 都应该至少留下一条痕迹：

```ts
// 每个提前结束的分支都留痕，而不是静默 return
async function onCredential(resp: { credential: string }) {
  trace('gsi:credential')
  const token = await waitForCaptchaToken(5000).catch(() => null)
  if (!token) {
    trace('captcha:timeout')
    notify('验证没有完成，请再试一次') // ← 用户至少知道发生了什么
    return
  }
  try {
    await signInWithGoogleCredential(resp.credential, token)
    trace('login:ok')
  } catch (err) {
    trace('login:error', err) // ← 原来这里是空 catch
    notify('登录失败，请改用登录页')
  }
}
```

**提示不出现也有原因**。One Tap 只在本站未登录、并且用户滚动或移动鼠标之后才触发；关闭提示还可能触发 Google 的冷却期，反复关闭会让后面的复测更难触发（文档）。C 流程「多数时候不出现」，可能和这些有关，当时没能确定是哪一项。

最后交付时，结论写成三句话，不合并：

- 白框修复已上线，线上反向对照和真机检查通过；
- 条款链接已配置，首次授权的界面还没有用真实新账号看过；
- One Tap 的真实登录当时在生产环境上没能走完一遍，原因待查；它不算这次白框修复的范围，也不能写成「登录验收通过」。

## 收尾

1. **先换掉第三方那一侧再复现** —— 桩代码加跨域夹具，不发凭证，模拟截图单独标明。
2. **白框先查 color-scheme** —— 父页面和跨域 iframe 的色彩方案不一致，浏览器会补不透明画布。
3. **修复范围收窄到目标 iframe** —— 全局改 iframe 会连带改坏别的嵌入内容。
4. **「没配置」先验证再改** —— 公开元数据能直接读到条款链接；清本站 Cookie 不等于撤销 Google 授权。
5. **检测器先过正反例** —— 旧截图判得出、新截图判不出，才拿去判新证据；线上改回旧样式做反向对照。
6. **人工所见和采样冲突时，先撤回结论** —— 0×0 的控件不足以支撑根因。
7. **视觉、提示回调、最终登录分开验** —— 一项通过不能替另一项打勾。

回头看，这次最容易出错的不是技术，而是「通过」这个词的范围。白框修好、页面不报错、Google 凭证回调来了，每一步都可以被说成「One Tap 修好了」。下次碰到第三方登录组件，我会在动手前先写出验收矩阵：浏览器 × 系统和站点主题 × 授权状态（首次 / 已授权），再把「视觉」「提示」「登录」分成三列，每一格单独填证据。
