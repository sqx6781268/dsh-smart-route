/**
 * 多链路由适配器。
 *
 * 这是一个**结构性**适配器：不 extends 任何宿主基类，也不 import 任何
 * `@deepseek-ai/*` 符号。宿主 `registerAdapter()` 是按方法调用验证的，不看
 * instanceof，所以裸 class 就能通过；这样也彻底避开了「插件 import 的宿主
 * 符号在版本升级里被删掉」这类会打挂桌面端的故障。
 *
 * 设计要点（用户 2026-10-21 拍板）：
 *   1. commit 规则：候选产出的 chunk 先全部缓冲，直到出现第一个 answer-bearing
 *      delta 才交给调用方。在此之前失败的候选整块丢弃，切换对你完全不可见。
 *      reasoning delta **不算** commit ——「思考了一分钟然后撞配额墙」正是最值得
 *      降级的场景。
 *   2. 降级判据可配置（policy），默认全错误降级，但 aborted 和上下文超限永不降级。
 *   3. 链能力取成员交集：窗口取最小、输出上限取最小、reasoning 取交集，免得链
 *      宣称 1M 却在半路溢出；图片能力是**额外宣称**（见下方"图片路由"）。
 *
 * 图片路由（契约 `docs/图片路由契约冻结.md` v2 · R2/R2b/R5–R10）：
 *   - 视觉资格 = 成员**本次实时**解析出 `inputModalities` **同时含 text 与 image**
 *     （只有 `image` 的成员拿不到文本历史，不算视觉成员）。
 *   - 非 image 模态严格沿用基线交集规则，不做"凡不是 image 就当 text"的归一化，
 *     也不把模态做成并集（audio-only 链声明 `['audio']`）。
 *   - 有图请求在**委派前**按视觉成员过滤，且冷却兜底只在已筛集合内；无视觉成员
 *     时给独立终态 `NO_VISION_MEMBER`，零委派、不图转文。
 *   - 结构判据只认消息 `content` 数组里 `type === 'image'` 的块，覆盖全部消息
 *     （含 tool 结果），不做字符串搜索、不做任意递归、不只看最后一条。
 *
 * @module src/adapter.mjs
 */

import { cooldownUntilOf, isCooling, markCooldown, orderCandidates } from './chains.mjs'
import { AsyncLocalStorage } from 'node:async_hooks'
// 异步调用链携带能力解析路径，跨虚拟 provider 回调也能识别回环。
const capabilityPath = new AsyncLocalStorage()

/** 虚拟 provider 的注册名，也是模型选择器里的分组标题。 */
export const PROVIDER = 'MultiChain'
export const PROVIDER_LABEL = '多链路由'

/**
 * 委派深度标记与上限。
 *
 * 链成员理论上可以指向**另一个虚拟 provider**（比如 dsh-llm-fallbacks 的
 * FallbacksChain 又绕回 MultiChain），那就成环了。裸 class 不 extends 宿主基类，
 * 宿主也不会替我们断环，所以在一次请求内用深度标记兜底：
 * 超过上限直接给一个终态错误 chunk，而不是把宿主拖进无限委派。
 *
 * 用 Symbol 作键：宿主复制 options 走对象展开（会带上），
 * 而日志、序列化、callConfigEquals 都看不见它。
 */
export const DEPTH_KEY = Symbol('multiChainDepth')
export const MAX_DEPTH = 16

/**
 * 这个 chunk 是否已经让调用方「看见了答案」？
 *
 * 只有看见答案之后，放弃当前候选才会在界面上留下半截回答，所以这个判据是
 * 整个方案能不能用的分界线。text-delta 要非空白（纯换行噪音不算），
 * tool-call-delta 已开始就是协议行为，block-end 里的 reasoning 块不算。
 */
export function commitsAnswer(chunk) {
  if (chunk === null || typeof chunk !== 'object') return false
  if (chunk.type === 'text-delta') return typeof chunk.text === 'string' && chunk.text.trim() !== ''
  if (chunk.type === 'tool-call-delta') return true
  if (chunk.type !== 'block-end') return false
  if (chunk.block?.type === 'reasoning') return false
  if (chunk.block?.type === 'text') return typeof chunk.block.text === 'string' && chunk.block.text.trim() !== ''
  return true
}

/** 造一个终态错误 chunk —— 宿主对外的统一收尾格式。 */
function finishError(message, code) {
  return { type: 'finish', reason: { kind: 'error', failure: { message, code } } }
}

/**
 * failure 上是否携带合法的 `offloadImages`（宿主卸载恢复的**唯一**触发器）。
 *
 * 宿主 `dsh-compaction-image-offload/lib/index.js:141-145` 只在
 * `failure.code === 'IMAGE_OFFLOAD_REQUIRED' && failure.offloadImages !== undefined`
 * 时执行 `image/offload` 并重试；`dsh-llm/lib/index.js:448-456` 要求它是
 * `> 0` 的安全整数，其它字段也有白名单。因此这里只做**按白名单原样搬运**，
 * 不自造数量、不改写 code（契约 R10）。
 */
export function carriesImageOffload(failure) {
  return (
    failure !== null &&
    typeof failure === 'object' &&
    failure.code === 'IMAGE_OFFLOAD_REQUIRED' &&
    typeof failure.message === 'string' &&
    failure.message.length > 0 &&
    Number.isSafeInteger(failure.offloadImages) &&
    failure.offloadImages > 0
  )
}

/**
 * 按宿主 `failureSnapshot` 白名单**原样**复制一个 failure。
 *
 * 只用于"必须把成员真实 failure 交给宿主"的场景（图片卸载恢复）；不参与
 * 常规错误的归一化，也不扩大可接受字段集。
 */
export function preserveFailure(failure) {
  const kept = { message: failure.message, code: failure.code }
  if (Number.isInteger(failure.status)) kept.status = failure.status
  if (Number.isFinite(failure.providerRetryAfterMs) && failure.providerRetryAfterMs > 0) kept.providerRetryAfterMs = failure.providerRetryAfterMs
  if (typeof failure.requestId === 'string') kept.requestId = failure.requestId
  if (Number.isSafeInteger(failure.offloadImages) && failure.offloadImages > 0) kept.offloadImages = failure.offloadImages
  return kept
}

/** 宿主对取消终态也读取 failure.code/message，必须提供完整字段。 */
export function finishAborted(message = '请求已取消') {
  return { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message } } }
}

/** 异常和流式错误统一为终态；取消优先于可配置降级规则。 */
export function exceptionFinish(error) {
  if (error?.name === 'AbortError' || error?.code === 'ABORTED' || error?.code === 'ABORT_ERR') {
    return finishAborted(typeof error?.message === 'string' && error.message ? error.message : '下游请求已取消')
  }
  // 成员适配器抛出的 LlmError 自带 failure（含 offloadImages）。若这里只取
  // code/message 重建，宿主的图片卸载恢复链就断了（契约 R10），因此仅在这种
  // failure 上按白名单原样搬运，其余错误维持基线归一化。
  const carried = error?.failure
  if (carriesImageOffload(carried)) {
    return { type: 'finish', reason: { kind: 'error', failure: preserveFailure(carried) } }
  }
  const code = typeof error?.code === 'string' && error.code.trim() !== '' ? error.code.trim() : 'UPSTREAM_EXCEPTION'
  const message = typeof error?.message === 'string' ? error.message : String(error)
  return finishError(message, code)
}

/**
 * 判定一个候选的结局该不该触发降级。
 * @returns {{ degrade: boolean, reason: string, code: string | undefined }}
 *   `code` 只对 error 终态有意义，供冷却表判断「是不是确定性失败」。
 */
export function classifyOutcome(finish, threw, policy) {
  if (threw !== undefined && threw !== null) {
    return classifyOutcome(exceptionFinish(threw), undefined, policy)
  }

  const reason = finish?.reason
  if (reason === undefined) return { degrade: true, reason: '流未给出结束原因（按空响应处理）', code: undefined }
  if (reason.kind === 'aborted') return { degrade: false, reason: '调用方中止', code: undefined }

  if (reason.kind !== 'error') {
    // 正常收尾却一个答案 delta 都没产出 → 空响应，换下一家才有意义
    return { degrade: true, reason: `空响应（${reason.kind}）`, code: undefined }
  }

  const code = typeof reason.failure?.code === 'string' ? reason.failure.code : ''
  const message = typeof reason.failure?.message === 'string' ? reason.failure.message : ''
  const label = code === '' ? message || '未分类错误' : code

  if (policy.neverCodes.includes(code)) return { degrade: false, reason: `${label}（判据：不降级）`, code }
  if (policy.mode === 'all') return { degrade: true, reason: label, code }
  if (policy.mode === 'only') {
    return policy.codes.includes(code)
      ? { degrade: true, reason: label, code }
      : { degrade: false, reason: `${label}（不在降级码表内）`, code }
  }
  // all-except
  return policy.codes.includes(code)
    ? { degrade: false, reason: `${label}（在排除码表内）`, code }
    : { degrade: true, reason: label, code }
}

/**
 * 这个错误码该不该让渠道进入冷却（决策⑥）。
 *
 * 只认确定性失败：鉴权废了、配额没了 —— 换渠道才有意义，这个成员在冷却期内
 * 直接不再尝试。超时、5xx、限流都**不**冷却，那些是暂时性的。
 */
export function shouldCooldown(code, cooldown) {
  if (cooldown === undefined || cooldown === null || cooldown.enabled === false) return false
  if (typeof code !== 'string' || code === '') return false
  const codes = Array.isArray(cooldown.codes) ? cooldown.codes : []
  if (codes.length === 0) return false
  const upper = code.toUpperCase()
  return cooldown.match === 'contains'
    ? codes.some((candidate) => upper.includes(String(candidate).toUpperCase()))
    : codes.some((candidate) => String(candidate).toUpperCase() === upper)
}


/**
 * 视觉成员判据 —— 宣称与委派筛选**共用**这一个函数，避免两处判据分叉。
 *
 * 契约 v2（R2/B4）：视觉资格必须是成员**本次实时**声明的 `inputModalities`
 * **同时**含 `'text'` 与 `'image'`。只声明 `['image']` 的成员拿不到整段文本历史，
 * 发给它必然失败，所以**不**算视觉成员。未知（undefined/非数组）一律不算。
 */
export function isVisionMember(modalities) {
  return Array.isArray(modalities) && modalities.includes('text') && modalities.includes('image')
}

/**
 * 单条消息的 content 是否含真实图片块 —— **结构判据**，只扫数组一层。
 *
 * 与宿主 `contentHasImage`（`dsh-llm/lib/index.js:593`）同口径：`type === 'image'`
 * 即算，`offloaded: true` 仍算（成员适配器仍会拒绝历史图片块，当文本处理会让
 * 委派直接 `UNSUPPORTED_CONTENT`）。`type === 'file'` 不算（宿主已把文件投影成
 * 文本句柄）。**禁止**字符串搜索、禁止对 `tool-call.arguments`、`replayState`、
 * `meta` 等旁路字段做递归扫描 —— 那比宿主更宽，是误判源。
 */
export function contentRequiresVision(content) {
  if (!Array.isArray(content)) return false
  return content.some((block) => block !== null && typeof block === 'object' && block.type === 'image')
}

/**
 * 本次请求的**全部有效消息**（含 `role === 'tool'` 的工具结果）里是否有图片块。
 *
 * 契约 R6/R7：逐条看 `content`，不做"只看最后一条""只看 user"之类裁剪。
 * `messages` 不是数组时按"无图"处理（保守：不误判为需要视觉）。
 */
export function messagesRequireVision(messages) {
  if (!Array.isArray(messages)) return false
  return messages.some(
    (message) => message !== null && typeof message === 'object' && contentRequiresVision(message.content),
  )
}

/** 模型选择器里那条说明文字。 */
function describeChain(chain) {
  const head = chain.models.slice(0, 3).map((member) => `${member.provider}/${member.model}`).join(' → ')
  const more = chain.models.length > 3 ? ` → …共 ${chain.models.length} 个` : ''
  return `${chain.models.length} 个候选：${head}${more}`
}

/**
 * 这个错误是不是"调用方取消"？
 *
 * 三种形态都要认（与 `exceptionFinish` 的判据一致）：`name === 'AbortError'`
 * （DOMException）、`code === 'ABORTED'`（宿主/适配器归一化码）、
 * `code === 'ABORT_ERR'`（Node 底层码）。取消**不是**"能力未知"。
 */
function isAbortError(error) {
  return error?.name === 'AbortError' || error?.code === 'ABORTED' || error?.code === 'ABORT_ERR'
}

/**
 * 逐个成员解析能力（**本次实时**，契约 R4）。
 *
 * 宣称（`resolveModel`）与筛选（`#run`）各自调用一次，只读 `llm.resolveModelInfo`
 * 的返回值，不读 `capabilities.json`、不读任何启动期快照 —— 否则"同一进程内
 * 能力变化"会被陈旧快照掩盖（R4/M14）。
 *
 * 解析失败一律记日志并返回 `{ info: undefined }`，由调用方按"非视觉"处理（R3）。
 * 日志用**中性**表述"按非视觉处理"，不写"仍会尝试"：同样的失败在两个调用方
 * 后果不同 —— `intersectCapabilities`（宣称）里成员确实会继续参与路由，而
 * `#run` 的有图筛选里它随后会被 `isVisionMember` 筛掉、本次**根本不尝试**；
 * 一句"仍会尝试"在有图路径上是误导排障的假信息。
 *
 * 两类错误**不吞**、原样上抛：能力解析回环（必须可诊断）与调用方取消。
 * 取消若被当成"能力未知"，`visual` 会算成空集，终态就变成 `NO_VISION_MEMBER`，
 * 用户主动取消被伪装成"链不支持图片"（契约 M12 失效）。
 * @returns {Promise<Array<{ member: object, info: object | undefined }>>}
 */
async function resolveMemberInfos(deps, members, signal) {
  const llm = deps.llm()
  const resolved = []
  for (const member of members) {
    try {
      resolved.push({ member, info: await llm.resolveModelInfo(member.provider, member.model, signal) })
    } catch (error) {
      if (error?.code === 'MULTI_CHAIN_CAPABILITY_CYCLE') throw error
      if (isAbortError(error)) throw error
      deps.warn?.(
        `multi-chain: 无法解析成员 ${member.provider}/${member.model} 的能力（${error?.message ?? error}），按非视觉处理`,
      )
      resolved.push({ member, info: undefined })
    }
  }
  return resolved
}

/** 汇总一条链所有成员的能力交集。成员不可解析就跳过，全不可用则什么也不宣称。 */
async function intersectCapabilities(deps, chain, signal) {
  const members = []
  for (const member of chain.models) {
    if (member.provider === PROVIDER) {
      deps.warn?.(`multi-chain: 链 "${chain.name}" 的成员 ${member.provider}/${member.model} 指向自身，已忽略`)
      continue
    }
    members.push(member)
  }
  const infos = (await resolveMemberInfos(deps, members, signal)).map((entry) => entry.info)

  const windows = infos.map((info) => info?.context?.contextWindow).filter((value) => Number.isInteger(value) && value > 0)
  const outputs = infos.map((info) => info?.defaultMaxTokens).filter((value) => Number.isSafeInteger(value) && value > 0)

  // reasoning 菜单只在所有成员都支持同一组 effort 时才暴露，否则给了菜单也切不动
  const effortIds = infos.map((info) =>
    Array.isArray(info?.reasoning?.efforts) ? new Set(info.reasoning.efforts.map((effort) => effort.id)) : undefined,
  )
  const effortsKnown = effortIds.filter((set) => set !== undefined)
  let reasoning
  if (effortsKnown.length === infos.length && effortsKnown.length > 0) {
    const shared = [...effortsKnown.reduce((accumulator, set) => new Set([...accumulator].filter((id) => set.has(id))))]
    if (shared.length > 0) {
      const first = infos.find((info) => Array.isArray(info?.reasoning?.efforts))?.reasoning?.efforts ?? []
      const efforts = shared.map((id) => {
        const found = first.find((effort) => effort.id === id)
        return { id, name: found?.name ?? id }
      })
      const defaultEffort = shared.includes(infos[0]?.reasoning?.defaultEffort)
        ? infos[0].reasoning.defaultEffort
        : undefined
      reasoning = defaultEffort === undefined ? { efforts } : { efforts, defaultEffort }
    }
  }

  return {
    contextWindow: windows.length === 0 ? undefined : Math.min(...windows),
    maxTokens: outputs.length === 0 ? undefined : Math.min(...outputs),
    inputModalities: resolveInputModalities(infos),
    reasoning,
  }
}

/**
 * 链对外的 `inputModalities` —— 契约 v2 的**三段**算法（顺序固定、互不越界）。
 *
 * 1. 非 image 模态交集：只统计"解析成功且 `inputModalities` 是合法数组"的成员，
 *    沿用基线交集规则。视觉成员（text+image）把 `image` 交给第 2 段的**额外宣称**
 *    通道，所以它的 `image` 不进交集；非视觉成员按字面取值（只声明 `['image']`
 *    的成员就是"纯图像"，交集里保留 `image`，绝不补 `text`）。
 * 2. image 追加：仅当至少一个成员本次实时**同时**含 text 与 image 时追加。
 * 3. 兜底：交集为空/未知（含全部成员都解析失败）⇒ `['text']`；交集**已知非空**
 *    则原样保留（audio-only 链声明 `['audio']`，不得被改成 text）。
 *
 * 返回值**永远是具体数组**：宿主在 `inputModalities === undefined` 时按"未知"
 * 处理，既不投影也不拒绝，会让发图请求被静默放行（R5）。
 */
export function resolveInputModalities(infos) {
  const baseSets = (Array.isArray(infos) ? infos : []).map((info) => {
    if (!Array.isArray(info?.inputModalities)) return undefined
    const set = new Set(info.inputModalities)
    if (isVisionMember(info.inputModalities)) set.delete('image')
    return set
  })
  const knownBase = baseSets.filter((set) => set !== undefined)
  const shared =
    knownBase.length === 0
      ? undefined
      : [...knownBase.reduce((accumulator, set) => new Set([...accumulator].filter((modality) => set.has(modality))))]
  const base = shared !== undefined && shared.length > 0 ? shared : ['text']
  const anyVision = (Array.isArray(infos) ? infos : []).some((info) => isVisionMember(info?.inputModalities))
  return anyVision && !base.includes('image') ? [...base, 'image'] : base
}

/** 模型选择器里那条说明文字。 */

export class MultiChainAdapter {
  #deps

  /**
   * @param deps.chains - () => 当前生效的链数组
   * @param deps.policy - () => 当前生效的降级判据
   * @param deps.llm - () => llm 运行时（延迟取，避免启动顺序依赖）
   * @param deps.warn - 日志
   */
  constructor(deps) {
    this.#deps = deps
  }

  providerInfo(provider) {
    return { id: provider, name: PROVIDER_LABEL }
  }

  /**
   * 宿主在 `registerAdapter()` 里**无条件**调用这个方法（`dsh-llm/lib/index.js:1876`），
   * 拿不到就抛 TypeError。因为我们不 extends 宿主基类，基类的默认实现不会继承过来，
   * 必须自己给出：返回 undefined 表示"用宿主的标准重试默认值"。
   */
  providerRetryPolicy(_provider) {
    return undefined
  }

  /**
   * 同上：宿主 token 计量按每条请求调用它（`dsh-llm/lib/index.js:2054`）。
   * 声明 undefined = 本路由不宣称图片计价，调用方回落到中性估算。
   */
  imageRequestPricing(_provider, _model) {
    return undefined
  }

  /**
   * 与宿主基类默认实现一致：不重采样，原样交回尺寸与字节目标。
   * 链成员都按文本模型处理，但宿主在图像投影路径上会调它，缺了就是 TypeError。
   */
  imageRequestTarget(_provider, _model, image) {
    return { width: image.width, height: image.height, maxBytes: image.bytes }
  }

  async listModels(provider) {
    return this.#deps.chains().map((chain) => ({
      provider,
      id: chain.id,
      name: chain.name,
      description: describeChain(chain),
      // 目录不猜测能力；宿主按需通过 resolveModel 读取真实交集。
    }))
  }

  async resolveModel(provider, model, signal) {
    const chain = this.#deps.chains().find((candidate) => candidate.id === model)
    if (chain === undefined) return { provider, id: model, name: model }

    const path = capabilityPath.getStore() ?? []
    const key = JSON.stringify([provider, model])
    if (path.includes(key) || path.length >= MAX_DEPTH) {
      throw Object.assign(new Error('链能力解析出现回环或超过深度上限：' + [...path, key].join(' → ')), { code: 'MULTI_CHAIN_CAPABILITY_CYCLE' })
    }
    const capabilities = await capabilityPath.run([...path, key], () => intersectCapabilities(this.#deps, chain, signal))
    return {
      provider,
      id: model,
      name: chain.name,
      ...(capabilities.contextWindow === undefined ? {} : { context: { contextWindow: capabilities.contextWindow } }),
      ...(capabilities.maxTokens === undefined ? {} : { defaultMaxTokens: capabilities.maxTokens }),
      // inputModalities 永远是具体数组：缺省会被宿主当成"未知"，既不投影也
      // 不拒绝，发图请求就被静默放行了（契约 R5）。
      inputModalities: Array.isArray(capabilities.inputModalities) ? capabilities.inputModalities : ['text'],
      ...(capabilities.reasoning === undefined ? {} : { reasoning: capabilities.reasoning }),
    }
  }

  async prepareCall(provider, model, signal) {
    return {
      model: await this.resolveModel(provider, model, signal),
      stream: (options) => this.#run(options),
    }
  }

  /** 兜底入口：宿主在未经 prepareCall 的路径上直接调 stream 时也能工作。 */
  stream(options) {
    return this.#run(options)
  }

  async *#run(options) {
    const deps = this.#deps
    const abortedFinish = () => finishAborted()
    if (options.signal?.aborted) { yield abortedFinish(); return }
    const chainId = typeof options.model === 'string' ? options.model : ''
    const chain = deps.chains().find((candidate) => candidate.id === chainId)
    if (chain === undefined) {
      const available = deps.chains().map((candidate) => candidate.id).join('、') || '（空）'
      yield finishError(`链 "${chainId}" 不存在；可用链：${available}`, 'UNKNOWN_CHAIN')
      return
    }

    const candidates = orderCandidates(chain).filter((member) => {
      if (member.provider !== PROVIDER) return true
      deps.warn?.(`multi-chain: 链 "${chain.name}" 的成员 ${member.provider}/${member.model} 指向自身，已跳过`)
      return false
    })
    if (candidates.length === 0) {
      yield finishError(`链 "${chain.name}" 没有可用成员`, 'EMPTY_CHAIN')
      return
    }

    // 跨虚拟 provider 的环（A → FallbacksChain → MultiChain/B → …）在这里断掉
    const depth = Number(options[DEPTH_KEY] ?? 0) || 0
    if (depth >= MAX_DEPTH) {
      yield finishError(`委派深度超过 ${MAX_DEPTH} 层，疑似链成环，已中止`, 'MULTI_CHAIN_DEPTH')
      return
    }

    const policy = deps.policy()

    // 观察回调不参与路由；即使面板记录失败也不能吞掉回答或改变降级。
    const observe = (kind, member, extra = {}) => {
      try { deps.onRouteEvent?.({ kind, chain: chain.id, sessionId: options.sessionId,
        provider: member?.provider, model: member?.model, time: Date.now(), ...extra }) } catch { /* 观察失败不影响路由 */ }
    }

    // ── 图片请求：委派前按视觉成员筛选（契约 R6–R9）────────────────────
    // 顺序固定：orderCandidates → 去自引用 → 有图则只留视觉成员 → 冷却过滤 → 兜底。
    // 纯文本请求**不进这个分支**，也不额外解析能力，候选顺序一字不动（R1）。
    let visual = candidates
    if (messagesRequireVision(options.messages)) {
      // 必须用本次实时能力（R4）：每请求现解析，不读 capabilities.json 快照。
      //
      // 这一步是新增的 await 窗口，取消可能正好落在这里。两种形态都要收成
      // aborted 终态（M12），否则取消会被伪装成"链没有视觉成员"：
      //   1) 解析因取消 reject（AbortError/ABORTED/ABORT_ERR）→ 这里接住；
      //   2) 解析正常返回但 signal 已经取消 → 下面补的 signal 检查接住。
      // 一律由插件自己 yield 终态，不让裸异常逸出生成器（宿主会按 error 记这一轮）。
      let resolved
      try {
        resolved = await resolveMemberInfos(deps, candidates, options.signal)
      } catch (error) {
        if (isAbortError(error) || options.signal?.aborted) { yield abortedFinish(); return }
        throw error
      }
      if (options.signal?.aborted) { yield abortedFinish(); return }
      visual = resolved
        .filter((entry) => isVisionMember(entry.info?.inputModalities))
        .map((entry) => entry.member)
      // 跳过原因进有界运行记录（只记成员与固定码，不记图片、提示词、凭据）。
      for (const entry of resolved) {
        if (isVisionMember(entry.info?.inputModalities)) continue
        observe('skip', entry.member, { code: 'NO_VISION' })
        deps.warn?.(
          `multi-chain: 链 "${chain.name}" 跳过非视觉成员 ${entry.member.provider}/${entry.member.model}（本次请求含图片，该成员未同时声明 text 与 image）`,
        )
      }
      if (visual.length === 0) {
        // 零委派、不图转文、不退化成文本请求（R5/B3）。宿主准入本应在
        // session-controller 就拒掉，走到这里说明是中途从视觉链切过来。
        observe('skip', undefined, { code: 'NO_VISION_MEMBER' })
        deps.warn?.(`multi-chain: 链 "${chain.name}" 无成员同时声明 text 与 image，拒绝本次含图片的请求`)
        yield finishError(
          `链 "${chain.name}" 没有成员同时声明支持文本与图片；本次请求包含图片，已拒绝委派（不会把图片转成文字或改用纯文本成员）`,
          'NO_VISION_MEMBER',
        )
        return
      }
      deps.warn?.(
        `multi-chain: 链 "${chain.name}" 的本次请求含图片，已筛出 ${visual.length} 个视觉成员：${visual.map((member) => `${member.provider}/${member.model}`).join('、')}`,
      )
    }

    // 冷却中的成员直接不进候选（决策⑥）。但**全部**都在冷却时不跳过 ——
    // 宁可让用户撞一次已知的墙，也不能让整条链凭空变成"无可用成员"。
    // 兜底集合始终是"已按视觉筛过的集合"：有图请求永不因兜底引入纯文本成员（R9）。
    const usable = policy.cooldown?.enabled === false ? visual : visual.filter((member) => !isCooling(member))
    let ordered = usable
    if (usable.length === 0 && visual.length > 0) {
      ordered = visual
      deps.warn?.(`multi-chain: 链 "${chain.name}" 的 ${visual.length} 个成员都在冷却期，本次仍全部尝试`)
    } else if (usable.length < visual.length) {
      const skipped = visual.filter((member) => isCooling(member))
        .map((member) => `${member.provider}/${member.model}`)
        .join('、')
      deps.warn?.(`multi-chain: 链 "${chain.name}" 跳过冷却中的成员：${skipped}`)
    }

    const tried = []

    for (const member of ordered) {
      if (options.signal?.aborted) { yield abortedFinish(); return }
      observe('attempt', member)
      const held = []
      let committed = false
      let lastFinish
      let threw

      try {
        const llm = deps.llm()
        for await (let chunk of llm.stream({
          ...options,
          provider: member.provider,
          model: member.model,
          [DEPTH_KEY]: depth + 1,
        })) {
          if (options.signal?.aborted) { yield abortedFinish(); return }
          // 兼容下游中间件不完整的取消终态，避免宿主读取 failure 时崩溃。
          if (chunk?.type === 'finish' && chunk.reason?.kind === 'aborted' && !chunk.reason.failure) chunk = finishAborted()
          if (chunk?.type === 'finish') lastFinish = chunk
          if (committed) {
            yield chunk
            continue
          }
          held.push(chunk)
          if (commitsAnswer(chunk)) {
            committed = true
            observe('committed', member, { degraded: tried.length > 0 })
            // 首个 answer-bearing chunk = 这条请求实际打中的成员。请求对象带
            // sessionId（agent-loop 构造时写入），按会话记下来供会话徽标查询。
            if (typeof options.sessionId === 'string' && options.sessionId !== '') {
              try {
                deps.onServed?.({ sessionId: options.sessionId, provider: member.provider,
                  model: member.model, chain: chain.id, time: Date.now() })
              } catch { /* 观察回调失败不能影响已经取得的回答 */ }
            }
            for (const buffered of held) yield buffered
            held.length = 0
          }
        }
      } catch (error) {
        threw = error
      }

      // 取消和异常都必须有可见终态；已提交的请求绝不再切换成员。
      if (options.signal?.aborted) {
        if (!committed || lastFinish === undefined) yield abortedFinish()
        return
      }
      if (committed) {
        if (lastFinish === undefined) {
          yield threw === undefined ? finishError('上游流未提供结束原因', 'INCOMPLETE_STREAM') : exceptionFinish(threw)
        }
        return
      }
      const terminal = threw === undefined ? lastFinish : exceptionFinish(threw)

      // ── 图片卸载信号：必须原样交回宿主，不降级、不冷却（契约 R10）─────────
      // 宿主 agent 层（dsh-compaction-image-offload:141-145）只在
      // `failure.code === 'IMAGE_OFFLOAD_REQUIRED' && failure.offloadImages !== undefined`
      // 时卸载旧图片并重试。链若在这里降级，这个 failure 会被聚合成
      // ALL_CANDIDATES_FAILED，卸载恢复链就永远触发不了；若重建成只有
      // message+code，同样断链。所以：停在此成员、原样 yield、不写冷却表
      // （该码本就不在 DEFAULT_COOLDOWN.codes 内）。
      if (terminal?.reason?.kind === 'error' && carriesImageOffload(terminal.reason.failure)) {
        for (const buffered of held) if (buffered?.type !== 'finish') yield buffered
        observe('stopped', member, { code: 'IMAGE_OFFLOAD_REQUIRED' })
        deps.warn?.(
          `multi-chain: 链 "${chain.name}" 停在 ${member.provider}/${member.model} —— 成员要求卸载 ${terminal.reason.failure.offloadImages} 张图片（已原样交回宿主，由宿主卸载后重试）`,
        )
        yield terminal
        return
      }

      const verdict = classifyOutcome(terminal, undefined, policy)
      observe(verdict.degrade ? 'degrade' : 'stopped', member, { code: verdict.code || (threw ? 'THROWN' : 'EMPTY_RESPONSE') })
      if (verdict.degrade === false) {
        for (const buffered of held) if (buffered?.type !== 'finish') yield buffered
        if (terminal !== undefined) yield terminal
        deps.warn?.(`multi-chain: 链 "${chain.name}" 停在 ${member.provider}/${member.model} —— ${verdict.reason}`)
        return
      }

      tried.push(`${member.provider}/${member.model}（${verdict.reason}）`)
      deps.warn?.(`multi-chain: 链 "${chain.name}" 越过 ${member.provider}/${member.model} —— ${verdict.reason}`)

      // 确定性失败（鉴权废了 / 配额没了）就冷却这个成员，冷却期内不再浪费一次请求
      if (shouldCooldown(verdict.code, policy.cooldown)) {
        markCooldown(member, policy.cooldown.ms)
        const until = new Date(cooldownUntilOf(member) ?? Date.now()).toLocaleTimeString('zh-CN', { hour12: false })
        deps.warn?.(
          `multi-chain: 成员 ${member.provider}/${member.model} 进入冷却（${verdict.code}），到 ${until} 前不再尝试`,
        )
      }
    }

    yield finishError(
      `链 "${chain.name}" 的 ${ordered.length} 个候选全部失败：${tried.join('；')}`,
      'ALL_CANDIDATES_FAILED',
    )
  }
}
