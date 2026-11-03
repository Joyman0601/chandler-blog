---
# import-articles-sha256: 747daaa3c9d058ba768baea3386021b38fff26db99a879b46747758ca87d7e4b
# Imported by scripts/import-articles.mjs from posts/frontend/sticky-layout-failures.md
# Source date: 2026-10-05
title: "sticky 在真实页面上的五种失败：先查 top 和直接父元素"
description: "做模型列表页的吸顶筛选栏和侧栏时，sticky 在样稿里一切正常，放进站点后接连失效。按现象归成五种情形，每种给出根因、最小复现和修法，再给一套用脚本在两个视口高度下量位置、断言不重叠的验收方法。"
pubDate: 2026-08-26
tags: ["前端","CSS","Playwright","验收","React"]
series: frontend
seriesLabel: "前端实践"
---

> 一句话总结：`position: sticky` 的 `top` 要从站点固定顶栏的高度往下算，活动范围只看直接父元素的内容盒；不要靠钉住制造「一直可见」；验收用脚本在矮视口、结果极少、滚到最底这些状态下量位置，并断言它不盖住别人。

## 0. 起因：一个在样稿里没问题的吸顶

模型列表页的筛选改版（经过见[筛选改版那篇](/blog/frontend/facet-filter-redesign/)）是我和 Claude Code（下文叫助手）一起做的。新布局里有三处 sticky：

- 桌面端顶部的筛选栏，滚动后吸在导航下面；
- 桌面端左侧的筛选侧栏，跟着结果列滚到顶后停住；
- 手机端的一条工具栏，滚动后吸顶。

样稿是一个独立的 HTML 文件，sticky 全部正常。放进站点、再落到真实页面，前后坏了五次，每次的样子都不一样。按现象可以归成五种情形，排查顺序也就固定下来：

1. 吸住了，但被盖住 → 查 `top` 有没有算站点的固定顶栏（情形 1）；
2. 根本没吸，跟着页面滚走 → 查直接父元素是不是只有自身高的包装层（情形 2）；
3. 平时正常，结果少、页面短时被顶上去 → 查父容器的 `padding-bottom`，或者页脚进了视野（情形 3、5）；
4. 窗口一矮就压住别的内容 → 查哪里用了 sticky bottom 当浮层（情形 4）；
5. 输入时控件消失、页面跳回页头 → 看 `scrollHeight` 变没变（情形 5）。

先复习一条规则，后面五种情形都是它的推论：**sticky 元素只能在它的直接父元素的内容盒里活动**。父元素滚出视口，它就跟着走；父元素的 padding 不算活动范围。

## 1. 被固定顶栏盖住：top 不能写 0

**现象**：样稿里筛选栏 `top: 0`，吸顶位置正好。放进站点以后，吸住的那一条整条藏在顶栏下面。

**根因**：站点的顶栏（公告条加导航）是 `position: fixed`，一共 112px。样稿没有站点外壳，`top: 0` 就是视口顶；站点里视口顶被顶栏占着。顶栏的高度写在布局常量里，页面上看不出来。

**修复**：`top` 取站点的高度常量，不写 0，也不写手算的魔法数。站里已经有吸顶组件的，照它的写法来。样稿里也把固定顶栏做进去，否则样稿上验过的东西换个环境就不成立。

```css
:root { --chrome-h: 112px; }            /* 公告条 + 导航，和站点布局常量同源 */
.filter-bar { position: sticky; top: var(--chrome-h); }
```

改对以后又暴露了第二个问题：占比。手机上「顶栏 + 吸顶栏」已经占了首屏约 26%，评审时想再加一行常驻搜索，按高度估算会到 31%。最后的规则是：搜索要随时够得着，但不为它单独多占一行，桌面端把它放进本来就吸顶的那一行里。

**检查点**：方案对比时，桌面和手机各算一次「固定 + 吸顶」占首屏的比例，写进对比表。

## 2. 包装层只有自身高：永远吸不住

**现象**：手机工具栏在样式面板里 `position: sticky; top: 112px` 都在，没有任何报错，元素却跟着页面滚走了。滚过一屏去量，它的 `top` 是负数。样稿里能吸，抽成组件以后就不行。

**根因**：抽组件时外面多包了一层按断点显隐的 div（`lg:hidden` 这种），sticky 的直接父元素变成了这一层。它的高度只有工具栏自己那么高，活动范围等于零：父元素一滚出视口，工具栏就跟着走了。

```tsx
// ✗ 包装层成了直接父元素，高度 = 工具栏自身
<div className="lg:hidden">
  <div className="sticky" style={{ top: CHROME_H }}>…</div>
</div>
```

**修复**：包装层改成 `display: contents`，它自己不生成盒子，工具栏的直接父元素变回内容列。Tailwind 里小屏 `contents`、大屏 `hidden`：

```tsx
// ✓ 小屏 display: contents，大屏 display: none
<div className="contents lg:hidden">
  <div className="sticky" style={{ top: CHROME_H }}>…</div>
</div>
```

也可以干脆不要包装层，把显隐的类直接加在 sticky 元素上。

**检查点**：看 sticky 元素的直接父元素，是不是你打算当活动范围的那个容器。

## 3. 父容器的 padding-bottom 把侧栏顶上去

**现象**：结果列表长的时候侧栏一切正常。搜一个词只剩两三行结果，页面变短，滚到底时吸顶的侧栏整体上移了几十像素，标题钻到顶部筛选栏后面。侧栏的高度明明比视口小，这不是「sticky 的正常表现」。

**根因**：侧栏和结果列共用一个 flex 父容器，父容器带了 96px 的底部留白。sticky 不能离开父容器的内容盒，padding 不算在内。页面短的时候，内容盒的底边比视口底边高出一个 padding，侧栏被它顶了上去。

**修复**：底部留白挪到结果列（侧栏的兄弟）上，父容器不留底部 padding：

```css
.layout  { display: flex; align-items: flex-start; }        /* 不在这里留底部 padding */
.side    { position: sticky; top: calc(var(--chrome-h) + 16px); }
.content { flex: 1; min-width: 0; padding-bottom: 96px; }   /* ← 留白放在内容列 */
```

`align-items: flex-start` 也要有：flex 子项默认会被拉伸到和父容器一样高，侧栏一旦和父容器等高，就没有可以滑动的空间了。

**检查点**：造一个「结果很少、滚到页面最底」的状态，量侧栏的 `getBoundingClientRect().top`，应该等于设定的 `top`。

## 4. sticky bottom 在矮窗口盖住列表

**现象**：侧栏里能力列表在上、提供商列表在下。为了让提供商「不用滚就看得到」，助手把提供商那一行用 `sticky; bottom: 0` 钉在侧栏底边。在 1440×900 下截图和断言全部通过。我反馈「提供商那一行卡住不动」，助手换到 1440×760 复现：钉住的那一行压在能力列表上，盖住了第 2 项以后的标签和「展开全部」按钮，滚动列表时它卡着不动（实测）。

**根因**：钉住的元素不再占位，内容从它身后滚过。空间够的时候，它停在自然位置，看起来和普通元素一样，所以 900 高下看不出它是个浮层。助手的断言只量了目标（它可见、可点），没量副作用（它盖住了别人）。

**修复**：取消钉住，提供商排在能力区之后，跟着侧栏一起滚。想让它默认可见，就把上面的内容做短（折叠、默认只露前几项），而不是让它浮在上面。

代价是提供商不再一直可见。这个代价写进了交付说明，后来另做了几版页头，把「第一眼能看到提供商」作为一条要求，并且给每一版算出「提供商进首屏所需的最小窗口高度」。

**检查点**：自己加的、需求里没有的「增强」（比如钉住），交付时单独列出来，写明它在什么条件下会变差。

## 5. 结果变少、吸顶解除：输入框在输入中消失

这一种最绕，因为它是一个反馈环。

**现象**：侧栏顶部有一个搜索框，只在页头滚出视口（吸顶状态）后才显示。滚到深处，在里面输入一个只剩 1 个结果的词：页面变矮，滚动位置被浏览器夹回去，页头重新露出来，吸顶状态解除，搜索框隐藏并且失焦，后面敲的字全丢了。用一个还剩十几个结果的词测不出来。

**根因**：控件的显示依赖滚动位置，而它自己的输入又改变了页面高度。样稿里修好以后，搬进真实页面又冒出两个样稿里没有的因素：

- **滚动锚定**：Chrome 在内容变化时会按某个锚点元素调整滚动位置，结果变少时它把页面滚回了页头附近。这时页面并没有变短，`scrollHeight` 没变。
- **页脚**：真实页面底部有页脚，滚到页脚时吸顶必然被顶走，「内容列最小高度」救不回来。

判断是哪一种，看 `document.scrollingElement.scrollHeight`：变小了，是页面太短被夹回；没变，是滚动锚定。

**修复**：分四件事。

```css
/* 1. 内容列最小高度 = 视口高 - 吸顶位置，多 1px 防取整 */
/* 2. 关掉结果列的滚动锚定 */
.main { min-height: calc(100vh - var(--dock-top) + 1px); overflow-anchor: none; }

/* 4. 控件位置一直留着，出现时只改可见性，下方区块不跳 */
.side .search        { visibility: hidden; opacity: 0; }
.side.docked .search { visibility: visible; opacity: 1; }
```

第 3 件是有页脚时的兜底：搜索框聚焦时，把结果列的高度锁成当时的值，失焦再放开。

```tsx
function SidebarSearch({ resultsRef }: { resultsRef: React.RefObject<HTMLElement> }) {
  const lock = () => {
    const el = resultsRef.current
    if (el) el.style.minHeight = `${el.getBoundingClientRect().height}px` // 锁住当前高度
  }
  const unlock = () => {
    if (resultsRef.current) resultsRef.current.style.minHeight = ''
  }
  return <input type="search" onFocus={lock} onBlur={unlock} />
}
```

**检查点**：控件出现前后，量它下方第一个区块的位置，两次应该相同；在搜索框里输入到只剩 1 个结果，断言控件、焦点、吸顶都还在。

## 6. 验收方法：用脚本量，不看样式面板

五种情形里，样式面板都显示 `position: sticky` 和正确的 `top`，没有一种能靠看样式发现。验收后来固定成四条：

1. **量 rect，不看样式**：滚过一屏后，断言 sticky 元素的 `getBoundingClientRect().top` 等于设定值。
2. **至少两个视口高度**：设计用的那个，和一个明显更矮的。「首屏放得下」「某入口一直可见」这类结论，在矮视口下最容易翻车。
3. **断言不重叠**：用 sticky 或 fixed 让东西「一直可见」时，同时断言它不和相邻内容重叠，重叠数期望是 0。
4. **跑极端状态**：结果只剩 1 个、滚到页面最底、在依赖滚动才显示的输入框里输入。

写成 Playwright 用例大概是这样：

```ts
// sticky.spec.ts：两个视口高度 × 吸顶位置 + 不重叠
import { test, expect, type Page } from '@playwright/test'

const CHROME_H = 112
const LIST_PATH = '/catalog' // 列表页的路径

async function overlapCount(page: Page, pinned: string, list: string) {
  return page.evaluate(([p, l]) => {
    const a = document.querySelector(p)!.getBoundingClientRect()
    return [...document.querySelector(l)!.children].filter((e) => {
      const b = e.getBoundingClientRect()
      return b.bottom > a.top + 1 && b.top < a.bottom - 1 // 允许 1px 取整误差
    }).length
  }, [pinned, list])
}

for (const height of [900, 760]) {
  test(`1440×${height} 侧栏吸顶且不遮挡`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height })
    await page.goto(LIST_PATH)
    await page.mouse.wheel(0, 1200)
    await page.waitForTimeout(200)

    const top = await page.locator('.side').evaluate((el) => el.getBoundingClientRect().top)
    expect(Math.round(top)).toBe(CHROME_H + 16)
    expect(await overlapCount(page, '.side .providers', '.side .capabilities')).toBe(0)
  })
}

test('输入到只剩 1 个结果，搜索框和焦点都还在', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 760 })
  await page.goto(LIST_PATH)
  await page.mouse.wheel(0, 3000)
  const box = page.locator('.side .search input')
  await box.click()
  await box.pressSequentially('一个只剩一个结果的词')
  await expect(box).toBeVisible()
  await expect(box).toBeFocused()
})
```

还有一条容易省掉：**新断言先在修复之前的版本上跑一次，确认它会红**。第 4 种情形里，「提供商不压在能力列表上」这条断言在修复前的版本上是失败的，修复后整套自检全部通过（实测）。如果它在修复前也是绿的，说明它量的根本不是这个问题。

最后，样稿上验过的结论，搬进真实页面后要再跑一遍。第 5 种情形里的滚动锚定和页脚，样稿里都不存在。

## 收尾

1. **top 从固定顶栏算** —— 取站点的高度常量，不写 0；桌面和手机各算一次首屏占比。
2. **先看直接父元素** —— 按断点显隐的包装层会把活动范围缩成零，改 `display: contents`。
3. **留白放在内容列** —— 父容器的 padding 不算活动范围，页面短时会把侧栏顶上去。
4. **不靠钉住制造可见** —— sticky bottom 在矮窗口会变成浮层，断言要量副作用。
5. **反馈环看 scrollHeight** —— 变小是页面被夹回，没变是滚动锚定；有页脚就在聚焦时锁高度。
6. **两个高度、断言不重叠** —— 新断言先在修复前跑红，样稿结论搬进真实页面重跑。

回头看这五次，每一次样式面板里都显示「sticky 写上了」。sticky 的行为取决于它周围的盒子：父元素多高、带不带 padding、页面多长、视口多高，这些在样式面板里都看不到。下次再碰到吸顶问题，我会先在控制台里打出直接父元素的 rect 和视口高度，再去看它自己的样式。
