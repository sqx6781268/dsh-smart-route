/**
 * dsh-multi-chain —— 多链路由插件（Host 半身）。
 *
 * 把一个虚拟 provider `MultiChain` 注册进宿主，链的 id 就是模型 id。
 * 于是在模型选择器里能直接看到 `MultiChain/fast`、`MultiChain/quality`，
 * 选中哪条就走哪条；链内某个模型失败时自动降到下一个。
 *
 * 链配置放在 Harness 之外（`~/.dsh/multi-chain/chains.json`），改完热生效，
 * 不需要重启 dsh —— 因为「换一条链试试」是高频操作，每次重启不可接受。
 *
 * 本文件刻意不 import 任何 `@deepseek-ai/*` 符号：宿主 registerAdapter() 是按
 * 方法调用验证的结构性契约，裸 class 即可；这样插件就不会因为宿主升级删掉
 * 某个导出而变成「桌面端双击没窗口」。
 *
 * @module src/index.mjs
 */

import { mkdirSync, readFileSync, watch, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createConfigStore } from './config-store.mjs'

import { DEFAULT_POLICY, CONFIG_VERSION, cooldownUntilOf, loadChains, normalizeDocument, pruneCooldown, pruneRotation } from './chains.mjs'
import { MultiChainAdapter, PROVIDER } from './adapter.mjs'
import { createWebUiHandler, validateAndSerialize } from './webui.mjs'

export const name = 'multi-chain'
// webServer：宿主浏览器 HTTP 载体，网页编辑器（src/webui.mjs）的路由挂在它上面
export const inject = ['llm', 'webServer']

/** 配置与产物的落点 —— 都在 Harness 之外，删掉文件即下线。 */
const DATA_DIR = process.env.DSH_MULTI_CHAIN_DIR ?? join(homedir(), '.dsh', 'multi-chain')
const CHAINS_FILE = join(DATA_DIR, 'chains.json')
const CAPABILITIES_FILE = join(DATA_DIR, 'capabilities.json')

/** 探针最多枚举多少个模型，避免异常目录把启动拖住。 */
const PROBE_MODEL_LIMIT = 500

/**
 * 探针的延迟重试时刻（毫秒）。
 *
 * 启动瞬间别的 provider 插件还没注册完，第一次探到的只有我们自己；
 * 这些重试覆盖启动早期；探到非 MultiChain/FallbacksChain 的可枚举模型后停止延迟重试，事件仍会重探。
 */
const PROBE_RETRY_DELAYS = [1500, 4000, 8000, 15000, 30000]

/** ctx.logger 在不同内核行上既可能是函数也可能是对象，统一成三个方法。 */
function makeLogger(ctx) {
  let sink
  try {
    sink = typeof ctx.logger === 'function' ? ctx.logger(name) : ctx.logger
  } catch {
    sink = undefined
  }
  const emit = (level, message) => {
    try {
      const method = sink?.[level]
      if (typeof method === 'function') method.call(sink, message)
      else if (level !== 'debug') sink?.debug?.(message)
    } catch {
      // 日志失败不能影响路由
    }
  }
  return {
    info: (message) => emit('info', message),
    warn: (message) => emit('warn', message),
    debug: (message) => emit('debug', message),
  }
}

/**
 * 能力清单探针：把宿主当前真实可用的 provider / model / 上下文窗口导成一份
 * JSON，供人挑链成员用。它只是写一个文件，不参与路由，失败也吞掉。
 *
 * **时机很关键**：`apply()` 跑在 profile 装载早期，那时别的 provider 插件
 * （llm-pi-ai 等）往往还没注册，第一次探到的只有我们自己。实测 2026-10-21
 * 重启后 capabilities.json 里 `providers` 只有 `MultiChain` 一个，就是这个原因。
 * 所以这里返回 provider 数给调用方，由调用方在稍后重探，直到看到别人的 provider。
 *
 * @returns {Promise<number>} 本次探到的 provider 数量
 */
async function probeCapabilities(ctx, state, log, active = () => true) {
  const report = {
    generatedAt: new Date().toISOString(),
    provider: PROVIDER,
    chainsFile: CHAINS_FILE,
    chains: state.chains,
    policy: state.policy,
    errors: state.errors,
    providers: [],
    truncated: false,
    modelLimit: PROBE_MODEL_LIMIT,
  }

  try {
    const providers = ctx.llm.listProviders()
    let counted = 0
    for (const provider of providers) {
      if (counted >= PROBE_MODEL_LIMIT) { report.truncated = true; break }
      if (!active()) return 0
      const entry = { id: provider.id, name: provider.name, models: [] }
      try {
        const models = await ctx.llm.listModels(provider.id)
        for (const model of models) {
          if (!active()) return 0
          if (counted >= PROBE_MODEL_LIMIT) { report.truncated = true; break }
          counted += 1
          const row = {
            id: model.id,
            name: model.name,
            description: model.description,
            inputModalities: model.inputModalities,
          }
          try {
            const info = await ctx.llm.resolveModelInfo(provider.id, model.id)
            row.contextWindow = info?.context?.contextWindow
            row.maxTokens = info?.defaultMaxTokens
            if (Array.isArray(info?.inputModalities) && info.inputModalities.length > 0) {
              row.inputModalities = info.inputModalities
            }
            if (Array.isArray(info?.reasoning?.efforts) && info.reasoning.efforts.length > 0) {
              row.reasoningEfforts = info.reasoning.efforts.map((effort) => effort.id)
            }
          } catch (error) {
            row.capabilityError = error instanceof Error ? error.message : String(error)
          }
          entry.models.push(row)
        }
      } catch (error) {
        entry.error = error instanceof Error ? error.message : String(error)
      }
      report.providers.push(entry)
    }
    log.info(
      `能力清单已导出到 ${CAPABILITIES_FILE}：${report.providers.length} 个 provider，${counted} 个模型`,
    )
  } catch (error) {
    report.probeError = error instanceof Error ? error.message : String(error)
    log.warn(`导出能力清单失败：${report.probeError}`)
  }

  // 就绪判据用的数字：排除自己的空目录与 FallbacksChain 的静态 Auto 之后，
  // 真正能挑进链里的模型数。
  const enumerable = report.providers
    .filter((provider) => provider.id !== PROVIDER && provider.id !== 'FallbacksChain')
    .reduce((sum, provider) => sum + provider.models.length, 0)
  report.enumerableModels = enumerable

  if (!active()) return enumerable
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    writeFileSync(CAPABILITIES_FILE, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  } catch (error) {
    log.warn(`写入 ${CAPABILITIES_FILE} 失败：${error instanceof Error ? error.message : String(error)}`)
  }

  return enumerable
}

export function apply(ctx, config) {
  const log = makeLogger(ctx)
  const configStore = createConfigStore(CHAINS_FILE, validateAndSerialize)
  let disposed = false
  const timers = new Set()
  const later = (fn, delay) => {
    const timer = setTimeout(() => { timers.delete(timer); if (!disposed) fn() }, delay)
    timers.add(timer); timer.unref?.(); return timer
  }
  ctx.effect?.(() => () => { disposed = true; for (const timer of timers) clearTimeout(timer); timers.clear() })

  /** 当前生效的链与判据。重新加载时整体替换，解析中的请求继续用旧快照。 */
  const state = {
    chains: [],
    policy: { ...DEFAULT_POLICY },
    errors: [],
    missing: true,
  }

  const reload = (reason) => {
    const next = loadChains(CHAINS_FILE)
    state.chains = next.chains
    state.configuredChains = next.configuredChains ?? next.chains
    state.version = next.version ?? CONFIG_VERSION
    state.$schema = next.$schema
    state.policy = next.policy
    state.errors = next.errors
    state.missing = next.missing === true
    pruneRotation(state.chains)
    pruneCooldown(state.chains)

    if (state.missing) {
      log.info(`未找到 ${CHAINS_FILE}，多链路由暂无可用链（放一个 JSON 即可上线，无需重启）`)
    } else if (state.errors.length > 0) {
      log.warn(`链配置有 ${state.errors.length} 处问题：${state.errors.join('；')}`)
    }
    const ids = state.chains.map((chain) => `${chain.id}(${chain.models.length})`).join('、') || '（无）'
    log.info(`多链路由已加载 ${state.chains.length} 条链：${ids}${reason === undefined ? '' : ` · ${reason}`}`)

    // 链变了就让 capabilities.json 跟着刷新（去抖，消除"快照滞后"误导排查）。
    // scheduleReloadProbe 在下方定义；启动调用通过 reason 判断短路，避免访问 TDZ。
    // 可选链不能保护尚未初始化的 const，不能移除下面的启动条件。
    if (reason !== undefined && reason !== '启动') scheduleReloadProbe?.()
  }

  reload('启动')

  // ── 实际打中成员的记录（会话徽标的数据源）──
  // 请求对象带 sessionId（agent-loop 写入），适配器在首个 answer chunk 处回调。
  // 按会话记最近一次：LRU 256 上限防泄漏；纯内存，重启即清（徽标本来就只关心当前）。
  const SERVED_LIMIT = 256
  const servedBySession = new Map()
  const recordServed = (entry) => {
    servedBySession.delete(entry.sessionId)
    servedBySession.set(entry.sessionId, entry)
    while (servedBySession.size > SERVED_LIMIT) {
      const oldest = servedBySession.keys().next().value
      servedBySession.delete(oldest)
    }
  }
  const recentServed = (limit = 20) => [...servedBySession.values()].slice(-limit).reverse()

  // 有界观察记录只保留路由事实与错误码，不保存提示词、回答、凭据或异常原文。
  const routeEvents = []
  const recordRouteEvent = (event) => {
    routeEvents.push({ ...event, sessionId: typeof event.sessionId === 'string' ? event.sessionId : undefined })
    if (routeEvents.length > 100) routeEvents.shift()
  }
  const runtimeStatus = () => {
    const now = Date.now()
    return { generatedAt: now, retention: 100, chains: state.configuredChains.map((chain) => {
      const events = routeEvents.filter((event) => event.chain === chain.id)
      return { id: chain.id, name: chain.name, enabled: chain.enabled,
        latest: events.at(-1) ?? null,
        lastDegrade: events.findLast((event) => event.kind === 'degrade') ?? null,
        lastServed: events.findLast((event) => event.kind === 'committed') ?? null,
        members: chain.models.map((member) => ({ ...member,
          cooldownUntil: state.policy.cooldown.enabled !== false && (cooldownUntilOf(member) ?? 0) > now ? cooldownUntilOf(member) : null })) }
    }), events: routeEvents.slice().reverse() }
  }

  const adapter = new MultiChainAdapter({
    chains: () => state.chains,
    policy: () => state.policy,
    llm: () => ctx.llm,
    warn: log.warn,
    onServed: recordServed,
    onRouteEvent: recordRouteEvent,
  })

  const registration = ctx.llm.registerAdapter([PROVIDER], adapter)
  log.info(`虚拟 provider "${PROVIDER}" 已注册，链会出现在模型选择器里`)

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      try {
        registration?.()
      } catch {
        // 释放失败不影响进程退出
      }
    })
  }

  // 链文件热更新：fs.watch 是主机制（秒级）。Windows 上偶尔漏事件，
  // 漏了就改一次文件或重启 —— 不为此引入常驻轮询。
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => {
      let watcher
      try {
        mkdirSync(DATA_DIR, { recursive: true })
        watcher = watch(DATA_DIR, { persistent: false }, (_event, filename) => {
          if (filename !== null && filename !== 'chains.json') return
          try {
            reload('文件变更')
          } catch (error) {
            log.warn(`热更新失败：${error instanceof Error ? error.message : String(error)}`)
          }
        })
        // 监听句柄不能拖住进程退出：插件是附属于宿主的，不是宿主
        watcher.unref?.()
      } catch (error) {
        log.warn(
          `无法监听 ${DATA_DIR}（${error instanceof Error ? error.message : String(error)}），改链后需重启 dsh 生效`,
        )
        watcher = undefined
      }
      return () => {
        try {
          watcher?.close()
        } catch {
          // 忽略
        }
      }
    })
  }

  if (config !== undefined && config !== null && Object.keys(config).length > 0) {
    log.info(`bundles 里还带着 ${Object.keys(config).length} 个配置项，本版忽略（链以 chains.json 为准）`)
  }

  // ── 网页编辑器（src/webui.mjs）：/multi-chain 路由挂在宿主 webServer 上 ──
  // 探针的最新能力清单缓存在 capabilitiesCache，供编辑器的「添加成员」下拉使用。
  let capabilitiesCache = { providers: [] }
  // 保存入口：normalize 校验 + 原子写 chains.json（fs.watch 随即热加载）
  const saveChains = (raw, expectedRevision) => {
    const saved = configStore.save(raw, expectedRevision)
    reload('网页保存')
    return { chains: state.configuredChains, errors: state.errors, revision: saved.revision }
  }

  if (typeof ctx.webServer?.register === 'function') {
    // 浏览器半身的自证记录（client.js apply() 执行后 POST 上来）。
    // 保留最近若干条阶段历史（inject-called → callback-ran → registered →
    // component-mounted …），单值会被后一条覆盖，看不出推进过程。
    let clientMountedState = null
    const clientMountedHistory = []
    let badgeRenderedState = null
    const handler = createWebUiHandler({
      readChains: () => { const snapshot = configStore.snapshot(); return { ...snapshot, chains: snapshot.configuredChains } },
      runtimeStatus,
      capabilities: () => capabilitiesCache,
      recentServed,
      paths: { chainsFile: CHAINS_FILE, capabilitiesFile: CAPABILITIES_FILE },
      saveChains,
      clientMounted: () => ({ latest: clientMountedState, history: clientMountedHistory.slice(-10) }),
      reportClientMounted: (entry) => {
        clientMountedState = entry
        clientMountedHistory.push(entry)
        if (clientMountedHistory.length > 50) clientMountedHistory.shift()
      },
      badgeRendered: () => badgeRenderedState,
      reportBadgeRendered: (entry) => {
        badgeRenderedState = entry
      },
      // 排查端点：吐宿主 clientModules 组合表与 boot graph 里与我们相关的行
      debugClientModules: () => {
        const svc = ctx.get?.('clientModules')
        if (svc === undefined || svc === null) return { available: false, reason: '宿主没有 clientModules 服务' }
        const table = svc.table ?? new Map()
        const ours = []
        for (const [name, record] of table.entries()) {
          if (name.includes('multi-chain') || name === 'multi-chain') {
            ours.push({ name, id: record.entry?.id, rev: record.entry?.rev, url: record.entry?.url, immediately: record.meta?.immediately, clientPath: record.meta?.clientPath })
          }
        }
        const graph = svc.composed
        const graphRows = Array.isArray(graph?.entries)
          ? graph.entries.filter((row) => String(row?.id ?? '').includes('multi-chain')).map((row) => ({ id: row.id, url: row.url, inject: row.inject, immediately: row.immediately === true }))
          : []
        return {
          available: true,
          tableSize: table.size,
          ours,
          graphRows,
          batches: Array.isArray(graph?.batches)
            ? graph.batches.map((b) => ({ phase: b.phase, url: String(b.url ?? '').slice(0, 120), entries: b.entries?.filter((e) => String(e).includes('multi-chain')) })).filter((b) => (b.entries?.length ?? 0) > 0)
            : [],
        }
      },
    })
    ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/multi-chain', handler }))
    log.info('网页编辑器已挂载：/multi-chain/')
  } else {
    log.warn('宿主没有 webServer 服务，网页编辑器不可用（链仍可手工编辑 chains.json）')
  }

  // ── 能力清单探针的时机控制 ──────────────────────────────────────────
  // 刚 apply 时别的 provider 插件往往还没注册（实测只探到自己一个），
  // 所以先探一次占位，再延迟重探。
  //
  // 就绪判据是「探到真实模型」而不是「探到多个 provider」——第一次实测
  // （2026-10-21 15:18）栽在这上面：1.5s 时 8 个 provider 都已注册，
  // 但 pi-ai 的 listModels 在凭据未就绪时静默返回 []（pi-ai.js:1894，
  // MISSING_CREDENTIAL → return []）、our-free-model 的 membership 还没装载，
  // 提前收工就导出了一份全空的清单。FallbacksChain 的 Auto 是静态的，不算数。
  let probed = false
  let probing = false
  const runProbe = async (reason) => {
    if (disposed || probing) return
    probing = true
    try {
      const count = await probeCapabilities(ctx, state, log, () => !disposed)
      if (disposed) return
      // 编辑器要用最新清单：每次探完都刷新缓存（探针内部已含 providers/models）
      try {
        capabilitiesCache = JSON.parse(readFileSync(CAPABILITIES_FILE, 'utf8'))
      } catch {
        // 读不到就保留旧缓存
      }
      if (count > 0) {
        if (!probed) log.info(`能力清单已就绪（${reason}）：探到 ${count} 个可枚举模型`)
        probed = true
      }
    } catch (error) {
      log.warn(`探针失败（${reason}）：${error instanceof Error ? error.message : String(error)}`)
    } finally {
      probing = false
    }
  }

  // 探针异步跑，不阻塞 apply
  void runProbe('启动')

  // 延迟重探：等各适配器的内部状态（凭据、账号池）就绪。用 unref，不拖住宿主退出。
  for (const delay of PROBE_RETRY_DELAYS) {
    later(() => { if (!probed) void runProbe(`延迟 ${delay}ms`) }, delay)
  }

  // 宿主每次改动适配器注册表都会发这个事件（dsh-llm/lib/index.js:1825）。
  // 无论是否已就绪都重探（去抖 500ms），让清单跟随适配器变化保持新鲜。
  if (typeof ctx.on === 'function') {
    let pending = undefined
    try {
      ctx.on('llm/adapters-updated', () => {
        clearTimeout(pending); timers.delete(pending)
        pending = later(() => {
          void runProbe('适配器变更')
        }, 500)
        pending.unref?.()
      })
    } catch {
      // 宿主没有这个事件也无所谓，延迟重探兜底
    }
  }

  // capabilities.json 里的 chains/MultiChain.models 是探针快照：链重载后旧值
  // 会误导排查（交接 §9.4 的"已知小滞后"）。重载顺带去抖重探一次 —— 链的
  // 增删本就该反映到 MultiChain 的模型目录里。
  let reloadProbeTimer
  const scheduleReloadProbe = () => {
    clearTimeout(reloadProbeTimer); timers.delete(reloadProbeTimer)
    reloadProbeTimer = later(() => {
      void runProbe('链重载')
    }, 800)
    reloadProbeTimer.unref?.()
  }
}
