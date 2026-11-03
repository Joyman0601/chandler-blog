---
# import-articles-sha256: 12ca330e222fb9c49196ddd066459c9c5b1203eaaa21d238b494f2244b1cc2d3
# Imported by scripts/import-articles.mjs from posts/frontend/async-seam-url-variant.md
# Source date: 2026-09-23
title: "一个 await 就是一道缝：异步回写和 URL 变体的首帧"
description: "多变体页面上，上传结果写进了另一档、草稿存到了别的键。记录一条能机械套用的审查方法：对每个 await 问写到哪、读哪个时刻的值、目的地还在不在；以及变体存在 URL 参数里、挂载后才回读时，首帧和切档那一帧为什么会写错键。"
pubDate: 2026-08-10
tags: ["前端","React","TypeScript","Code Review","测试设计"]
series: frontend
seriesLabel: "前端实践"
---

> 一句话总结：`await` 前后，「我是谁」可能已经变了。审异步代码时不找具体功能，而是列出每一个 `await`，问三句：写到哪、读的是哪个时刻的值、目的地还在不在。同一个道理也管着「同一帧里上下文已是新档、state 还是旧档」：按变体取键的写入，键要跟着表单真正所属的档走。

## 0. 起因：一次评审，换回来一个方法

前端控制台的模型详情页里有一个试用区（Playground）：填参数、传参考图、点生成。很多模型有几个可以来回切的「档位」（变体），比如同一个模型的标准版和快速版，每档的参数、上限、价格都不一样。

页面迁移期间，leader 对我负责迁移的一个页面做了一轮评审，一共改了 18 处，分成八组。其中一组是试用区的三个串档问题：

1. 上传的参考图，完成后归到了另一档；
2. 任务历史切档后出现在别的档里；
3. JSON 视图里编辑的文本，切档后归错了档。

我当时可以只问「这 18 处改了什么」，记成一张清单。我追问的是：「这几个问题，我下次怎么保证不再犯？」换回来的不是清单，而是一句可以机械套用的话：

**一个 `await` 就是一道缝。缝的两侧，「我是谁」可能已经不同了。**

三个串档不是三个 bug，是同一句话的三种表现。这篇讲这条方法怎么用、它当场抓到了什么，以及两周后它在助手写的代码上又抓到一次。最后讲一个形状很像的问题：变体存在 URL 参数里时，首帧和切档那一帧的状态错位。

## 1. 对每个 await 问三句话

一个页面有几个可以切换的「档位」（变体、标签页、会话）时，用户在异步操作还没完成时切了档，完成回调就很容易写错地方。对每一个 `await`，问三个问题：

1. **写到哪**：完成后要写入的目标是什么？这个目标在等待期间会不会变？
2. **读的是哪个时刻的值**：用的是发起时捕获的值，还是最新的值？有没有一半用发起时的、一半用最新的？
3. **目的地还在吗**：等待期间，写入的目标会不会已经被清空或重置？

第 2 个问题最容易漏。一半一半的写法，单看每个值都「对」，合在一起就是跨档污染。下面是一个最小的反例和改法：

```tsx
// ✗ 发起时的回调 + 最新的列表：上传途中切了档，会把 A 档的列表整份换成 B 档的
async function onUpload(file: File) {
  const url = await upload(file)
  onChange([...latestListRef.current, url]) // 此刻 latestListRef 已经指向 B 档的列表
}

// ✓ 发起时就把「我是谁」固定下来，完成后按归属写回
async function onUpload(file: File) {
  const owner = currentVariant // 发起时捕获
  const url = await upload(file)
  setListsByVariant((prev) => ({
    ...prev,
    [owner]: [...(prev[owner] ?? []), url], // 写回发起者自己的列表
  }))
}
```

审查时第一步不是读业务逻辑，而是把缝列出来：

```bash
rg -n 'await |\.then\(' app/ components/ | rg -v '__tests__|\.test\.'
```

然后逐行套这三个问题。不是每个 `await` 都有问题：等待期间状态不可能变（比如页面上根本没有可切换的东西），三个问题自然都成立，直接跳过。

## 2. 当场套出来的另一页

拿到这条方法的当天，用第 2 问去扫了十几个有多档的页面，找到一个漏网的（推断，读代码得出）。

这一页的实现和评审里那一页不一样。评审那一页是「一份表单 state + 每档一份快照」，这一页是「每档各一份 state」。所以评审里那个具体症状在它身上不成立，表面上看不出问题。但它的上传控件在完成时：

- `onChange` 用的是发起时的闭包（对）；
- 列表取的是 `valueRef.current`，也就是最新的值（错）。

一半发起时、一半最新，正中第 2 问。推下去的后果比评审里那个还重：在 A 档传一张图，上传途中切到 B 档，完成时 A 档原有的参考图会被 B 档的列表整份顶掉。数据是静默丢的，要切回 A 档才看得见。另外几个同一套写法的页面，大概率也一样。

这是读代码推出来的。当天没有直接改，而是记成卡点：先写测试证实或证伪，再动手。按清单找，这一页永远找不到，因为它的症状和清单上的那条完全不同；套判据才找得到。

另一件事是把判据固化成一个 CI 闸，不让它停在笔记里。判据写得很干：一个组件如果持有多档状态，它渲染的上传控件就必须传一个「归属」回调。存量不满足的页面登记进基线，新代码不许再增加。

```ts
// variant-ownership.gate.test.ts：持有多档状态的组件，上传控件必须带归属回调
import { readFileSync } from 'node:fs'
import { globSync } from 'glob'
import baseline from './variant-ownership.baseline.json' // 存量豁免，只减不增

const files = globSync('components/**/Playground*.tsx')

test.each(files)('%s：多档状态 → 上传控件带 onUploadDone', (file) => {
  const src = readFileSync(file, 'utf8')
  const hasVariantState = /useVariants\(|variantsRef/.test(src)
  const uploads = src.match(/<UploadInput\b[^>]*>/g) ?? []
  const missing = uploads.filter((tag) => !/\bonUploadDone=/.test(tag))
  if (hasVariantState && missing.length && !baseline.includes(file)) {
    throw new Error(`${file} 有 ${missing.length} 个上传控件没传归属回调`)
  }
})
```

这种闸是按源码结构判的，它能防止「明显忘了接」，但证明不了「接了就对」。它的作用是把缝标出来，真正守行为的，还得是下一节那种打在结果上的测试。

## 3. 两周后：为修另一个竞态加的 ref，正好是反例

这条方法记进了经验库，也写进了交付自检清单。两周后，它在助手写的代码上又抓到一次，而且是交付时没对照上、推送前的深度审视才抓出来的。

背景是这样的。有一个原本只有一个变体的试用区，它的上传控件之前为了修另一个竞态，改过一次：上传途中用户删掉了一张图，完成时那张图会「复活」。修法是完成时读 `valueRef.current`（最新的列表）再追加，这在单变体页面上完全正确。

后来这一页加了第二个变体。表单 state 两档共用，上传控件没有按档换实例。问题就来了：上传途中切档，`valueRef.current` 已经是新档的列表，而闭包里的「最多几张图」还是发起档的。又是一半发起时、一半最新。结果是整份写进新档：上限 1 张的那一档收到了 2 张；反过来，另一档会静默变成多图模式。

这一次是推送前派了一个新上下文的审视子代理，让它按「每个 `await` 问三句」逐条过，才抓出来的。交付时跑的是规范符合性检查，它管的是区块、文案、登记点，管不到时序。**清单里写着，不等于交付时对照了**。从那以后，推送前的深度审视在我这里是固定的一步。

修法分两步：

1. **控件按变体加 `key`**，切档时旧实例直接卸载。旧实例的 ref 停在发起档的列表上，第 2 问的「发起时的值」就自然固定了。
2. **父级的 `onChange` 在渲染时捕获归属**。完成时如果归属不等于当前档，就写回归属那一档的快照和草稿，不碰当前表单（第 1、3 问）。

```tsx
// 父级：渲染时捕获 owner，完成时按 owner 写回
<UploadInput
  key={variantId} // ← 切档即换实例
  value={form.images}
  onChange={(next) => {
    const owner = variantId // 闭包里固定的是渲染这一帧的档
    if (owner === currentVariantRef.current) setForm((f) => ({ ...f, images: next }))
    else saveSnapshot(owner, { images: next }) // 发起档已经不在前台：写它自己的快照和草稿
  }}
/>
```

守卫测试照着出事的顺序写：发起上传 → 切档 → 再让上传完成 → 断言。关键是手里攥着一个可以随时 resolve 的 promise：

```tsx
// upload-switch.test.tsx：上传途中切档，结果只归发起档
function deferred<T>() {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((r) => (resolve = r))
  return { promise, resolve }
}

test('上传途中切档，新档表单里没有这张图', async () => {
  const pending = deferred<string>()
  mockUpload.mockReturnValueOnce(pending.promise)

  render(<Playground initialVariant="std" />)
  await user.upload(screen.getByLabelText('参考图'), new File(['x'], 'a.png', { type: 'image/png' }))
  await user.click(screen.getByRole('tab', { name: '快速版' })) // 上传还没完成就切档

  await act(async () => pending.resolve('https://cdn.example.com/a.png'))

  expect(screen.queryByAltText('a.png')).toBeNull() // 前台是快速版：不该出现
  expect(readDraft('fast').images).toEqual([])
  expect(readDraft('std').images).toEqual(['https://cdn.example.com/a.png']) // 发起档收到了
})
```

这条测试拷到修复前的代码上跑，是红的；修复后是绿的。否则它守的可能根本不是这个问题。

## 4. URL 变体的首帧：同一帧里，上下文和 state 分属两档

同一个页面加第二个变体时，还碰到了一个形状很像、但和 `await` 无关的问题。

**背景**：页面框架把「当前变体」存在 URL 参数里（`?model=` 这种），在 `useEffect` 里解析，再 `setVariant`。所以服务端渲染的首帧、客户端首次渲染、挂载那一帧里所有 effect 看到的，都是默认档。切档也是「先改上下文，再由各个 effect 各自响应」。

**现象**：每档一份参数快照，草稿按变体分键存进 `localStorage`。切档以后刷新页面，新档「还原」出了旧档的提示词和图片。

**根因**：切档那一帧里有两个 effect 先后执行：

1. 切档 effect：把旧档表单存成快照，再给新档铺默认值。但 `setState` 要到下一帧才生效，这一帧里 state 还是旧档的；
2. 落盘 effect：「表单变了就写 `localStorage`」，它的依赖里有草稿键，键由当前变体派生，已经是新档的。

键是新档的，值是旧档的，旧档的内容就被写进了新档的草稿键。**同一帧里「上下文已是新档、state 还是旧档」是正常状态**，不是 bug。错的是落盘 effect 把键和值从两个不同的来源取。

**修复**：落盘 effect 不再依赖变体，只依赖表单值；键从一个 ref 取，这个 ref 只在「旧档快照已存、新档默认值已铺」之后才更新：

```ts
// 键跟着「表单此刻真正属于哪一档」走，不跟着上下文走
const loadedVariantRef = useRef<string | null>(null)

useEffect(() => {
  // 切档：存旧档快照 → 指向新档 → 铺新档的默认值或草稿
  if (loadedVariantRef.current === variantId) return
  if (loadedVariantRef.current) {
    snapshots.current[loadedVariantRef.current] = { prompt, images }
  }
  loadedVariantRef.current = variantId
  applyDefaultsOrDraft(variantId)
}, [variantId])

useEffect(() => {
  // 落盘：依赖里没有变体。切档那一帧表单值没变，这个 effect 不跑；
  // 下一帧表单值变成新档的，ref 也已经指向新档
  if (!loadedVariantRef.current) return
  localStorage.setItem(draftKeyFor(loadedVariantRef.current), JSON.stringify({ prompt, images }))
}, [prompt, images])
```

任务历史按变体分桶，也是同一个道理：内存里的任务列表记下「来自哪个桶」，只在列表来自当前桶时写盘。

守卫测试打在落盘结果上，而不是 effect 的调用次数上：在 A 档输入，切到 B 档再输入，断言 A 的键里是 A 的内容，B 的键里是 B 的。

## 5. 走查脚本：等变体回读完再取样

URL 变体的首帧是默认档，这件事还会骗到浏览器脚本。

用脚本打开一个 `?model=<第二档>` 的深链，等下拉按钮一出现就去读文本，读到的是默认档的名字和估价；几百毫秒以后再读，才是目标档。截图和断言都在回读之前完成，看起来像「深链没生效」，其实是脚本取样早了。

```ts
// 先等页面上的变体标识变成目标档，再读估价、截图
await page.goto(`/<页面>?model=${target.id}`)
await page.waitForFunction(
  (name) => document.querySelector('[data-variant-trigger]')?.textContent?.includes(name),
  target.displayName,
)
const estimate = await page.locator('[data-estimate]').innerText()
```

首帧按默认档渲染不是 bug，不需要为了它去改服务端渲染。深链指向的变体在注水后才选中，这是框架的设计。

另一件小事也属于「先看清楚再判缺陷」。我验收时看到：选了某个变体，默认提示词却是一句「a cat」。助手推断，这是它前一步给的验收步骤里用过的提示词，留在了同一档的草稿里，又被正常恢复了出来（没能取证）。按变体分键的草稿，恢复出来的内容先看它来自哪个键、是不是同一档，再决定是不是缺陷。

最后一个提醒和守卫测试有关。同一批改动里，助手写过一条「标准版选了参考图模式，切到快速版不会带过去」的测试，断言的是「切过去以后 Auto 处于按下状态」。后来审视子代理故意把代码改坏，这条测试照样全绿。原因是纵横比那一行也有一个同名的 Auto 按钮，默认就是按下的，这句断言在任何代码上都成立。改成只看模式那一行、并且检查发出去的请求里不带这个参数以后，改坏的代码会让它失败。断言前先确认定位到的就是目标那一行，细节在[守卫测试的三个要求](/blog/testing/guard-tests-three-rules/)里。

## 收尾

1. **按缝找，不按功能找** —— 用 `rg` 列出所有 `await`，逐个问写到哪、读哪个时刻的值、目的地还在不在。
2. **一半发起时、一半最新最危险** —— 单看每个值都对，合在一起就是跨档污染。
3. **判据要固化成闸** —— 结构闸负责标出缝，行为测试负责守结果。
4. **修竞态的 ref 会成为下一个竞态** —— 单变体下正确的「读最新值」，加了第二档就错了。
5. **同一帧里上下文和 state 可以分属两档** —— 按变体取键的写入，键从「表单真正所属的档」的 ref 取。
6. **走查先等回读** —— 深链首帧是默认档，等变体标识变成目标档再取样。
7. **清单写着不等于对照了** —— 推送前派新上下文的子代理按三问逐条过。

这件事里最值钱的不是哪一个修复，而是那次追问。如果当时只接下 18 处改动，我会得到一张清单，下次在一个症状不同的页面上照样漏。追问「下次怎么保证不犯」，换回来的是一条能套到任何异步代码上的判据。之后再被评审改了代码，我都会多问这一句：不问改了什么，问怎么才能不再犯。
