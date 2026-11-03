---
# import-articles-sha256: b0a187ab29c81c3bffd061fd20aa3662e95915d64a5084fffbb4d48b9fdd6647
# Imported by scripts/import-articles.mjs from posts/model-onboarding/gateway-outbound-body-pitfalls.md
# Source date: 2026-09-29
title: "网关改写请求的漏洞：结构体改了，上游没收到"
description: "网关在请求上补默认值、整流、合并附加参数、展开替换规则，每一步都可能和上游真正收到的字节对不上。讲五个实测漏洞和统一的验证法：用 mock 上游记录出站 body，每个端点用同一组输入变体各发一轮。"
pubDate: 2026-08-18
tags: ["API 网关","Go","模型接入","错误处理","测试设计"]
series: model-onboarding
seriesLabel: "模型接入"
---

> 一句话总结：网关对请求的改写，只有落进出站字节才算数。结构体上的值对、单测全绿、在一个端点验过，都证明不了上游收到的是对的；验证一律看 mock 上游记录的出站 body。

## 0. 起因：网关不只是转发

多供应商的模型网关，表面上是「收请求、选渠道、转给上游」。实际上请求在网关里会被改很多次：

- 模型名映射：对外名换成上游的型号名；
- 补默认值：用户没传输出上限时，按渠道配置注入一个；
- 整流：用户的写法上游不接受，换成上游接受的等价写法；
- 合并附加参数：用户在一个附加参数对象里放的键，补进上游请求；
- 展开：用户给的替换规则、模板，先在网关展开再发出去；
- 剥离：会让上游加价、而网关计费不识别的参数，发出去之前删掉。

麻烦在于，同一个请求在网关里有两份表示：解析后的结构体，和原始的 JSON 字节。不同端点、不同适配器走的路径不一样，有的在结构体上改、再序列化；有的为了不丢上游私有字段，直接在原始字节上定点改写后转发。改写写在哪一份上、出站时用的是哪一份，决定了上游到底收到什么。

下面五个漏洞都是接入和验收时实测出来的。前三个是「改写没进出站 body」，第四个是「改写被附加参数绕过」，第五个是「改写过程本身出了事」。最后一节讲统一的验证法。

## 1. 默认值只写在结构体上，转发原始 body 的适配器把它丢了

**现象**：渠道配置了「用户没传输出上限时注入默认值」。读代码看结构体上的值是对的，但 mock 上游记录的出站 body 里没有这个字段。

这个字段对某些模型很要紧。有的推理模型把思考 token 计入输出上限，上游省略档位时又默认最深思考。网关没把上限发出去，上游就按它自己的缺省上限生成，思考可能吃光额度，返回一个空正文。

**根因**：默认值注入只改了结构体；削顶这类后续改写在字节层做；这个适配器为了保留上游私有字段，选择在原始字节上改写后转发。于是只落在结构体上的那部分改动，没有进出站请求。

**修复**：适配器转发原始 body 时，对照结构体把默认值补回去。只在用户两个上限字段都没传时写，不覆盖显式值：

```go
// body 是原始 JSON 字节，req 是网关解析后的结构体
if absent(body, "max_tokens") && absent(body, "max_completion_tokens") {
	switch {
	case req.MaxCompletionTokens > 0:
		body, _ = sjson.SetBytes(body, "max_completion_tokens", req.MaxCompletionTokens)
	case req.MaxTokens > 0:
		body, _ = sjson.SetBytes(body, "max_tokens", req.MaxTokens)
	}
}
```

单测三条：缺省时注入、用户显式值不动、渠道没配缺省时不凭空注入。`absent` 的写法见第 3 节。

## 2. 走固定结构体的端点丢了未声明字段，整流永远不触发

**现象**：给一个推理模型的三个端点（Chat、Messages、Responses）都加了同一条整流规则：用户传 `thinking.type=disabled`（这个上游不接受这种写法）时，删掉它，并补上最浅的思考档。Chat 和 Messages 经 mock 上游验证，出站 body 正确。Responses 端发同样的请求，出站 body 里既没有 `thinking`，也没有补出的档位。请求返回 200，思考按上游默认的最深档跑，用户以为已经关了。

**根因**：Responses 端点把请求解析进一个固定字段的 DTO（数据传输对象）再序列化，DTO 没有声明 `thinking` 字段，字段在解析那一步就没了；整流器工作在 DTO 上，看不到它。另外两个端点在原始字节上整流，所以看得到。「DTO 丢未声明字段」本身是这条路径一直以来的行为，问题出在整流规则以为自己覆盖了三个端点。

**修复**：两条路任选一条。

- 在 DTO 端点的转换入口先看原始 body（网关通常把原始字节缓存在请求上下文里），对整流关心的字段做判定，再写回 DTO 的对应字段；
- 或者对上游做不到、DTO 也装不下的字段显式 400，不静默丢（见第 6 节）。

这类问题光靠读代码很难发现。验收时我用同一组输入变体（关思考的几种写法、档位别名、预算档、`null` 和空串）对三个端点各发一轮，逐条对比出站 body，一下就看出来了。

## 3. 「没传才补」把 null 和空串当成传了

和第 2 节是同一次验收发现的。整流规则是「`thinking.type=disabled` 时删掉 `thinking`；用户没给档位时补最浅档」。单测全绿，经 mock 上游看出站 body：

| 用户传 | 出站 body |
|---|---|
| `{"thinking":{"type":"disabled"}}` | 补出了最浅档，正确 |
| 同上，再加 `"reasoning_effort": null` | `reasoning_effort: null`，没补 |
| 同上，再加 `"reasoning_effort": ""` | `reasoning_effort: ""`，没补 |

后两种到了上游，`null` 等于没传，走默认最深档，和「关思考」的意图正好相反，还更贵；空串多半直接 400。

**根因**：整流器用 `gjson.Get(body, "reasoning_effort").Exists()` 判断「用户给了档位」。gjson 对 `"k": null` 返回 `Exists() == true`、类型是 `Null`；空串同样 `Exists() == true`，Go 里用 `map` 查 `ok` 也一样。单测只覆盖了「键不存在」这一种缺省形态。有些客户端 SDK 会把没设置的可选字段序列化成 `null`，所以这不是构造出来的边角情况。

**修复**：「没给」有三种形态：键不存在、值为 `null`、值为空串。收成一个判断，单测三条都要补出默认值：

```go
func absent(body []byte, path string) bool {
	v := gjson.GetBytes(body, path)
	return !v.Exists() || v.Type == gjson.Null || strings.TrimSpace(v.String()) == ""
}

if absent(body, "reasoning_effort") {
	body, _ = sjson.SetBytes(body, "reasoning_effort", "low") // 覆盖 null 和 ""，而不是跳过
}
```

## 4. 附加参数合并，绕过了已校验的字段

很多网关有一个通用入口：用户在一个附加参数对象里放任意键，网关把它们并进上游请求，方便用户用上网关还没正式支持的上游参数。新加的严格校验要专门防这个入口。

### 合并会覆盖：顶层校验得再严也白搭

**现象**：给某厂商 TTS 模型的统一接口新加了声音复刻模式，顶层字段的校验很严：目标模型只允许一个值，音频只收 http(s) 链接，名称限长。验收时，在附加参数对象里放了同名键：目标模型换成另一个值，链接换成 `data:` URI。请求通过了全部同步校验，被覆盖后的值原样发给了上游，上游真的按另一个目标模型建出了音色，并且扣了费。

**根因**：构造上游参数的顺序是「先写校验过的字段，再遍历附加参数逐个覆盖」。保护名单只列了渠道、计费这类内部字段，新模式的业务字段不在里面。

### 改成「不覆盖」以后，照样能绕过

后来网关把合并改成了「不覆盖」：附加参数只补任务参数里还没有的键。有一次给三个同族视频型号加 `seed` 的范围校验（0 到 2³² − 1 之外返回 400），只校验了顶层字段，单测和三个型号的对照测试全绿。新上下文复核时提了一句：「顶层不传、只在附加参数里传会怎样？」本地全栈实测，顶层不传 `seed` 时任务参数里就没有这个键，附加参数里的 `-5` 和 `5000000000` 都被原样补了进去，worker 照发上游。`n: 4` 也一样能补进去：预扣按 1 条算，上游收到的是 4 条。

「不覆盖」只防了「两边都传」，没防「只在附加参数里传」。凡是「用户没传就不写键」的字段（可选的数字、布尔），都有这个口子。

**修复**：

- 严格校验的模式不走通用合并：校验函数直接产出要下发的字段集，附加参数对象整个拒绝或忽略；
- 一定要保留合并时，校验层同时看顶层和附加参数里的同名键，合并时遇到已校验字段的同名键返回 400，不静默丢；
- 下游客户端再做一层断言（取值白名单、链接协议），作纵深防御。

```go
// 合并附加参数：已校验字段的同名键一律拒绝，而不是覆盖或静默跳过
func mergeExtra(params map[string]any, extra map[string]any, validated map[string]bool) error {
	for k, v := range extra {
		if validated[k] {
			return fmt.Errorf("parameter %q must be set at top level, not in extra params", k)
		}
		if _, exists := params[k]; !exists {
			params[k] = v
		}
	}
	return nil
}
```

验收矩阵里固定加两组用例，看发给上游的实际内容：「顶层合法 + 附加参数里放同名非法值」和「顶层不传、只在附加参数里传非法值」。这组用例可能真的在上游建出资源，跑之前先备好登记和清理手段。

## 5. 展开之后才判长度：两百字节的请求打爆内存

**现象**：同一个 TTS 接口允许用户传一组「把词 A 换成 B」的替换规则，网关按顺序替换后，检查文本不超过一个字符上限。边界用例全过：替换后刚好等于上限通过，多一个字符返回 400。可验收时一个不到 200 字节的请求让网关花了 4 秒才返回那个 400。请求是 16 条 `{"a":"aa"}`，加上一段 5000 个字母 a 的文本；网关在内存里构造出了约 3.2 亿个字符，容器内存从 197 MB 涨到 785 MB。每多一条规则翻一倍，约 19 条就能耗尽 6 GB。

**根因**：替换是级联的，前一条的结果会被后一条继续替换，长度按指数增长。规则条数和替换目标的长度都没有上限，长度检查又放在全部替换完成之后。返回码是对的，所以只看状态码的功能测试发现不了。

**修复**：每一步替换之前，按「出现次数 × 长度差」算出替换后的长度，超了直接 400，根本不构造这段文本；规则总数也设上限。

```python
def expand(text, rules, limit, max_rules=200):
    if len(rules) > max_rules:
        raise ValueError("too many rules")
    for src, dst in rules:
        if not src:
            raise ValueError("empty source")
        projected = len(text) + text.count(src) * (len(dst) - len(src))
        if projected > limit:          # 先算后做，超了就不做
            raise ValueError("expanded text too long")
        text = text.replace(src, dst)
    return text
```

验收这类接口时，加一组放大用例，记录耗时和进程内存，不只看状态码。放大用例从小规模起步、逐级加码，别把自己的测试环境先打挂。凡是「按展开、解压、替换后的结果做校验」的输入，都适用这一条。

## 6. 上游做不到的字段：显式 400，不静默丢

前面几节讲的是网关想发、却没发出去的东西。还有一类相反的：用户传了一个上游根本兑现不了的字段，网关该怎么办。

**现象**：某文本大模型的 Responses 兼容接口不保存状态，响应里恒为 `store: false`。OpenAI Responses API 里的 `previous_response_id` 是服务端会话状态：客户端只发新输入加上一轮的 id，服务端替它把历史接在前面。对这个上游，网关原来把 `previous_response_id` 原样透传，另一个同类字段 `conversation` 则因为第 2 节那种 DTO 路径被静默丢掉。

**取舍**：四种处理的比较：

| 处理 | 后果 |
|---|---|
| 透传 | 取决于上游，可能忽略也可能报错，不可控 |
| 网关静默丢弃 | 请求成功但模型失忆；工具循环里工具结果找不到对应的调用，最难发现 |
| 显式 400 | 客户端马上知道要改成每轮发全量历史 |
| 网关自建存储 | 完全兼容，但要设计存储、保留期和隐私，太重 |

选了显式 400，只对「引用服务端历史」的字段生效：`previous_response_id` 非空、`conversation` 非 null 时拒绝；只带 `store: true` 的请求放行，它只是「请保存」，之后真拿 id 续聊时才会被拒。

```json
{"error": {"type": "invalid_request_error", "code": "param_not_allowed",
  "param": "previous_response_id",
  "message": "This model keeps no server-side history. Drop previous_response_id and include all prior turns in every request."}}
```

这个错误要标成本地的客户端错误：不重试、不计入渠道故障、不触发熔断，判定在预扣之后的话要确认预扣退还。做这一条时还顺带修了共享 handler 的一个问题：适配器的转换错误原来一律变成 500，会触发重试和熔断，改成保留适配器给的状态码。mock 上游下验证，三种请求都返回 400，上游调用 0 次，预扣全部退回。

同一个原则也用在多模式的统一接口上。那个 TTS 统一接口按参数分流：带描述文本走音色设计，带音频链接走声音复刻，两者互斥。实测发现，把设计模式的试听文本混进复刻请求，上游会把它当成录音的逐字稿，对不上时以降级模式建音色，请求照常成功、照常计费。所以接口层规定：出现另一个模式的字段就返回 400，不忽略。

## 7. 验证方法：mock 上游看出站 body

五个漏洞的共同点是：读结构体、看单测都发现不了，看一眼上游收到的字节就清楚了。我现在的验证固定成三步。

**第一步，写一个记录出站 body 的 mock 上游。** Go 的测试里用 `httptest` 最省事，它会正确处理分块编码：

```go
func TestOutboundBody(t *testing.T) {
	var got []map[string]any
	up := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var m map[string]any
		_ = json.NewDecoder(r.Body).Decode(&m)
		got = append(got, m)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"fake","choices":[]}`))
	}))
	defer up.Close()

	// 把渠道地址指到 up.URL，经网关的公开入口发请求……
	// 断言 got[0] 里有补出的默认值，没有被剥离的字段
}
```

用 Python 的 `http.server` 自己写 mock 时要注意：Go 的 HTTP 客户端在 body 长度未知时发 `Transfer-Encoding: chunked`，不带 `Content-Length`。有一次 mock 只按 `Content-Length` 读，记录下来的 body 全是 `{}`，看上去像网关把字段全丢了。判法是先打一条对照：客户端显式传的字段直接发出去，如果连它都看不见，就是 mock 的问题。修法是让 mock 支持分块：

```python
def read_body(handler):
    if handler.headers.get("Transfer-Encoding", "").lower() == "chunked":
        chunks = []
        while True:
            size = int(handler.rfile.readline().strip(), 16)
            if size == 0:
                handler.rfile.readline()
                break
            chunks.append(handler.rfile.read(size))
            handler.rfile.readline()        # 每块后面的 CRLF
        return b"".join(chunks)
    return handler.rfile.read(int(handler.headers.get("Content-Length", 0)))
```

**第二步，准备一份输入变体矩阵，每个端点各发一轮。** 每条改写规则都至少包括：

| 变体 | 例子 |
|---|---|
| 键不存在 | 不带 `reasoning_effort` |
| 值为 `null` | `"reasoning_effort": null` |
| 值为空串 | `"reasoning_effort": ""` |
| 显式合法值 | 用户自己传了档位，网关不该动 |
| 规则覆盖的各种写法 | 关思考的几种写法、档位别名 |
| 只在附加参数里传 | 顶层不传，附加参数里放非法值 |
| 两边都传 | 顶层合法，附加参数里放同名非法值 |

**第三步，mock 照抄上游的拒绝规则。** 非法枚举、上游不接受的写法、错误的模型名，mock 都回 4xx。mock 比上游宽松，就会放过构造错误，冒烟测试假绿。

## 收尾

1. **两份表示** —— 网关里有结构体和原始字节两份请求，改写写在哪份、出站用哪份，要逐个适配器核。
2. **一个端点验过不算** —— 同一条规则在每个端点用同一组变体各发一轮，DTO 端点先列出它装不下的字段。
3. **缺省有三种形态** —— 键不存在、`null`、空串都算「没传」，单测各一条。
4. **附加参数是后门** —— 严格校验的模式不走通用合并；要合并就拒绝同名键，并覆盖「只在附加参数里传」。
5. **先算后展开** —— 用户能控制的展开，在每一步之前判上限；放大用例看耗时和内存。
6. **做不到就说做不到** —— 上游兑现不了的字段显式 400，标成客户端错误，不重试、不熔断。

下次给网关加任何一条改写规则，我会先写好 mock 上游和变体矩阵，再写规则本身。网关怎么给上游错误归类、哪些错误该重试，见[错误分类、重试和渠道禁用](/blog/model-onboarding/error-classifier-channel-disable/)；接入的整体顺序见[接一个新模型的五段流程](/blog/model-onboarding/onboarding-five-stages/)。
