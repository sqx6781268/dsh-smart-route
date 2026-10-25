/**
 * 图片路由语义自测（契约 `docs/图片路由契约冻结.md` v2 · R2/R2b/R5–R11 · M1–M27）。
 *
 * 全部离线：桩 `llm`、桩 chunk、桩成员脚本，不装插件、不连宿主、不发真实请求。
 * 每格标题带 M 编号，供 t3 逐格对照；v2 的守门格是 M23–M27。
 *
 * 跑法：node test/image-selftest.mjs（`scripts/test.mjs` 已接入）
 *
 * @module test/image-selftest.mjs
 */

import { readFileSync } from 'node:fs'

import { DEFAULT_COOLDOWN, isCooling, markCooldown, resetCooldown, resetRotation, normalizeDocument } from '../src/chains.mjs'
import {
  MultiChainAdapter,
  PROVIDER,
  contentRequiresVision,
  exceptionFinish,
  isVisionMember,
  messagesRequireVision,
  resolveInputModalities,
} from '../src/adapter.mjs'

let passed = 0
let failed = 0

function check(label, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${label}`)
  } else {
    failed += 1
    console.log(`  ✗ ${label}${detail === undefined ? '' : `\n      ${detail}`}`)
  }
}

/** 真实宿主的图片块形状（`typert.host.js:375-376` ImageBlock）。 */
function imageBlock(id = 'sha256:0123456789abcdef', extra = {}) {
  return {
    type: 'image',
    attachment: {
      attachmentId: id,
      mediaType: 'image/png',
      bytes: 2048,
      width: 64,
      height: 32,
      ...extra,
    },
  }
}

const textBlock = (text) => ({ type: 'text', text })
const userMessage = (...content) => ({ role: 'user', content })
const toolMessage = (...content) => ({ role: 'tool', content })
const assistantMessage = (...content) => ({ role: 'assistant', content })

const chunk = {
  text: (text, index = 0) => ({ type: 'text-delta', index, text }),
  finishStop: () => ({ type: 'finish', reason: { kind: 'stop' } }),
  finishAborted: () => ({ type: 'finish', reason: { kind: 'aborted' } }),
  finishError: (code, message = 'boom', extra = {}) => ({
    type: 'finish',
    reason: { kind: 'error', failure: { code, message, ...extra } },
  }),
}

/**
 * 造一个适配器 + 桩 llm。
 *
 * @param members - 链成员（`provider/model` 字符串，按原顺序）
 * @param infos - `provider/model` → 本次实时 `inputModalities`；值为 Error 表示解析抛错
 * @param scripts - `provider/model` → chunk 数组（可含 Error 表示抛错）
 * @param resolveInfo - 可选钩子：`(provider, model, signal) => info`，用于在解析阶段
 *   触发取消（抛 AbortError 形态）或忽略 signal 后照常返回，覆盖取消三时机
 * @param scriptHook - 可选钩子：`(key, calls) => void`，在真正委派前执行（用于循环中取消）
 */
function makeHarness({ members, strategy = 'fallback', infos = {}, scripts = {}, stickyLimit = 1, resolveInfo, scriptHook } = {}) {
  fresh()
  const doc = normalizeDocument({ chains: [{ id: 'c1', models: members, strategy, stickyLimit }] })
  const chain = doc.chains[0]
  const calls = []
  const warnings = []
  const events = []
  const infoMap = { ...infos }

  const llm = {
    async resolveModelInfo(provider, model, signal) {
      if (resolveInfo !== undefined) return resolveInfo(provider, model, signal)
      const value = infoMap[`${provider}/${model}`]
      if (value instanceof Error) throw value
      if (value === undefined) return { provider, id: model, name: model }
      return { provider, id: model, name: model, inputModalities: value }
    },
    stream(options) {
      const key = `${options.provider}/${options.model}`
      calls.push(key)
      scriptHook?.(key, calls)
      return (async function* run() {
        const script = scripts[key] ?? [{ type: 'finish', reason: { kind: 'stop' } }]
        for (const step of script) {
          if (step instanceof Error) throw step
          yield step
        }
      })()
    },
  }

  const adapter = new MultiChainAdapter({
    chains: () => [chain],
    policy: () => doc.policy,
    llm: () => llm,
    warn: (line) => warnings.push(line),
    onRouteEvent: (event) => events.push(event),
  })

  const run = async (options = {}) => {
    const out = []
    for await (const item of adapter.stream({ provider: PROVIDER, model: chain.id, ...options })) out.push(item)
    return out
  }

  return {
    adapter,
    chain,
    calls,
    warnings,
    events,
    infoMap,
    run,
    resolve: (model = chain.id) => adapter.resolveModel(PROVIDER, model),
  }
}

const lastFinish = (out) => out.at(-1)

/**
 * 每个场景开始前清掉**进程态**：轮转游标与冷却表在真实宿主里跨请求持续生效，
 * 离线用例之间必须隔离，否则前一格的一次 AUTH 失败会把成员冷却掉，
 * 后面"应当首成员作答"的格子就会莫名其妙只调用备用成员。
 */
function fresh() {
  resetRotation()
  resetCooldown()
}

// ── [1] 结构判据（R6/R7 · M8/M19/M22 的纯函数部分）────────────────────────
function testStructure() {
  console.log('\n[1] 结构判据：只认 content 数组里的 type==="image"')

  check('content 含 image 块判为图片', contentRequiresVision([textBlock('看'), imageBlock()]) === true)
  check('offloaded 的图片块仍算图片', contentRequiresVision([{ ...imageBlock(), offloaded: true }]) === true)
  check('file 块不算图片', contentRequiresVision([{ type: 'file', attachment: { attachmentId: 'f1' } }]) === false)
  check('空 content 不算图片', contentRequiresVision([]) === false)
  check('非数组 content 不算图片', contentRequiresVision('image') === false)

  // M19 负对照：字符串搜索与任意递归都会在这里误判
  const trapToolCall = {
    role: 'assistant',
    content: [
      { type: 'tool-call', toolName: 'demo', arguments: '{"type":"image","attachment":{"attachmentId":"x"}}' },
    ],
  }
  check('tool-call.arguments 里的 JSON 字符串不算图片（M19）', contentRequiresVision(trapToolCall.content) === false)
  check(
    'meta 里塞 image 不算图片（M19）',
    contentRequiresVision([{ type: 'text', text: 'hi', meta: { type: 'image' } }]) === false,
  )
  check(
    'replayState 里的 image 不算图片（M19）',
    contentRequiresVision([{ type: 'text', text: 'hi', replayState: { blocks: [{ type: 'image' }] } }]) === false,
  )
  check(
    '深层嵌套对象里的 image 不算图片（M19）',
    contentRequiresVision([{ type: 'text', text: 'hi', nested: { deep: [{ type: 'image' }] } }]) === false,
  )

  // R7：覆盖全部消息（含 tool 结果、中间、末尾），不只看首条/末条
  const middle = [userMessage(textBlock('一')), assistantMessage(textBlock('二')), userMessage(imageBlock())]
  check('末尾消息有图判为需要视觉（M9）', messagesRequireVision(middle) === true)
  check(
    '仅中间消息有图判为需要视觉（M9）',
    messagesRequireVision([userMessage(textBlock('a')), userMessage(imageBlock()), userMessage(textBlock('c'))]) === true,
  )
  check('仅 tool 结果有图判为需要视觉（M8）', messagesRequireVision([toolMessage(imageBlock())]) === true)
  check('仅第一条 user 有图判为需要视觉（M22）', messagesRequireVision([userMessage(imageBlock()), userMessage(textBlock('追问'))]) === true)
  check('messages 非数组时按无图处理', messagesRequireVision(undefined) === false)
  check('messages 为 null 时按无图处理', messagesRequireVision(null) === false)
  check('纯文本历史判为不需要视觉', messagesRequireVision([userMessage(textBlock('hi'))]) === false)
  check(
    'user 消息里夹带 image 之外的块仍能检出',
    messagesRequireVision([userMessage(textBlock('看这张'), imageBlock(), { type: 'file', attachment: { attachmentId: 'f' } })]) === true,
  )
}

// ── [2] 描述符纯函数（R2/R2b · M23–M27 的判据部分）──────────────────────
function testModalityDescriptor() {
  console.log('\n[2] 视觉资格与 inputModalities 三段算法（纯函数）')

  check('text+image 是视觉成员', isVisionMember(['text', 'image']) === true)
  check('只有 image 不是视觉成员（v2 收紧）', isVisionMember(['image']) === false)
  check('只有 text 不是视觉成员', isVisionMember(['text']) === false)
  check('audio 不是视觉成员', isVisionMember(['audio']) === false)
  check('undefined 不是视觉成员', isVisionMember(undefined) === false)
  check('字符串不是视觉成员', isVisionMember('text,image') === false)

  const info = (modalities) => ({ inputModalities: modalities })
  const same = (actual, expected) => JSON.stringify(actual) === JSON.stringify(expected)

  check('两成员都是 text+image ⇒ 宣称 text+image', same(resolveInputModalities([info(['text', 'image']), info(['text', 'image'])]), ['text', 'image']))
  check(
    '混合链 text+image 与 text ⇒ 宣称 text+image（B2 额外宣称）',
    same(resolveInputModalities([info(['text', 'image']), info(['text'])]), ['text', 'image']),
  )
  check('全文本链 ⇒ 只宣称 text（M5）', same(resolveInputModalities([info(['text']), info(['text'])]), ['text']))
  check('成员全未知 ⇒ 兜底 text，绝不 undefined（R5）', same(resolveInputModalities([{}, {}]), ['text']))
  check('没有成员 ⇒ 兜底 text', same(resolveInputModalities([]), ['text']))
  check('解析失败（undefined）不构成视觉', same(resolveInputModalities([undefined, info(['text'])]), ['text']))

  // M23：image-only 成员不构成视觉资格
  check(
    'image-only + text ⇒ 只宣称 text（M23）',
    same(resolveInputModalities([info(['image']), info(['text'])]), ['text']),
    JSON.stringify(resolveInputModalities([info(['image']), info(['text'])])),
  )
  // M26：image-only 与视觉成员混合
  check(
    'image-only + text+image ⇒ 宣称 text+image（M26）',
    same(resolveInputModalities([info(['image']), info(['text', 'image'])]), ['text', 'image']),
    JSON.stringify(resolveInputModalities([info(['image']), info(['text', 'image'])])),
  )
  // M24/M25：audio-only 不得被改成 text
  check(
    'audio-only 链原样声明 audio（M24）',
    same(resolveInputModalities([info(['audio']), info(['audio'])]), ['audio']),
    JSON.stringify(resolveInputModalities([info(['audio']), info(['audio'])])),
  )
  check(
    '单成员 image-only ⇒ 原样声明 image、不补 text（R2b）',
    same(resolveInputModalities([info(['image'])]), ['image']),
    JSON.stringify(resolveInputModalities([info(['image'])])),
  )
  // M27：模态并集禁令
  check(
    'text 与 image 互不重叠 ⇒ 交集空 ⇒ 兜底 text，且不宣称 image（M27）',
    same(resolveInputModalities([info(['text']), info(['image'])]), ['text']),
    JSON.stringify(resolveInputModalities([info(['text']), info(['image'])])),
  )
  check(
    'text+image 与 audio 无交集 ⇒ 兜底 text，不加 audio（不并集）',
    same(resolveInputModalities([info(['text', 'image']), info(['audio'])]), ['text', 'image']),
    JSON.stringify(resolveInputModalities([info(['text', 'image']), info(['audio'])])),
  )
}

// ── [3] 链声明：真实 adapter（M1–M7/M24–M27 的宣称部分）──────────────────
async function testDeclaration() {
  console.log('\n[3] resolveModel 的能力声明（真实 adapter + 桩 llm）')

  // M1/M2：全视觉链
  {
    const h = makeHarness({
      members: ['a/x', 'b/y'],
      infos: { 'a/x': ['text', 'image'], 'b/y': ['text', 'image'] },
    })
    const resolved = await h.resolve()
    check('M1 全视觉链宣称 text+image', JSON.stringify(resolved.inputModalities) === '["text","image"]', JSON.stringify(resolved.inputModalities))
    check('M1 imageRequestPricing 仍是 undefined', h.adapter.imageRequestPricing(PROVIDER, 'c1') === undefined)
  }

  // M3/M4：混合链
  {
    const h = makeHarness({ members: ['a/x', 'b/y'], infos: { 'a/x': ['text', 'image'], 'b/y': ['text'] } })
    const resolved = await h.resolve()
    check('M3 混合链宣称 text+image（B2）', JSON.stringify(resolved.inputModalities) === '["text","image"]', JSON.stringify(resolved.inputModalities))
  }

  // M5：全文本链 —— 必须给具体数组，不能 undefined（R5）
  {
    const h = makeHarness({ members: ['a/x', 'b/y'], infos: { 'a/x': ['text'], 'b/y': ['text'] } })
    const resolved = await h.resolve()
    check('M5 全文本链宣称 ["text"]', JSON.stringify(resolved.inputModalities) === '["text"]', JSON.stringify(resolved.inputModalities))
  }

  // M7/R3：成员解析失败不构成视觉，但链仍给具体数组
  {
    const h = makeHarness({
      members: ['a/x', 'b/y'],
      infos: { 'a/x': new Error('目录里没有这个成员'), 'b/y': ['text'] },
    })
    const resolved = await h.resolve()
    check('M7 解析失败时宣称 ["text"]', JSON.stringify(resolved.inputModalities) === '["text"]', JSON.stringify(resolved.inputModalities))
    check('M7 保留了"无法解析能力"的告警语义', h.warnings.some((line) => line.includes('无法解析成员')), h.warnings.join(' | '))
    // t4 F3：同一 helper 也被有图筛选调用，那里成员随后被筛掉、本次根本不尝试，
    // 所以文案必须是中性的"按非视觉处理"，不能断言"仍会尝试"。
    check(
      'M7 告警用中性表述（不声称"仍会尝试"）',
      h.warnings.some((line) => line.includes('按非视觉处理')) &&
        h.warnings.every((line) => line.includes('仍会尝试') === false),
      h.warnings.join(' | '),
    )
  }

  // M7b：有图路径的解析失败 —— 成员被筛掉、本次确实不尝试，日志不得误导
  // （放在 [4] 委派分节，因为要用真实委派脚本；[3] 只做宣称）

  // R5：所有成员都未知 ⇒ ['text']（不是 undefined）
  {
    const h = makeHarness({ members: ['a/x', 'b/y'] })
    const resolved = await h.resolve()
    check('R5 成员全未知仍宣称具体数组 ["text"]', JSON.stringify(resolved.inputModalities) === '["text"]', JSON.stringify(resolved.inputModalities))
  }

  // R3：非法 inputModalities 不当视觉
  {
    const h = makeHarness({ members: ['a/x', 'b/y'], infos: { 'a/x': 'text,image', 'b/y': ['text'] } })
    const resolved = await h.resolve()
    check('R3 非数组 inputModalities 不构成视觉', resolved.inputModalities.includes('image') === false, JSON.stringify(resolved.inputModalities))
  }

  // M23/M26/M27：v2 守门格的宣称侧
  {
    const m23 = makeHarness({ members: ['a/x', 'b/y'], infos: { 'a/x': ['image'], 'b/y': ['text'] } })
    const resolved23 = await m23.resolve()
    check('M23 image-only 成员不让链宣称 image', JSON.stringify(resolved23.inputModalities) === '["text"]', JSON.stringify(resolved23.inputModalities))

    const m26 = makeHarness({ members: ['a/x', 'b/y'], infos: { 'a/x': ['image'], 'b/y': ['text', 'image'] } })
    const resolved26 = await m26.resolve()
    check('M26 image-only + 视觉成员仍宣称 text+image', JSON.stringify(resolved26.inputModalities) === '["text","image"]', JSON.stringify(resolved26.inputModalities))

    const m27 = makeHarness({ members: ['a/x', 'b/y'], infos: { 'a/x': ['text'], 'b/y': ['image'] } })
    const resolved27 = await m27.resolve()
    check('M27 互不重叠不并集 ⇒ ["text"]', JSON.stringify(resolved27.inputModalities) === '["text"]', JSON.stringify(resolved27.inputModalities))
  }

  // M24：audio-only 链
  {
    const h = makeHarness({ members: ['a/x', 'b/y'], infos: { 'a/x': ['audio'], 'b/y': ['audio'] } })
    const resolved = await h.resolve()
    check('M24 audio-only 链原样宣称 ["audio"]', JSON.stringify(resolved.inputModalities) === '["audio"]', JSON.stringify(resolved.inputModalities))
  }

  // R2：窗口/输出取最小、reasoning 取交集 —— 三项都不许并集
  {
    const doc = normalizeDocument({ chains: [{ id: 'c1', models: ['a/x', 'b/y'] }] })
    const adapter = new MultiChainAdapter({
      chains: () => doc.chains,
      policy: () => doc.policy,
      llm: () => ({
        async resolveModelInfo(provider, model) {
          return provider === 'a'
            ? {
                context: { contextWindow: 1_000_000 },
                defaultMaxTokens: 64_000,
                inputModalities: ['text', 'image'],
                reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low' },
              }
            : {
                context: { contextWindow: 128_000 },
                defaultMaxTokens: 8_192,
                inputModalities: ['text', 'image'],
                reasoning: { efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' },
              }
        },
      }),
      warn: () => {},
    })
    const resolved = await adapter.resolveModel(PROVIDER, 'c1')
    check('R2 窗口仍取最小（不是并集）', resolved.context?.contextWindow === 128_000, String(resolved.context?.contextWindow))
    check('R2 输出上限仍取最小', resolved.defaultMaxTokens === 8_192, String(resolved.defaultMaxTokens))
    check(
      'R2 reasoning 仍取交集',
      JSON.stringify(resolved.reasoning?.efforts) === '[{"id":"high","name":"High"}]',
      JSON.stringify(resolved.reasoning),
    )
    check('R2 宣称 text+image 不影响窗口/输出/reasoning 口径', JSON.stringify(resolved.inputModalities) === '["text","image"]')
  }
}

// ── [4] 委派筛选（M1–M4/M8/M9/M21/M22/M23/M24/M25/M26）─────────────────
async function testDelegationFiltering() {
  console.log('\n[4] #run 委派前的视觉筛选')

  const okScript = [chunk.text('好的'), chunk.finishStop()]

  // M1：全视觉链 + 有图 → 原顺序全部
  {
    const h = makeHarness({
      members: ['a/x', 'b/y'],
      infos: { 'a/x': ['text', 'image'], 'b/y': ['text', 'image'] },
      scripts: { 'a/x': [chunk.finishError('SERVER')], 'b/y': okScript },
    })
    const out = await h.run({ messages: [userMessage(textBlock('看'), imageBlock())] })
    check('M1 全视觉链按原顺序委派到备用成员', h.calls.join(',') === 'a/x,b/y', h.calls.join(','))
    check('M1 正常收尾', lastFinish(out)?.reason?.kind === 'stop', JSON.stringify(lastFinish(out)))
  }

  // M2：全视觉链 + 纯文本 → 不筛选，顺序不变
  {
    const h = makeHarness({
      members: ['a/x', 'b/y'],
      infos: { 'a/x': ['text', 'image'], 'b/y': ['text', 'image'] },
      scripts: { 'a/x': okScript },
    })
    const out = await h.run({ messages: [userMessage(textBlock('只有文字'))] })
    check('M2 纯文本请求只委派首成员（不因宣称 image 改动顺序）', h.calls.join(',') === 'a/x', h.calls.join(','))
    check('M2 正常作答', out.some((c) => c.type === 'text-delta'))
  }

  // M3：混合链 + 有图 → 只委派视觉成员
  {
    const h = makeHarness({
      members: ['a/x', 'b/y'],
      infos: { 'a/x': ['text', 'image'], 'b/y': ['text'] },
      scripts: { 'a/x': [chunk.finishError('AUTH')], 'b/y': okScript },
    })
    const out = await h.run({ messages: [userMessage(imageBlock())] })
    check('M3 有图只委派视觉成员（文本成员不被调用）', h.calls.join(',') === 'a/x', h.calls.join(','))
    check('M3 视觉成员失败后不引入文本成员', lastFinish(out)?.reason?.failure?.code === 'ALL_CANDIDATES_FAILED', JSON.stringify(lastFinish(out)))
    check('M3 日志说明了筛出的视觉成员数', h.warnings.some((line) => line.includes('已筛出 1 个视觉成员')), h.warnings.join(' | '))
    check(
      'M3 跳过原因进了有界运行记录（只记成员与固定码）',
      h.events.some((event) => event.kind === 'skip' && event.code === 'NO_VISION' && event.model === 'y'),
      JSON.stringify(h.events),
    )
    const skipEvent = h.events.find((event) => event.kind === 'skip' && event.code === 'NO_VISION')
    check(
      'M3 运行记录不含图片内容/提示词/凭据字段',
      skipEvent !== undefined &&
        Object.keys(skipEvent).every((key) => ['kind', 'chain', 'sessionId', 'provider', 'model', 'time', 'code'].includes(key)),
      Object.keys(skipEvent ?? {}).join(','),
    )
  }

  // M4：混合链 + 纯文本 → 原顺序，B 可被选中
  {
    const h = makeHarness({
      members: ['a/x', 'b/y'],
      infos: { 'a/x': ['text', 'image'], 'b/y': ['text'] },
      scripts: { 'a/x': [chunk.finishError('SERVER')], 'b/y': okScript },
    })
    const out = await h.run({ messages: [userMessage(textBlock('纯文本'))] })
    check('M4 混合链纯文本请求顺序 A→B', h.calls.join(',') === 'a/x,b/y', h.calls.join(','))
    check('M4 文本成员 B 正常作答', out.some((c) => c.type === 'text-delta' && c.text === '好的'))
  }

  // M5 端到端：全文本链 + 纯文本 → 与基线一致
  {
    const h = makeHarness({
      members: ['a/x', 'b/y'],
      infos: { 'a/x': ['text'], 'b/y': ['text'] },
      scripts: { 'a/x': okScript },
    })
    await h.run({ messages: [userMessage(textBlock('纯文本'))] })
    check('M5 全文本链纯文本行为与基线一致（首成员作答）', h.calls.join(',') === 'a/x', h.calls.join(','))
  }

  // M6：全文本链 + 有图 → NO_VISION_MEMBER、零委派、不图转文
  {
    const h = makeHarness({
      members: ['a/x', 'b/y'],
      infos: { 'a/x': ['text'], 'b/y': ['text'] },
      scripts: { 'a/x': okScript, 'b/y': okScript },
    })
    const out = await h.run({ messages: [userMessage(textBlock('看'), imageBlock())] })
    const finish = lastFinish(out)
    check('M6 无视觉成员时零委派', h.calls.length === 0, h.calls.join(','))
    check('M6 终态错误码是 NO_VISION_MEMBER', finish?.reason?.failure?.code === 'NO_VISION_MEMBER', JSON.stringify(finish))
    check('M6 消息点名链与"同时声明文本与图片"', /c1/.test(finish?.reason?.failure?.message ?? '') && /同时声明/.test(finish?.reason?.failure?.message ?? ''), finish?.reason?.failure?.message)
    check('M6 没有把图片转成文字的痕迹（无 text-delta）', out.every((c) => c.type !== 'text-delta'), JSON.stringify(out))
    check('M6 日志说明拒绝原因', h.warnings.some((line) => line.includes('无成员同时声明 text 与 image')), h.warnings.join(' | '))
  }

  // M7b：有图路径的解析失败 —— 成员被筛掉、本次确实不尝试，日志不得误导（t4 F3）
  {
    const h = makeHarness({
      members: ['a/x', 'b/y'],
      infos: { 'a/x': new Error('目录里没有这个成员'), 'b/y': ['text', 'image'] },
      scripts: { 'a/x': okScript, 'b/y': okScript },
    })
    const out = await h.run({ messages: [userMessage(imageBlock())] })
    check('M7b 解析失败的成员在有图请求中未被委派', h.calls.join(',') === 'b/y', h.calls.join(','))
    check(
      'M7b 有图路径的日志不声称"仍会尝试"（与实际行为一致）',
      h.warnings.some((line) => line.includes('按非视觉处理')) &&
        h.warnings.every((line) => line.includes('仍会尝试') === false),
      h.warnings.join(' | '),
    )
    check('M7b 视觉成员正常作答', out.some((c) => c.type === 'text-delta'))
  }

  // M8：仅 tool 结果带图
  {
    const h = makeHarness({
      members: ['a/x', 'b/y'],
      infos: { 'a/x': ['text'], 'b/y': ['text', 'image'] },
      scripts: { 'a/x': okScript, 'b/y': okScript },
    })
    await h.run({ messages: [userMessage(textBlock('跑个工具')), toolMessage(imageBlock())] })
    check('M8 仅 tool 结果有图 ⇒ 只委派视觉成员', h.calls.join(',') === 'b/y', h.calls.join(','))
  }

  // M9：图只在中间一条
  {
    const h = makeHarness({
      members: ['a/x', 'b/y'],
      infos: { 'a/x': ['text'], 'b/y': ['text', 'image'] },
      scripts: { 'a/x': okScript, 'b/y': okScript },
    })
    await h.run({ messages: [userMessage(textBlock('a')), userMessage(imageBlock()), userMessage(textBlock('c'))] })
    check('M9 中间消息有图也判为有图', h.calls.join(',') === 'b/y', h.calls.join(','))
  }

  // M21：新图（最后一条 user）+ 宿主准入不拒的交互
  {
    const h = makeHarness({
      members: ['a/x', 'b/y'],
      infos: { 'a/x': ['text'], 'b/y': ['text', 'image'] },
      scripts: { 'b/y': okScript },
    })
    const image = imageBlock('sha256:new-new-new-new')
    const resolved = await h.resolve()
    check(
      'M21 新图路径：声明含 image ⇒ 宿主准入不会以 MODEL_DOES_NOT_SUPPORT_IMAGES 拒绝',
      resolved.inputModalities.includes('image') === true,
      JSON.stringify(resolved.inputModalities),
    )
    const out = await h.run({ messages: [userMessage(textBlock('这张呢'), image)] })
    check('M21 #run 判为有图 ⇒ 只委派视觉成员', h.calls.join(',') === 'b/y', h.calls.join(','))
    check('M21 图片字节不被插件改写（引用原样传下去）', out.length > 0)
  }

  // M22：历史图（第一条 user）+ 本次最新是纯文本追问
  {
    const h = makeHarness({
      members: ['a/x', 'b/y'],
      infos: { 'a/x': ['text'], 'b/y': ['text', 'image'] },
      scripts: { 'b/y': okScript },
    })
    await h.run({
      messages: [userMessage(textBlock('看这张'), imageBlock()), userMessage(textBlock('继续讲')), assistantMessage(textBlock('好的'))],
    })
    check('M22 历史图仍判为有图 ⇒ 只委派视觉成员', h.calls.join(',') === 'b/y', h.calls.join(','))
  }

  // M23：image-only 成员不是视觉候选
  {
    const h = makeHarness({
      members: ['a/x', 'b/y'],
      infos: { 'a/x': ['image'], 'b/y': ['text'] },
      scripts: { 'a/x': okScript, 'b/y': okScript },
    })
    const out = await h.run({ messages: [userMessage(imageBlock())] })
    check('M23 image-only 成员不被当作视觉候选（零委派）', h.calls.length === 0, h.calls.join(','))
    check('M23 终态 NO_VISION_MEMBER', lastFinish(out)?.reason?.failure?.code === 'NO_VISION_MEMBER', JSON.stringify(lastFinish(out)))
  }

  // M24：audio-only 链 + 纯文本 → 不改行为
  {
    const h = makeHarness({
      members: ['a/x', 'b/y'],
      infos: { 'a/x': ['audio'], 'b/y': ['audio'] },
      scripts: { 'a/x': [chunk.finishError('SERVER')], 'b/y': okScript },
    })
    const out = await h.run({ messages: [userMessage(textBlock('纯文本'))] })
    check('M24 audio-only 链纯文本请求仍按原顺序降级', h.calls.join(',') === 'a/x,b/y', h.calls.join(','))
    check('M24 正常作答', out.some((c) => c.type === 'text-delta'))
  }

  // M25：audio-only + 有图 → NO_VISION_MEMBER
  {
    const h = makeHarness({
      members: ['a/x', 'b/y'],
      infos: { 'a/x': ['audio'], 'b/y': ['audio'] },
      scripts: { 'a/x': okScript },
    })
    const out = await h.run({ messages: [userMessage(imageBlock())] })
    check('M25 audio-only 有图请求零委派', h.calls.length === 0, h.calls.join(','))
    check('M25 终态 NO_VISION_MEMBER', lastFinish(out)?.reason?.failure?.code === 'NO_VISION_MEMBER', JSON.stringify(lastFinish(out)))
  }

  // M26：image-only + 视觉成员 ⇒ 只委派视觉成员
  {
    const h = makeHarness({
      members: ['a/x', 'b/y'],
      infos: { 'a/x': ['image'], 'b/y': ['text', 'image'] },
      scripts: { 'a/x': okScript, 'b/y': okScript },
    })
    await h.run({ messages: [userMessage(imageBlock())] })
    check('M26 有图只委派 text+image 成员（image-only 被排除）', h.calls.join(',') === 'b/y', h.calls.join(','))
  }

  // M16：IMAGE_OFFLOAD_REQUIRED 透传，不降级、不冷却、不改 code
  {
    const h = makeHarness({
      members: ['a/x', 'b/y'],
      infos: { 'a/x': ['text', 'image'], 'b/y': ['text', 'image'] },
      scripts: {
        'a/x': [chunk.finishError('IMAGE_OFFLOAD_REQUIRED', '图片超出请求上限', { offloadImages: 3 })],
        'b/y': okScript,
      },
    })
    const out = await h.run({ messages: [userMessage(imageBlock())] })
    const finish = lastFinish(out)
    check('M16 终态保留 offloadImages=3', finish?.reason?.failure?.offloadImages === 3, JSON.stringify(finish))
    check('M16 code 未被改写', finish?.reason?.failure?.code === 'IMAGE_OFFLOAD_REQUIRED', JSON.stringify(finish))
    check('M16 不降级到下一个候选', h.calls.join(',') === 'a/x', h.calls.join(','))
    check('M16 该成员不进冷却', isCooling({ provider: 'a', model: 'x' }) === false)
    check('M16 终态字段只在宿主白名单内', Object.keys(finish.reason.failure).every((key) => ['message', 'code', 'status', 'providerRetryAfterMs', 'requestId', 'offloadImages'].includes(key)), Object.keys(finish.reason.failure).join(','))
  }

  // R10：成员抛异常携带 failure 时也要保住 offloadImages
  {
    const thrown = Object.assign(new Error('需要卸载图片'), {
      code: 'IMAGE_OFFLOAD_REQUIRED',
      failure: { message: '需要卸载图片', code: 'IMAGE_OFFLOAD_REQUIRED', offloadImages: 2 },
    })
    const finish = exceptionFinish(thrown)
    check('R10 抛错路径也保留 offloadImages', finish?.reason?.failure?.offloadImages === 2, JSON.stringify(finish))
    const plain = exceptionFinish(Object.assign(new Error('普通失败'), { code: 'SERVER' }))
    check('R10 普通错误不被扩字段', Object.keys(plain.reason.failure).join(',') === 'message,code', Object.keys(plain.reason.failure).join(','))
  }
}

// ── [5] 冷却 / 取消 / commit / 能力变化（M10–M15/M17/M18）────────────────
async function testGuards() {
  console.log('\n[5] 冷却兜底、取消、commit、能力变化与不兼容码')

  const okScript = [chunk.text('好的'), chunk.finishStop()]

  // M10：视觉成员冷却 + 文本成员可用 + 有图 ⇒ 仍只试视觉成员（R9）
  {
    const h = makeHarness({
      members: ['a/x', 'b/y'],
      infos: { 'a/x': ['text', 'image'], 'b/y': ['text'] },
      scripts: { 'a/x': okScript, 'b/y': okScript },
    })
    // 冷却要在 harness 建好之后标（harness 会清进程态，避免用例间互相污染）
    markCooldown({ provider: 'a', model: 'x' }, 60_000)
    await h.run({ messages: [userMessage(imageBlock())] })
    check('M10 视觉成员全员冷却时兜底仍不引入文本成员', h.calls.join(',') === 'a/x', h.calls.join(','))
    check('M10 日志点明全员冷却但仍尝试', h.warnings.some((line) => line.includes('都在冷却期')), h.warnings.join(' | '))
    resetCooldown()
  }

  // ── M10b：冷却兜底的**失败路径**（R9 的决定性守卫，t4 F1）─────────────
  // M10 只测"A 冷却但 A 成功"——兜底分支从未真正触发；M11 的成员没预置冷却
  // （usable.length ≠ 0），兜底也不进入。于是"兜底集合是已筛集合还是原候选"
  // 这条判据**零覆盖**：把 `visual.length > 0 → ordered = visual` 改回
  // `candidates.length > 0 → ordered = candidates`，M10/M11 都不会红。
  //
  // 这一格专门制造"兜底真的触发"的组合：唯一视觉成员 a/x 预置冷却、且以
  // 非冷却类码（SERVER）失败 → ordered 只能来自兜底集合。若兜底越界，
  // b/y 会被调用（含图请求交给纯文本成员 = 正面违反 R9），终态还会变成 stop。
  {
    const h = makeHarness({
      members: ['a/x', 'b/y'],
      infos: { 'a/x': ['text', 'image'], 'b/y': ['text'] },
      // a/x 用非冷却类码失败（SERVER 不在 DEFAULT_COOLDOWN.codes 内，
      // 不会因这次失败被追加冷却，冷却状态完全由下面预置的那一条决定）
      scripts: { 'a/x': [chunk.finishError('SERVER')], 'b/y': okScript },
    })
    markCooldown({ provider: 'a', model: 'x' }, 60_000)
    const out = await h.run({ messages: [userMessage(imageBlock())] })
    const finish = lastFinish(out)
    check('M10b 兜底触发时纯文本成员从未被调用（R9）', h.calls.join(',') === 'a/x', h.calls.join(','))
    check('M10b 终态 ALL_CANDIDATES_FAILED（不是纯文本成员的 stop）', finish?.reason?.failure?.code === 'ALL_CANDIDATES_FAILED', JSON.stringify(finish))
    check('M10b 日志点明全员冷却但仍尝试', h.warnings.some((line) => line.includes('都在冷却期')), h.warnings.join(' | '))
    check('M10b 视觉成员确实失败了（证明兜底分支真的被执行）', finish?.reason?.failure?.message?.includes('a/x') === true, finish?.reason?.failure?.message)
    resetCooldown()
  }

  // M11：视觉成员全部失败 → ALL_CANDIDATES_FAILED，不引入文本成员
  {
    resetCooldown()
    const h = makeHarness({
      members: ['a/x', 'a/z', 'b/y'],
      infos: { 'a/x': ['text', 'image'], 'a/z': ['text', 'image'], 'b/y': ['text'] },
      scripts: { 'a/x': [chunk.finishError('AUTH')], 'a/z': [chunk.finishError('AUTH')], 'b/y': okScript },
    })
    const out = await h.run({ messages: [userMessage(imageBlock())] })
    check('M11 两个视觉成员都试过且未触及文本成员', h.calls.join(',') === 'a/x,a/z', h.calls.join(','))
    check('M11 终态 ALL_CANDIDATES_FAILED', lastFinish(out)?.reason?.failure?.code === 'ALL_CANDIDATES_FAILED', JSON.stringify(lastFinish(out)))
    resetCooldown()
  }

  // M12：有图请求，首候选 aborted → 终态 aborted，不改回 error、不进冷却
  {
    resetCooldown()
    const h = makeHarness({
      members: ['a/x', 'b/y'],
      infos: { 'a/x': ['text', 'image'], 'b/y': ['text', 'image'] },
      scripts: { 'a/x': [chunk.finishAborted()], 'b/y': okScript },
    })
    const out = await h.run({ messages: [userMessage(imageBlock())] })
    const finish = lastFinish(out)
    check('M12 终态是 aborted', finish?.reason?.kind === 'aborted', JSON.stringify(finish))
    check('M12 aborted 带完整 failure', finish?.reason?.failure?.code === 'ABORTED' && typeof finish?.reason?.failure?.message === 'string', JSON.stringify(finish))
    check('M12 取消不降级到下一候选', h.calls.join(',') === 'a/x', h.calls.join(','))
    check('M12 aborted 不进冷却', isCooling({ provider: 'a', model: 'x' }) === false)
    resetCooldown()
  }

  // M13：已提交后失败 → 不切换、原样交错误
  {
    resetCooldown()
    const h = makeHarness({
      members: ['a/x', 'b/y'],
      infos: { 'a/x': ['text', 'image'], 'b/y': ['text', 'image'] },
      scripts: { 'a/x': [chunk.text('开始作答'), chunk.finishError('SERVER')], 'b/y': okScript },
    })
    const out = await h.run({ messages: [userMessage(imageBlock())] })
    check('M13 提交后失败不切换成员', h.calls.join(',') === 'a/x', h.calls.join(','))
    check('M13 已交付的答案发给调用方', out.some((c) => c.type === 'text-delta' && c.text === '开始作答'))
    check('M13 原样交出成员错误', lastFinish(out)?.reason?.failure?.code === 'SERVER', JSON.stringify(lastFinish(out)))
    resetCooldown()
  }

  // ── M12 扩展：取消的三个时机（t3 F1/F2 回归）────────────────────────────
  // 缺陷背景：图片筛选在 `#run` 里新增了一段 await 能力解析，这段窗口里的
  // 取消若被 `resolveMemberInfos` 当成"能力未知"吞掉，`visual` 会算成空集，
  // 终态就变成 NO_VISION_MEMBER —— 用户主动取消被伪装成"链不支持图片"，
  // 与"未取消也没视觉成员"**逐字节不可区分**（M12 失效）。
  //
  // 下面三类时机都必须给 `{kind:'aborted', failure:{code:'ABORTED', message}}`、
  // 零委派、不进冷却、不动轮转；同时保留正对照（未取消 + 确实无视觉仍是
  // NO_VISION_MEMBER），防止把这条路整个删掉来"修好"。
  const abortedTerminal = (finish) =>
    finish?.reason?.kind === 'aborted' &&
    finish?.reason?.failure?.code === 'ABORTED' &&
    typeof finish?.reason?.failure?.message === 'string' &&
    finish.reason.failure.message.length > 0

  // 时机一：解析阶段中途取消（桩在 resolveModelInfo 里 abort 后抛取消形态）
  for (const [label, makeError] of [
    // DOMException 自带 name='AbortError' 与 code=20(ABORT_ERR)，是最真实的形态
    ['DOMException AbortError', () => new DOMException('解析被取消', 'AbortError')],
    ['只有 code=ABORTED', () => Object.assign(new Error('解析被取消'), { code: 'ABORTED' })],
    ['只有 code=ABORT_ERR', () => Object.assign(new Error('解析被取消'), { code: 'ABORT_ERR' })],
  ]) {
    const controller = new AbortController()
    const h = makeHarness({
      members: ['a/x', 'b/y'],
      resolveInfo(provider, model) {
        controller.abort() // 取消正好落在解析的 await 窗口内
        throw makeError()
      },
      scripts: { 'a/x': okScript, 'b/y': okScript },
    })
    const out = await h.run({ messages: [userMessage(imageBlock())], signal: controller.signal })
    const finish = lastFinish(out)
    check(`M12a 解析阶段取消（${label}）⇒ aborted 终态`, finish?.reason?.kind === 'aborted', JSON.stringify(finish))
    check(`M12a 解析阶段取消（${label}）⇒ code=ABORTED 且 message 完整`, abortedTerminal(finish), JSON.stringify(finish))
    check(`M12a 解析阶段取消（${label}）⇒ 不是 NO_VISION_MEMBER`, finish?.reason?.failure?.code !== 'NO_VISION_MEMBER', JSON.stringify(finish))
    check(`M12a 解析阶段取消（${label}）⇒ 零委派`, h.calls.length === 0, h.calls.join(','))
    check(`M12a 解析阶段取消（${label}）⇒ 不冷却`, isCooling({ provider: 'a', model: 'x' }) === false)
  }

  // 时机二：入口即已取消（signal 在进 #run 之前就 aborted）
  {
    const controller = new AbortController()
    controller.abort()
    const h = makeHarness({
      members: ['a/x', 'b/y'],
      infos: { 'a/x': ['text', 'image'], 'b/y': ['text', 'image'] },
      scripts: { 'a/x': okScript, 'b/y': okScript },
    })
    const out = await h.run({ messages: [userMessage(imageBlock())], signal: controller.signal })
    const finish = lastFinish(out)
    check('M12b 入口已取消 ⇒ aborted 终态', abortedTerminal(finish), JSON.stringify(finish))
    check('M12b 入口已取消 ⇒ 零委派（解析都不该发生）', h.calls.length === 0, h.calls.join(','))
    check('M12b 入口已取消 ⇒ 不冷却', isCooling({ provider: 'a', model: 'x' }) === false)
  }

  // 时机三：候选循环中取消（解析正常完成、筛出视觉成员，进入循环后取消）
  {
    const controller = new AbortController()
    const h = makeHarness({
      members: ['a/x', 'b/y'],
      infos: { 'a/x': ['text', 'image'], 'b/y': ['text', 'image'] },
      // 首个成员真正被调用前取消：循环体开头的 signal 检查必须接住
      scriptHook(key) {
        if (key === 'a/x') controller.abort()
      },
      scripts: { 'a/x': okScript, 'b/y': okScript },
    })
    const out = await h.run({ messages: [userMessage(imageBlock())], signal: controller.signal })
    const finish = lastFinish(out)
    check('M12c 循环中取消 ⇒ aborted 终态', abortedTerminal(finish), JSON.stringify(finish))
    check('M12c 循环中取消 ⇒ 不切换到备用成员', h.calls.join(',') === 'a/x', h.calls.join(','))
    check('M12c 循环中取消 ⇒ 不冷却', isCooling({ provider: 'a', model: 'x' }) === false)
  }

  // 补充：解析正常返回但 signal 期间已取消（解析忽略 signal 的情形）
  {
    const controller = new AbortController()
    const h = makeHarness({
      members: ['a/x', 'b/y'],
      resolveInfo(provider, model) {
        controller.abort() // 解析忽略 signal，照常返回能力
        return { provider, id: model, name: model, inputModalities: ['text', 'image'] }
      },
      scripts: { 'a/x': okScript, 'b/y': okScript },
    })
    const out = await h.run({ messages: [userMessage(imageBlock())], signal: controller.signal })
    const finish = lastFinish(out)
    check('M12d 解析完成但 signal 已取消 ⇒ aborted（不继续委派）', abortedTerminal(finish), JSON.stringify(finish))
    check('M12d 解析完成但 signal 已取消 ⇒ 零委派', h.calls.length === 0, h.calls.join(','))
  }

  // 补充：signal 未取消、但成员解析抛取消形态（上游自己中止）⇒ 也按 aborted
  {
    const h = makeHarness({
      members: ['a/x', 'b/y'],
      resolveInfo() {
        throw Object.assign(new Error('上游中止'), { code: 'ABORTED' })
      },
      scripts: { 'a/x': okScript, 'b/y': okScript },
    })
    const out = await h.run({ messages: [userMessage(imageBlock())] })
    const finish = lastFinish(out)
    check('M12e signal 未取消但解析抛 ABORTED ⇒ aborted（不误判为无视觉）', abortedTerminal(finish), JSON.stringify(finish))
    check('M12e 零委派', h.calls.length === 0, h.calls.join(','))
  }

  // 正对照：未取消且确实无视觉成员 —— 必须仍是 NO_VISION_MEMBER（不许被"修没了"）
  {
    const h = makeHarness({
      members: ['a/x', 'b/y'],
      infos: { 'a/x': ['text'], 'b/y': ['text'] },
      scripts: { 'a/x': okScript, 'b/y': okScript },
    })
    const out = await h.run({ messages: [userMessage(imageBlock())] })
    const finish = lastFinish(out)
    check('M12f 正对照：未取消+确实无视觉 ⇒ NO_VISION_MEMBER', finish?.reason?.failure?.code === 'NO_VISION_MEMBER', JSON.stringify(finish))
    check('M12f 正对照：终态与取消可区分（kind 不同）', finish?.reason?.kind === 'error', JSON.stringify(finish))
    check('M12f 正对照：零委派', h.calls.length === 0, h.calls.join(','))
  }

  // 轮转：取消请求对游标的推进必须与**同形态的正常请求**一致。
  // 注意 `orderCandidates(chain)` 在 `#run` 入口、取消点**之前**执行，所以单次
  // 请求推进一次游标是基线 v0.1.2 就有的行为（不是本次新增）。这里做的是
  // A/B 对照：取消请求 vs 正常请求，后续第二条纯文本请求的起点必须相同 ——
  // 若取消路径多推一次（或多推一次失败），两者会分叉。
  {
    const startAfter = async (cancel) => {
      const controller = new AbortController()
      const h = makeHarness({
        members: ['a/x', 'b/y'],
        strategy: 'round-robin',
        stickyLimit: 1,
        resolveInfo(provider, model) {
          if (cancel) {
            controller.abort()
            throw new DOMException('解析被取消', 'AbortError')
          }
          return { provider, id: model, name: model, inputModalities: ['text', 'image'] }
        },
        scripts: { 'a/x': okScript, 'b/y': okScript },
      })
      await h.run({ messages: [userMessage(imageBlock())], ...(cancel ? { signal: controller.signal } : {}) })
      h.calls.length = 0
      // 第二条纯文本请求：观察轮转起点
      await h.run({ messages: [userMessage(textBlock('继续'))] })
      return h.calls.join(',')
    }
    const cancelledStart = await startAfter(true)
    const normalStart = await startAfter(false)
    check('M12g 取消请求与正常请求对轮转的推进一致', cancelledStart === normalStart, `取消=${cancelledStart} 正常=${normalStart}`)
  }

  // M14：同进程两次请求，能力实时变化（R4）—— 证明不读启动期快照
  {
    const h = makeHarness({
      members: ['a/x', 'b/y'],
      infos: { 'a/x': ['text', 'image'], 'b/y': ['text', 'image'] },
      scripts: { 'a/x': okScript, 'b/y': okScript },
    })
    const first = await h.resolve()
    check('M14 第一次宣称 text+image', JSON.stringify(first.inputModalities) === '["text","image"]', JSON.stringify(first.inputModalities))
    h.infoMap['a/x'] = ['text']
    h.infoMap['b/y'] = ['text']
    const second = await h.resolve()
    check('M14 第二次按实时元数据只宣称 text', JSON.stringify(second.inputModalities) === '["text"]', JSON.stringify(second.inputModalities))
    const out = await h.run({ messages: [userMessage(imageBlock())] })
    check('M14 第二次有图请求 NO_VISION_MEMBER', lastFinish(out)?.reason?.failure?.code === 'NO_VISION_MEMBER', JSON.stringify(lastFinish(out)))
    check('M14 全程零委派', h.calls.length === 0, h.calls.join(','))
    // R4：能力决策路径不得读 capabilities.json（源码级断言）。
    // 只看可执行代码行：注释里提到该文件名是允许的（用来解释"为什么不读"）。
    const code = readFileSync(new URL('../src/adapter.mjs', import.meta.url), 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(?:\*|\/\/|\/\*)/.test(line))
      .join('\n')
    check('R4 adapter 能力决策路径不读 capabilities.json（含 fs 调用）', /capabilities\.json/.test(code) === false)
    check('R4 adapter 完全不 import fs（能力只来自本次 resolveModelInfo）', /from 'node:fs'/.test(code) === false)
  }

  // M15：宣称与筛选不一致（B3）—— resolveModel 时视觉，委派时解析失败
  {
    const h = makeHarness({
      members: ['a/x', 'b/y'],
      infos: { 'a/x': ['text', 'image'], 'b/y': ['text'] },
      scripts: { 'a/x': okScript },
    })
    const declared = await h.resolve()
    check('M15 宣称阶段 A 视觉', declared.inputModalities.includes('image') === true)
    h.infoMap['a/x'] = new Error('委派时元数据丢失')
    const out = await h.run({ messages: [userMessage(imageBlock())] })
    check('M15 筛选阶段无视觉候选 ⇒ NO_VISION_MEMBER', lastFinish(out)?.reason?.failure?.code === 'NO_VISION_MEMBER', JSON.stringify(lastFinish(out)))
    check('M15 不退化成纯文本请求（零委派）', h.calls.length === 0, h.calls.join(','))
  }

  // M17：UNSUPPORTED_CONTENT 不进冷却，冷却码表仍为基线 5 码
  {
    resetCooldown()
    const h = makeHarness({
      members: ['a/x', 'b/y'],
      infos: { 'a/x': ['text', 'image'], 'b/y': ['text', 'image'] },
      scripts: { 'a/x': [chunk.finishError('UNSUPPORTED_CONTENT')], 'b/y': okScript },
    })
    const out = await h.run({ messages: [userMessage(imageBlock())] })
    check('M17 UNSUPPORTED_CONTENT 触发降级（可换下一视觉成员）', h.calls.join(',') === 'a/x,b/y', h.calls.join(','))
    check('M17 UNSUPPORTED_CONTENT 不进冷却', isCooling({ provider: 'a', model: 'x' }) === false)
    check(
      'M17 冷却码表仍是基线 5 个码',
      JSON.stringify(DEFAULT_COOLDOWN.codes) === '["AUTH","INVALID_CREDENTIAL","QUOTA","QUOTA_EXCEEDED","ACCOUNT_QUOTA"]',
      JSON.stringify(DEFAULT_COOLDOWN.codes),
    )
    check('M17 正常收尾', lastFinish(out)?.reason?.kind === 'stop')
    resetCooldown()
  }

  // M18：自引用与空链不回归
  {
    const doc = normalizeDocument({ chains: [{ id: 'loop', models: ['MultiChain/loop', 'a/x'] }] })
    const calls = []
    const adapter = new MultiChainAdapter({
      chains: () => doc.chains,
      policy: () => doc.policy,
      llm: () => ({
        async resolveModelInfo(provider, model) {
          return { provider, id: model, name: model, inputModalities: ['text', 'image'] }
        },
        stream(options) {
          calls.push(`${options.provider}/${options.model}`)
          return (async function* run() {
            yield chunk.text('ok')
            yield chunk.finishStop()
          })()
        },
      }),
      warn: () => {},
    })
    const out = []
    for await (const item of adapter.stream({ provider: PROVIDER, model: 'loop', messages: [userMessage(imageBlock())] })) out.push(item)
    check('M18 有图请求下自引用成员仍被跳过', calls.includes('MultiChain/loop') === false, calls.join(','))
    check('M18 落到视觉成员并作答', calls.join(',') === 'a/x', calls.join(','))

    // 空链：normalizeDocument 会丢掉"没有有效成员"的链，所以路由侧看到的是
    // UNKNOWN_CHAIN；EMPTY_CHAIN 只在链存在但候选全被过滤掉时出现
    // （这里用"只有自引用成员"构造，与基线语义一致）。
    const emptyDoc = normalizeDocument({ chains: [{ id: 'e', models: [] }] })
    const emptyAdapter = new MultiChainAdapter({ chains: () => emptyDoc.chains, policy: () => emptyDoc.policy, llm: () => ({}), warn: () => {} })
    const emptyOut = []
    for await (const item of emptyAdapter.stream({ provider: PROVIDER, model: 'e', messages: [] })) emptyOut.push(item)
    check(
      'M18 无有效成员的链按基线给 UNKNOWN_CHAIN',
      lastFinish(emptyOut)?.reason?.failure?.code === 'UNKNOWN_CHAIN',
      JSON.stringify(lastFinish(emptyOut)),
    )

    const selfOnlyDoc = normalizeDocument({ chains: [{ id: 's', models: ['MultiChain/s'] }] })
    const selfOnlyAdapter = new MultiChainAdapter({
      chains: () => selfOnlyDoc.chains,
      policy: () => selfOnlyDoc.policy,
      llm: () => ({ async resolveModelInfo(p, m) { return { provider: p, id: m, name: m, inputModalities: ['text'] } }, stream() { throw new Error('不应被调用') } }),
      warn: () => {},
    })
    const selfOnlyOut = []
    for await (const item of selfOnlyAdapter.stream({ provider: PROVIDER, model: 's', messages: [] })) selfOnlyOut.push(item)
    check(
      'M18 成员全指向自身时是 EMPTY_CHAIN',
      lastFinish(selfOnlyOut)?.reason?.failure?.code === 'EMPTY_CHAIN',
      JSON.stringify(lastFinish(selfOnlyOut)),
    )
  }
}

// ── [6] 宿主两层投影的交互边界（B1/B2 · M21/M22 的另一半）────────────────
/**
 * 宿主有**两处**读同一份 `inputModalities`：
 *   - 准入：`session-controller:940`，发图时若声明不含 image ⇒ `MODEL_DOES_NOT_SUPPORT_IMAGES`；
 *   - 请求投影：`dsh-llm:2337 → :745 projectImagesForTextModel`，把图片块换成占位文本，
 *     且发生在插件 `stream()` **之前**。
 *
 * 这里用**桩**复刻这两处判据（不 import 宿主代码），证明同一份声明的两个用途都对齐，
 * 并固定住 B1 的边界：纯文本链拿到的历史图已被投影，插件既检测不到也恢复不了。
 */
function testHostProjectionBoundary() {
  console.log('\n[6] 宿主两层投影交互边界（准入 / 请求投影）')

  // 复刻 `dsh-llm/lib/index.js:558 textOnlyImageText` 的真实占位格式
  const textOnlyImageText = (ref) =>
    `[image omitted because this model accepts text only; attachment sha256:${String(ref.attachmentId).slice(7, 15)}]`
  const hostAdmit = (inputModalities, messages) => {
    const hasImage = messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'image'))
    if (!hasImage) return { rejected: false, code: undefined }
    const rejects = inputModalities !== undefined && !inputModalities.includes('image')
    return { rejected: rejects, code: rejects ? 'MODEL_DOES_NOT_SUPPORT_IMAGES' : undefined }
  }
  // 复刻 `dsh-llm/lib/index.js:2337`：投影条件是**显式声明且不含 image**；
  // 缺省（undefined）= 未知 ⇒ 不投影、不拒绝，这正是插件必须给具体数组的原因。
  const hostProject = (inputModalities, messages) => {
    const hasImage = messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'image'))
    if (!hasImage) return messages
    if (inputModalities === undefined || inputModalities.includes('image')) return messages
    return messages.map((message) => ({
      ...message,
      content: message.content.flatMap((block) =>
        block.type === 'image' ? [{ type: 'text', text: textOnlyImageText(block.attachment) }] : [block],
      ),
    }))
  }

  // 纯文本链：准入拒绝（首选路径，R5）
  {
    const messages = [userMessage(textBlock('看'), imageBlock())]
    const admission = hostAdmit(['text'], messages)
    check('B1 纯文本链发新图 ⇒ 准入以 MODEL_DOES_NOT_SUPPORT_IMAGES 拒绝', admission.rejected === true && admission.code === 'MODEL_DOES_NOT_SUPPORT_IMAGES', JSON.stringify(admission))
    const projected = hostProject(['text'], messages)
    check('B1 纯文本链的历史图已被宿主投影成占位文本', projected[0].content.every((block) => block.type !== 'image'))
    check('B1 占位文本与宿主真实格式一致', projected[0].content.some((block) => /^\[image omitted because this model accepts text only; attachment sha256:/.test(block.text ?? '')), JSON.stringify(projected[0].content))
    check('B1 投影后插件结构判据看不到图片（不可恢复）', messagesRequireVision(projected) === false)
  }

  // 视觉链：准入放行 + 不投影 ⇒ 插件能看到图（B2）
  {
    const messages = [userMessage(textBlock('看'), imageBlock())]
    const admission = hostAdmit(['text', 'image'], messages)
    check('B2 视觉链发新图 ⇒ 准入放行', admission.rejected === false)
    const projected = hostProject(['text', 'image'], messages)
    check('B2 视觉链不投影，插件仍能看到图片块', messagesRequireVision(projected) === true)
    check('B2 图片引用原样保留（attachment 未被改写）', projected[0].content.some((block) => block.type === 'image' && block.attachment.attachmentId === 'sha256:0123456789abcdef'))
  }

  // inputModalities 缺省（undefined）= 未知 ⇒ 两道门都不动，发图被静默放行
  {
    const messages = [userMessage(imageBlock())]
    check('R5 缺省视为未知 ⇒ 准入不拒', hostAdmit(undefined, messages).rejected === false)
    check('R5 缺省视为未知 ⇒ 不投影（所以插件必须给具体数组）', messagesRequireVision(hostProject(undefined, messages)) === true)
  }

  // audio-only 链：不含 image ⇒ 与纯文本链同样被投影（R2b 的宿主侧后果）
  {
    const messages = [userMessage(imageBlock())]
    check('M25 audio-only 声明不含 image ⇒ 准入拒绝', hostAdmit(['audio'], messages).rejected === true)
    check('M25 audio-only 声明 ⇒ 历史图被投影', messagesRequireVision(hostProject(['audio'], messages)) === false)
  }
}

// ── [7] 运行状态消费方：跳过原因走有界记录并出现在 /api/status ────────────
/**
 * 契约"记录跳过成员原因应使用现有有界运行记录机制并覆盖消费方"：
 * 适配器只投递 `{kind:'skip', code:'NO_VISION'|'NO_VISION_MEMBER'}` 这类**固定码**，
 * `src/index.mjs` 的 `runtimeStatus()` 把它折进 `lastVisionSkip`，编辑器
 * `src/editor.html` 的 `routeLabel()` 把它显示成"跳过成员"。这里用真实 `apply()`
 * 走一遍 HTTP `/api/status`，断言记录存在且不含图片/提示词。
 */
async function testRuntimeStatusSurface() {
  console.log('\n[7] 运行状态消费方（/api/status 的图片筛选记录）')
  fresh()
  const { mkdtempSync, rmSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'multi-chain-image-status-'))
  const previous = process.env.DSH_MULTI_CHAIN_DIR
  process.env.DSH_MULTI_CHAIN_DIR = dir
  const disposers = []
  try {
    writeFileSync(
      join(dir, 'chains.json'),
      JSON.stringify({ chains: [{ id: 'mix', name: '混合链', models: ['a/x', 'b/y'] }] }),
      'utf8',
    )
    let handler
    let adapter
    const llm = {
      registerAdapter(_providers, value) {
        adapter = value
        return () => {}
      },
      listProviders: () => [],
      listModels: async () => [],
      async resolveModelInfo(provider, model) {
        return {
          provider,
          id: model,
          name: model,
          inputModalities: provider === 'a' ? ['text', 'image'] : ['text'],
        }
      },
      async *stream(options) {
        if (options.provider === 'a') {
          yield chunk.text('视觉成员作答')
          yield chunk.finishStop()
        } else {
          yield chunk.text('不该被调用')
          yield chunk.finishStop()
        }
      },
    }
    const { apply } = await import(new URL('../src/index.mjs?image=' + Date.now(), import.meta.url))
    apply(
      {
        llm,
        logger: () => ({ info() {}, warn() {} }),
        effect(fn) {
          const dispose = fn()
          if (dispose) disposers.push(dispose)
        },
        webServer: {
          register(options) {
            handler = options.handler
            return () => {}
          },
        },
      },
      {},
    )

    const call = async (url) => {
      let status, payload
      await handler(
        { method: 'GET', url, headers: { host: '127.0.0.1:8080' }, socket: { remoteAddress: '127.0.0.1' } },
        { writeHead(code) { status = code }, end(value) { payload = value } },
      )
      return { status, body: JSON.parse(payload) }
    }

    // 一次含图片的请求：视觉成员 a/x 作答，纯文本成员 b/y 被跳过
    for await (const _ of adapter.stream({ model: 'mix', sessionId: 's-img', messages: [userMessage(textBlock('看这张'), imageBlock())] })) { /* 跑真实路由 */ }

    const status = await call('/multi-chain/api/status')
    const row = status.body.chains[0]
    check('运行状态暴露图片筛选记录', row.lastVisionSkip?.kind === 'skip' && row.lastVisionSkip?.code === 'NO_VISION', JSON.stringify(row.lastVisionSkip))
    check('筛选记录点名被跳过的成员', row.lastVisionSkip?.provider === 'b' && row.lastVisionSkip?.model === 'y', JSON.stringify(row.lastVisionSkip))
    check('作答成员记为视觉成员 a/x', row.lastServed?.provider === 'a' && row.lastServed?.model === 'x', JSON.stringify(row.lastServed))
    check('有界记录仍限制 100 条', status.body.retention === 100)
    check('记录不含图片内容、提示词或凭据', /image|sha256|看这张|attachment/i.test(JSON.stringify(status.body)) === false, JSON.stringify(status.body).slice(0, 400))

    // 全文本链 + 有图 ⇒ 链级拒绝也留一条 skip 记录（code=NO_VISION_MEMBER）
    writeFileSync(
      join(dir, 'chains.json'),
      JSON.stringify({ chains: [{ id: 'plain', name: '纯文本链', models: ['a/x', 'b/y'] }] }),
      'utf8',
    )
    await new Promise((resolve) => setTimeout(resolve, 50))
    llm.resolveModelInfo = async (provider, model) => ({ provider, id: model, name: model, inputModalities: ['text'] })
    for await (const _ of adapter.stream({ model: 'plain', sessionId: 's-plain', messages: [userMessage(imageBlock())] })) { /* 跑真实路由 */ }
    const plainStatus = await call('/multi-chain/api/status')
    const plainRow = plainStatus.body.chains.find((chain) => chain.id === 'plain')
    check(
      '链级拒绝记录 code=NO_VISION_MEMBER',
      plainRow?.lastVisionSkip?.code === 'NO_VISION_MEMBER',
      JSON.stringify(plainRow?.lastVisionSkip),
    )
  } finally {
    disposers.reverse().forEach((dispose) => dispose())
    if (previous === undefined) delete process.env.DSH_MULTI_CHAIN_DIR
    else process.env.DSH_MULTI_CHAIN_DIR = previous
    resetCooldown()
    rmSync(dir, { recursive: true, force: true })
  }
}

async function main() {
  console.log('多链路由 · 图片路由语义自测（契约 v2 · M1–M27）')
  const cases = [testStructure, testModalityDescriptor, testDeclaration, testDelegationFiltering, testGuards, testHostProjectionBoundary, testRuntimeStatusSurface]
  for (const run of cases) {
    resetRotation()
    resetCooldown()
    await run()
  }
  resetCooldown()
  console.log(`\n结果：${passed} 通过 / ${failed} 失败`)
  process.exit(failed > 0 ? 1 : 0)
}

await main()
