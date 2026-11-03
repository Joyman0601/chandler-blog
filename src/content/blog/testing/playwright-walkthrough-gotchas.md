---
# import-articles-sha256: ffed4b026bfa1d0a2095355661eb432bde53ffda0b5f77945af2516143576396
# Imported by scripts/import-articles.mjs from posts/testing/playwright-walkthrough-gotchas.md
# Source date: 2026-10-15
title: "用 Playwright 走查页面、截证据图的一串坑"
description: "让脚本替人点一遍真实页面、再截图当证据时，定位、等待、本地状态、焦点和截图本身都会让结论出错。按出错的位置整理成几组坑，每组附可直接抄的写法和判断规则。"
pubDate: 2026-09-25
tags: ["Playwright","端到端测试","验收","前端","测试设计"]
series: testing
seriesLabel: "测试与验收"
---

> 一句话总结：脚本看到的是 DOM，不是屏幕；判完成要盯状态徽标，不在全文里找词；不花钱地试校验用 `route.abort`；截图前先拦字体和第三方、滚回顶部、移开鼠标；按键没反应先看焦点在谁手里；配原文截图时，「找到了」不等于「看得见」。

## 0. 起因：脚本替人点页面

这几周我带着 AI 编程助手用 Playwright 做了很多走查：在模型页的 Playground 里填表、提交、等结果、换模式；在几档窗口宽度下量排版、查横向溢出；给调研结论里的每个数字截一张原文高亮图；在生产环境用真实账号测一个「只问一次」的首次弹窗。

脚本跑通不难，难的是它报的结果可信。回头整理，误判主要出在六个地方：

1. 定位：脚本找到的元素不是人看到的那个；
2. 等待：把还没完成的状态判成了完成或失败；
3. 本地状态：页面从浏览器存储里恢复了上一次的东西；
4. 焦点：按键根本没进主文档；
5. 截图本身：悬停提示、滚动、字体、窗口宽度带来的伪影；
6. 走查脚本自己的盲区：比对时归一化过头、检查时排除得太宽。

下面按这个顺序讲。所有结论都是实测，例子里的选择器和接口路径是示意。

## 1. 定位：脚本看到的是 DOM，不是屏幕

**大小写**。页面用 CSS `text-transform: uppercase` 把标签显示成大写，源码里还是 `Preview text`。`hasText: 'PREVIEW TEXT'` 找不到它，脚本卡满 30 秒超时。按文本定位一律用不区分大小写的正则。

**隐藏的副本**。有的页面切换模式时，不会卸载另一个模式的表单，只是把它隐藏起来。`locator(...).first()` 经常落到那份看不见的副本上，然后一直报 `element is not visible`，直到超时。选择器加上 `:visible`，或者先按可见性过滤，再取下标。

**`textContent` 会读到脚本里的字**。一个带 FAQ 的页面，问答全文还以结构化数据的形式放了一份在 `<script type="application/ld+json">` 里。拿 `body.textContent` 判断「这句答案在页面上」，脚本标签里的文本也算数，折叠着、用户根本看不见的答案也会判成「在」。想找「包含这句话的最深元素」去点开它，找到的偏偏是那个 `<script>`，点不开。

核一个多语言页面的 FAQ 时，助手第一遍用「在 DOM 里」做判断，全部命中；换成可见性判断，只有一部分可见。改成下面的写法后，逐条展开，全部可见：

```js
// 判可见：innerText 不含 script，也不含折叠内容
const visible = (await page.evaluate(() => document.body.innerText)).includes(fragment)

// 要展开：只在 <details> 里找，取文本时跳过 script / style / noscript，点它的 <summary>
const idx = await page.evaluate(frag => {
  const text = el => {
    let t = ''
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode: n => n.parentElement.closest('script,style,noscript')
        ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    })
    while (w.nextNode()) t += w.currentNode.nodeValue
    return t
  }
  return [...document.querySelectorAll('details')].findIndex(d => text(d).includes(frag))
}, fragment)
if (idx >= 0) await page.locator('details').nth(idx).locator(':scope > summary').click()
// 展开后再用 innerText 核一次
```

## 2. 等待：盯状态徽标，不在整页文本里找词

等生成任务结束时，助手最早写的条件是在整页文本里匹配 `/\bFailed\b/`，命中就判失败退出。结果每一单都「失败」：页面的计费说明里有一句英文，大意是「失败的任务不扣费」，里面正好有 `Failed` 这个词。等待条件要落在状态徽标这类只表达状态的元素上，不要落在可能出现同一个词的自由文本上。

另外两个和「填上了没有」相关的坑：

- **上传器风格的链接输入**，粘贴进输入框还不算填上，要点旁边的「添加」。只粘贴的话，请求体里那个字段还是空串。花钱提交之前，先读页面自己的 JSON 请求预览（很多 Playground 有这个面板），确认字段已经进去。
- **存在浏览器本地的资源**（比如用户自己建的音色、预设）在新开的浏览器上下文里是空的。脚本每次都是干净的上下文，所以流程要走「换一台浏览器后怎么用」的那条路径，比如手动粘贴名字的入口。

## 3. 不花钱地试：只拦你要拦的那个请求

**看客户端校验**。想知道「填了非法值点提交会不会出红字」，又不想真的发请求：

```js
const sent = []
await page.route('**/api/generate', r => { sent.push(r.request().postData()); return r.abort() })
await page.getByRole('button', { name: /generate/i }).click()
// 红字出现 + sent 为空 → 客户端拦住了；sent 非空 → 本来会发出去的 body 就在这里
```

`abort` 之后控制台会多一条 `net::ERR_FAILED`。整理控制台报错时，要把自己造出来的这类排除掉。

**测「只问一次」的弹窗**。首次询问弹窗、只出现一次的引导，一个账号只能看到一次。可我要测的关闭路径有三条：点 ×、按 Esc、勾选后确认。做法是只拦写请求：读设置的 GET 放行，写设置的 PUT 拦掉，并记下本来要发的 body。后端没记成「问过」，刷新后弹窗还会出来，同一个账号就能把 × 和 Esc 都测完，最后一条再真实提交。

```js
const seen = { get: 0, put: [] }
await page.route('**/api/settings*', async r => {
  const q = r.request()
  if (q.method() === 'PUT') { seen.put.push(q.postData()); await r.abort() }
  else { if (q.method() === 'GET') seen.get++; await r.continue() }
})
// …触发弹窗…
if (!seen.get) throw new Error('路由没截到页面的 GET，模式没匹配上，先别关弹窗')
```

关弹窗前那一句检查很重要：要是路由模式没匹配上，PUT 会真发出去，这个账号的一次性状态就用掉了。还要分清拦截能证明什么：它只证明「前端本来会发出什么 body」；「后端随之记成问过」，要靠一次真实提交来证（同一个接口、同样的 body）。

**人工在 DevTools 里模拟接口失败**，也是同一个思路，只是多一步：

1. 先删掉前端对这个接口的本地缓存。很多页面把接口结果带 TTL 存在 localStorage 里，有缓存就根本不发请求，拦了等于没拦。
2. 在 Network 面板里只拦这一个请求，不要按域名拦，否则登录、鉴权一起坏，页面会坏成别的样子。
3. 刷新，看降级表现。
4. 对照：取消拦截、再清一次缓存、刷新，降级表现应该消失。
5. 测完删掉拦截规则。

如果预期就是「页面没有变化」，一定要先确认 Network 里那条请求的状态确实是 blocked。否则「没变化」也可能只是请求被缓存挡住、根本没发。

## 4. 本地状态：结果区会恢复上一单

一个生成页的结果区，会从浏览器存储里恢复最近一次的结果。给演示准备截图时，脚本照常先截「提交前」，图里却已经挂着上一单生成的音频，看上去像没付钱就出了结果。截「提交前」之前，要先清掉这个模型的历史记录，再刷新；清完，状态显示「就绪」。

清的方式也有讲究。同一个模型的草稿键和历史键名字里都带模型名，按「键名包含模型名」去删，会把历史一起删掉：完成后的那条历史行没了，后面也不能再免费重截。所以按完整键名删，草稿和历史分开清：

```js
// 键名以页面实际写的为准，这里是示意
await page.evaluate(([m, clearHistory]) => {
  for (const k of Object.keys(localStorage))
    if (k === `${m}-draft` || (clearHistory && k === `history_${m}`)) localStorage.removeItem(k)
}, [model, false])
await page.reload({ waitUntil: 'domcontentloaded' })
```

草稿每一步都要清。不清的话，表单还挂着上一次加的样本，链接输入框会被藏起来，脚本卡住。历史只在截「提交前」时清。

反过来，结果区能恢复，也就意味着「完成」态可以免费重截。要改取景、补一张完成后的图时，不必再付一次钱：打开页面，先核对恢复出来的确实是付费那一单（名字、任务号对得上），再截，数据沿用付费那次的。

## 5. 按键没反应，先看焦点在谁手里

在生产环境用新账号测那个首次弹窗时，有一条失败了：直接打开或刷新任务日志页，马上点开触发弹窗的那一栏，弹窗出来以后按 Esc 关不掉。

看上去像组件的键盘处理有问题。下结论之前，助手先写了一个脚本，每 100 ms 记录一次 `document.activeElement`，连记 12 秒，同时列出页面上的 iframe：

```js
const timeline = []
const t0 = Date.now()
const timer = setInterval(async () => {
  const who = await page.evaluate(() => {
    const a = document.activeElement
    return a?.tagName === 'IFRAME' ? `iframe#${a.id || a.title}` : (a?.getAttribute('role') || a?.tagName)
  })
  timeline.push([Date.now() - t0, who])
}, 100)
// …触发弹窗，等 12 秒…
clearInterval(timer)
// 找焦点「从弹窗换到别处」的那一刻
```

时间线很清楚：弹窗在 +4724 ms 拿到焦点，+5177 ms 焦点就被页面右下角客服挂件的一个隐藏 iframe 拿走了，前后相隔约 0.45 秒。之后按 Esc，按键进的是那个 iframe，主文档根本收不到。

为了确认组件本身没问题，又做了几组对照：

- 从控制台首页点侧栏进入任务日志：挂件早就加载好了，Esc 能关；
- 先点一下弹窗再按 Esc：能关；
- 用 CDP 列出弹窗上的键盘监听器，再直接向弹窗派发一个合成的 keydown：能关。

所以组件逻辑没问题，问题出在加载时序。结论写成「有条件失败」，附上两种进入路径的对照、复现次数（2 次），以及「Esc 失效时不会保存任何设置，× 和取消照常可用」的影响范围。既不写「Esc 坏了」，也不当成「测试环境问题」放过。

第二天我换一个新账号手测，Esc 能关，这条关闭；前一天的失败条件原样留在记录里。leader 在会上提过一句（转述）：验收点没过时，要给出 console、复现步骤和「是否稳定复现」。这条当时只写了现象，我被问到怎么复现时答不上来。之后每条「有问题」写进报告之前，都先补齐这三样；补不出来，就写「只出现一次、未复现」。

## 6. 截图本身的伪影

截图拿来核版式、交样稿、配证据，最怕图里的东西不是页面真实的样子。

**点完再截**。点击后虚拟鼠标停在被点的元素上，hover 样式和延时 tooltip 会在等待中冒出来；点视口外的元素，页面会先把它滚进视口，截出来是页面中部。有一次量卡片顶部：脚本里量是 378，新开页面量是 382，差的 4 px 正是 `:hover` 上的 `translateY(-4px)`。截一个比一屏还高的元素时，`position: sticky; bottom: 0` 的操作条会被截在卡片顶上，看着像布局 bug。

**卡在等字体**。DOM 都能读了，`page.screenshot()` 却几分钟后才抛超时，调用日志停在 `waiting for fonts to load...`。截图会单独等 `document.fonts` 就绪，页面引的网页字体被代理挂住、既不成功也不失败，就永远等不到。只把 `goto` 改成 `domcontentloaded` 不解决。只核版式时，把字体请求拦掉，回退系统字体；要核的正是字体效果，就给浏览器配好代理。

**浏览器版本对不上**。npx 缓存里的 Playwright 升过级，只认配套的浏览器构建号，`launch()` 报 `Executable doesn't exist`。为一次性脚本不值得下载浏览器，用 `channel: 'chrome'` 直接用本机 Chrome。

**无头 Chrome 命令行的限制**。`chrome --headless --screenshot --window-size=390,844` 截出来像右侧被截断，看着是横向溢出；其实无头 Chrome 的窗口宽度下限是 500，`innerWidth` 实际是 500，截图只是把 500 宽的画面裁成 390。带锚点的地址，遇上 `scroll-behavior: smooth`，截出来是黑图或者停在顶部。手机宽度和截某一节，都换成 Playwright 的 `setViewportSize` 和 `locator.screenshot()`。

**本地生产构建会连到真实的第三方**。生产构建读的是生产环境配置，统计 ID、客服挂件都是正式的。有一次截图阶段，第三方拦截漏了客服挂件的宿主域，正式客服系统收到了约 9 次 widget 请求；请求被对方的 frame 策略拒绝了，但可能留下了匿名访客记录。补上拦截之后才重截。Playwright 在 context 上注册的 `route` 对 iframe 也生效；Lighthouse 的 URL 拦截则管不到跨进程的 iframe。每次跑完都要从网络记录里筛一遍第三方域名，发现漏了立即停下，并告诉相关的人影响了什么系统、多少次、什么时间。

现在每次截图前固定跑这一段：

```js
const browser = await chromium.launch({ channel: 'chrome' })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
// 拦外网字体和第三方（统计、客服挂件）；context 级的 route 对 iframe 也生效
await context.route(/fonts\.(googleapis|gstatic)\.com|analytics|widget/, r => r.abort())
const page = await context.newPage()
await page.goto(url, { waitUntil: 'domcontentloaded' })

async function shoot(path) {
  await page.evaluate(() => {
    window.scrollTo(0, 0)
    for (const a of document.getAnimations()) { try { a.finish() } catch {} }
  })
  await page.mouse.move(5, 5)                    // 移到不会触发 hover 的空白处
  await page.waitForTimeout(800)                 // 等 tooltip 消失、过渡结束
  await page.screenshot({ path })
}
```

要证明的状态，用页面上的数字断言并打印出来，不靠看图。截完先和原图比尺寸，逐张看取景、有没有浮层压住内容；没改的页面保留原图，免得出现一批字节不同却没改的图。

## 7. 给结论配原文截图：「找到了」不等于「看得见」

调研结论里的每个数字，我都想配一张「原文高亮 + 来源地址 + 截图时间」的图。做法是用 Playwright 打开页面，在渲染后的文字里找片段，滚过去、画框、截视口。踩过的坑比想象的多：

- **跨元素找片段**。`up to <b>10</b> images` 这种拆在几个元素里的文字，直接搜搜不到。把所有文本节点拼成一个串、连续空白折成一个空格，同时记住每个字符来自哪个节点，找到后用 Range 取 `getClientRects()`。
- **按命中位置滚动**。只对父元素 `scrollIntoView`，在「整篇就是一个 `<pre>`」的页面上，高亮会落在屏幕外，结果文件却照样记「找到了」。在命中处插一个空 `<span>`，滚到它居中，再删掉。
- **折叠的 FAQ**。地址后面加文本片段 `#:~:text=<片段>`，Chrome 会自动展开那一条，不用写点击脚本。
- **确认看得见**。画框前取原文第一个矩形的中心点，`document.elementFromPoint` 命中的必须是原文所在的元素或它的子元素。不是的话，原文在没展开的区块里、被裁掉或者被盖住了，截图里不会有它，顶栏却照样写着「高亮：……」。
- **动画**。段落淡入上移时，量到的是动画中途的位置，框会画在原文上方几十像素。量之前把 `document.getAnimations()` 全部 `finish()`；画完过 0.4 秒再量一次，位置变了就重画。
- **多处命中**。同一句话常在页面里出现好几次（移动端导航、折叠菜单），只取第一处会框到看不见的副本。逐个滚过去做命中测试，取第一处看得见的。
- **图号错位**。图号按「截成功的顺序」编，一个片段没截到，后面的图就全部错位：记录里挂的是「第 3 张」，实际是另一段原文。核验时要打开图对内容；能用片段做文件名更好。

```js
// 画框前：动画跑完，再确认原文真的看得见
for (const a of document.getAnimations()) { try { a.finish() } catch {} }
const rect = [...range.getClientRects()].find(q => q.width && q.height)
const anc = range.commonAncestorContainer.nodeType === 1
  ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement
const hit = rect && document.elementFromPoint(rect.left + Math.min(rect.width, 40) / 2, rect.top + rect.height / 2)
const visible = !!hit && (hit === anc || anc.contains(hit))   // false：换存档截，或标出来人工看
```

要补查一批旧截图时，先扫像素，找没有框色的图（在浏览器的 canvas 里统计框色像素，几百张一分钟）。再对每个页面跑一遍「只量不截」：按旧流程的时机量一次位置，动画跑完再量一次，两次差超过 2 px 或者原文不可见的，旧图可疑，只重截这些。

最后记住截图的边界：它证明的是「页面今天这么写」，不是平台的真实行为。

## 8. 走查脚本自己的盲区

脚本自己也会骗人，这一类最难发现，因为它报的是绿。

**归一化过头**。一次多语言页面走查，比对脚本先把空白全部去掉，想避免换行带来的误报。结果中文日期一处写成 `2026年1月5日`（数字和汉字之间没有空格）、其他页写成 `2026 年 1 月 5 日`，脚本看不出来。后来改成逐字比对，按几种写法分别核。归一化之前要想清楚：被抹掉的差异里，有没有本身就是要查的东西。

**排除得太宽**。查横向溢出的脚本，为了不误报代码块，把一类可以横向滚动的容器整体排除了。上一轮自检报 0 处溢出；去掉这条排除重跑，四种宽度下桌面 4 处、手机 8 处。排除规则要精确到「这个元素自己可滚动、内容没撑破父级」，不能按类名整类跳过。

**贴来的截图不等于视口**。我贴了一张截图说明想要的布局，助手按像素尺寸除以设备像素比，反推出「窗口约 1886×721」，据此下了结论：这个高度下某个入口在首屏以外。后来助手自己细看图，发现页面最上面固定的公告条只露出下半截。固定顶栏不会随滚动被切掉，所以这是一张框选的局部截图，721 不是窗口高度。从截图读尺寸之前，先看固定顶栏是否完整：不完整就只采信宽度，高度结论按几档常见视口各测一次，并写明结论成立需要的最小窗口高度。那次助手在下一条回复的开头更正了这个数，改按三档常见视口重测。

## 收尾

1. **定位** —— 文本用不区分大小写的正则；选择器加 `:visible`；判可见用 `innerText`，展开 FAQ 只在 `<details>` 里找。
2. **等待** —— 盯状态徽标，不在整页文本里匹配「Failed」；链接输入要点「添加」，提交前读 JSON 预览。
3. **不花钱地试** —— `route.abort` 看客户端校验；「只问一次」的状态只拦写请求，先确认 GET 被截到；拦截只证明 body，后端状态要真提交一次。
4. **本地状态** —— 截「提交前」先按完整键名清历史，草稿和历史分开清；「完成」态先核对是付费那一单，再免费重截。
5. **按键没反应** —— 每 100 ms 记一次焦点，换进入路径做对照；结论写「有条件失败」，附 console、复现步骤和复现次数。
6. **截图** —— `channel: 'chrome'`；拦字体和第三方（context 级 route 管得到 iframe）；滚回顶部、移开鼠标、动画跑完；手机宽度用 `setViewportSize`。
7. **原文截图** —— 跨节点找片段、按命中位置滚、`elementFromPoint` 确认看得见、多处命中取第一处可见的、图名用片段。
8. **脚本自己** —— 归一化前想清楚抹掉了什么；排除规则别按类名整类跳；贴来的图先看是不是整窗。

这些坑有个共同点：脚本给出的都是一个干脆的结果（找到了、失败了、0 处、看得见），而那个结果和人看到的不是一回事。所以我现在给走查脚本的每个关键判断都配一个对照：换一种进入路径、换一种判定方式、拿一个已知该红的样本跑一遍。对照对不上，就先查脚本，再查页面。关于把这类检查做成交付前的硬闸，见[两次「假完成」之后](/blog/testing/fake-done-and-gates/)。
