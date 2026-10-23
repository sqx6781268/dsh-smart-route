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
 *   3. 链能力取成员交集：窗口取最小、vision 取与，免得链宣称 1M 却在半路溢出。
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

/** 宿主对取消终态也读取 failure.code/message，必须提供完整字段。 */
export function finishAborted(message = '请求已取消') {
  return { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message } } }
}

/** 异常和流式错误统一为终态；取消优先于可配置降级规则。 */
export function exceptionFinish(error) {
  if (error?.name === 'AbortError' || error?.code === 'ABORTED' || error?.code === 'ABORT_ERR') {
    return finishAborted(typeof error?.message === 'string' && error.message ? error.message : '下游请求已取消')
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


/** 模型选择器里那条说明文字。 */
function describeChain(chain) {
  const head = chain.models.slice(0, 3).map((member) => `${member.provider}/${member.model}`).join(' → ')
  const more = chain.models.length > 3 ? ` → …共 ${chain.models.length} 个` : ''
  return `${chain.models.length} 个候选：${head}${more}`
}

/** 汇总一条链所有成员的能力交集。成员不可解析就跳过，全不可用则什么也不宣称。 */
async function intersectCapabilities(deps, chain, signal) {
  const llm = deps.llm()
  const infos = []
  for (const member of chain.models) {
    if (member.provider === PROVIDER) {
      deps.warn?.(`multi-chain: 链 "${chain.name}" 的成员 ${member.provider}/${member.model} 指向自身，已忽略`)
      continue
    }
    try {
      infos.push(await llm.resolveModelInfo(member.provider, member.model, signal))
    } catch (error) {
      if (error?.code === 'MULTI_CHAIN_CAPABILITY_CYCLE') throw error
      deps.warn?.(
        `multi-chain: 无法解析成员 ${member.provider}/${member.model} 的能力（${error?.message ?? error}），该成员仍会尝试`,
      )
    }
  }
  if (infos.length === 0) return {}

  const windows = infos.map((info) => info?.context?.contextWindow).filter((value) => Number.isInteger(value) && value > 0)
  const outputs = infos.map((info) => info?.defaultMaxTokens).filter((value) => Number.isSafeInteger(value) && value > 0)

  const modalitySets = infos.map((info) =>
    Array.isArray(info?.inputModalities) ? new Set(info.inputModalities) : undefined,
  )
  const known = modalitySets.filter((set) => set !== undefined)
  const inputModalities =
    known.length === 0
      ? undefined
      : [...known.reduce((accumulator, set) => new Set([...accumulator].filter((modality) => set.has(modality))))]

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
    inputModalities: inputModalities !== undefined && inputModalities.length > 0 ? inputModalities : undefined,
    reasoning,
  }
}

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
      ...(capabilities.inputModalities === undefined ? {} : { inputModalities: capabilities.inputModalities }),
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

    // 冷却中的成员直接不进候选（决策⑥）。但**全部**都在冷却时不跳过 ——
    // 宁可让用户撞一次已知的墙，也不能让整条链凭空变成"无可用成员"。
    const usable = policy.cooldown?.enabled === false ? candidates : candidates.filter((member) => !isCooling(member))
    let ordered = usable
    if (usable.length === 0 && candidates.length > 0) {
      ordered = candidates
      deps.warn?.(`multi-chain: 链 "${chain.name}" 的 ${candidates.length} 个成员都在冷却期，本次仍全部尝试`)
    } else if (usable.length < candidates.length) {
      const skipped = candidates.filter((member) => isCooling(member))
        .map((member) => `${member.provider}/${member.model}`)
        .join('、')
      deps.warn?.(`multi-chain: 链 "${chain.name}" 跳过冷却中的成员：${skipped}`)
    }

    // 观察回调不参与路由；即使面板记录失败也不能吞掉回答或改变降级。
    const observe = (kind, member, extra = {}) => {
      try { deps.onRouteEvent?.({ kind, chain: chain.id, sessionId: options.sessionId,
        provider: member?.provider, model: member?.model, time: Date.now(), ...extra }) } catch { /* 观察失败不影响路由 */ }
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
