/**
 * 链的归一化与加载。
 *
 * 成员写法两种都收（用户 2026-10-21 拍板）：
 *   - 字符串 "provider/model"：按**第一个** "/" 切分，与 dsh-llm-fallbacks 的
 *     parseSelector 保持一致。model 名本身可能自带 "/"（pi-ai 的
 *     "codearts/deepseek-v4.1-flash" 就是），剩余斜杠保留在 model 中，不会再切分。
 *   - 对象 { provider, model }：无歧义，推荐。
 *
 * 单条链或单个成员不合法时**只丢自己**并记一条错误，不牵连其它链——
 * 因为这个文件是人手编的，写错一个不能导致整条路由瘫掉。
 *
 * @module src/chains.mjs
 */

import { readFileSync } from 'node:fs'

/** 策略白名单。未知值回落 fallback，不把笔误当配置。 */
export const STRATEGIES = ['fallback', 'round-robin']
export const CONFIG_VERSION = 1

/**
 * 渠道冷却的默认值（用户决策⑥：只对 AUTH / QUOTA / ACCOUNT_QUOTA 冷却，5 分钟可配）。
 *
 * 默认码取自宿主与 pi-ai 适配器的真实码表，不是猜的：
 *   - `AUTH`               pi-ai 把 401/403 归到这里（dsh-llm-pi-ai/lib/index.js:1449）
 *   - `INVALID_CREDENTIAL` 宿主自己的 key 空白/非法字符码（dsh-llm/lib/index.js:158）
 *   - `QUOTA`              配额耗尽（:138）
 *   - `QUOTA_EXCEEDED`     旧写法/第三方 provider 常用名，与 QUOTA 同族
 *   - `ACCOUNT_QUOTA`      账号额度耗尽（:140）
 * 故意**不含** TIMEOUT / SERVER / TRANSPORT / RATE_LIMIT —— 那些是暂时性故障，
 * 冷却它们只会把一个本来还能用的渠道白扔五分钟。
 */
export const DEFAULT_COOLDOWN = Object.freeze({
  enabled: true,
  /** 冷却时长：5 分钟 */
  ms: 5 * 60 * 1000,
  codes: Object.freeze(['AUTH', 'INVALID_CREDENTIAL', 'QUOTA', 'QUOTA_EXCEEDED', 'ACCOUNT_QUOTA']),
  /** exact = 码完全相等；contains = 只是包含（兼容第三方 provider 的 AUTH_FAILED 之类） */
  match: 'exact',
})

/** 降级判据的默认值（用户拍板：全错误降级，判据可配置）。 */
export const DEFAULT_POLICY = Object.freeze({
  /** all = 任何 error 都降级；only = 只降 codes 里的；all-except = 除了 codes 全降 */
  mode: 'all',
  /** 无论 mode 如何都不降级的码：用户主动中止、上下文超限（换谁都超） */
  neverCodes: Object.freeze(['ABORTED', 'CONTEXT_WINDOW_EXCEEDED']),
  codes: Object.freeze([]),
  /** 渠道冷却（决策⑥）：配置文件里不写就按 DEFAULT_COOLDOWN 生效 */
  cooldown: DEFAULT_COOLDOWN,
})


/** 冷却归一化：非法值一律回落默认，`false` 表示整体关闭。 */
export function normalizeCooldown(raw) {
  if (raw === false) return { ...DEFAULT_COOLDOWN, enabled: false }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ...DEFAULT_COOLDOWN }

  const asCodes = (value) =>
    Array.isArray(value)
      ? value.filter((code) => typeof code === 'string' && code.trim() !== '').map((code) => code.trim())
      : [...DEFAULT_COOLDOWN.codes]
  const ms = Number.isFinite(Number(raw.ms)) && Number(raw.ms) > 0 ? Math.max(1, Math.trunc(Number(raw.ms))) : DEFAULT_COOLDOWN.ms

  return {
    enabled: raw.enabled !== false,
    ms,
    codes: asCodes(raw.codes),
    match: raw.match === 'contains' ? 'contains' : 'exact',
  }
}


/** "provider/model" -> { provider, model }。第一个 "/" 是分隔点。 */
export function parseMemberText(text) {
  const trimmed = String(text ?? '').trim()
  const slash = trimmed.indexOf('/')
  if (slash <= 0 || slash === trimmed.length - 1) return undefined
  const provider = trimmed.slice(0, slash).trim()
  const model = trimmed.slice(slash + 1).trim()
  if (provider === '' || model === '') return undefined
  return { provider, model }
}

/** 单个成员归一化；不合法返回 undefined。 */
export function normalizeMember(raw) {
  if (typeof raw === 'string') return parseMemberText(raw)
  if (raw === null || typeof raw !== 'object') return undefined
  const provider = typeof raw.provider === 'string' ? raw.provider.trim() : ''
  const model = typeof raw.model === 'string' ? raw.model.trim() : ''
  if (provider === '' || model === '') return undefined
  return { provider, model }
}

/**
 * 一条链归一化。返回 undefined 表示这条链该被丢弃（无 id 或无有效成员）。
 * @param raw - 配置文件里的一条链
 * @param index - 它在数组里的位置，仅用于兜底 id
 */
export function normalizeChain(raw, index) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined

  const rawId = typeof raw.id === 'string' ? raw.id.trim() : ''
  const id = rawId === '' ? `chain-${index + 1}` : rawId
  const name = typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name.trim() : id

  const models = []
  const seen = new Set()
  for (const candidate of Array.isArray(raw.models) ? raw.models : []) {
    const member = normalizeMember(candidate)
    if (member === undefined) continue
    const key = `${member.provider}\u0000${member.model}`
    if (seen.has(key)) continue
    seen.add(key)
    models.push(member)
  }
  if (models.length === 0) return undefined

  const strategy = STRATEGIES.includes(raw.strategy) ? raw.strategy : 'fallback'
  const stickyLimit =
    Number.isFinite(Number(raw.stickyLimit)) && Number(raw.stickyLimit) > 0
      ? Math.max(1, Math.trunc(Number(raw.stickyLimit)))
      : 1

  return { id, name, strategy, stickyLimit, models, enabled: raw.enabled !== false }
}

/** 降级判据归一化：只认已知 mode，其余回落默认。 */
export function normalizePolicy(raw) {
  if (raw === null || typeof raw !== 'object') return { ...DEFAULT_POLICY }
  const mode = ['all', 'only', 'all-except'].includes(raw.mode) ? raw.mode : DEFAULT_POLICY.mode
  const asCodes = (value) =>
    Array.isArray(value) ? value.filter((code) => typeof code === 'string' && code.trim() !== '').map((code) => code.trim()) : []
  return {
    mode,
    neverCodes: raw.neverCodes === undefined ? [...DEFAULT_POLICY.neverCodes] : asCodes(raw.neverCodes),
    codes: asCodes(raw.codes),
    // 不写 cooldown 字段时用默认冷却（决策⑥ 的默认行为），写了才按写的来
    cooldown: normalizeCooldown(raw.cooldown ?? true),
  }
}

/**
 * 整份配置归一化。
 * @returns {{ chains: Array<object>, policy: object, errors: string[] }}
 */
export function normalizeDocument(raw) {
  const errors = []
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray(raw.chains)) {
    return { version: CONFIG_VERSION, chains: [], configuredChains: [], policy: { ...DEFAULT_POLICY }, errors: ['配置必须是含 chains 数组的对象'] }
  }
  const version = raw.version === undefined ? CONFIG_VERSION : raw.version
  if (version !== CONFIG_VERSION) {
    return { version, chains: [], configuredChains: [], policy: { ...DEFAULT_POLICY }, errors: [`不支持配置版本 ${String(version)}，当前只支持 ${CONFIG_VERSION}`] }
  }
  const schema = typeof raw.$schema === 'string' ? raw.$schema : undefined
  const rows = raw.chains
  const configuredChains = []
  const chains = []
  const seen = new Set()

  rows.forEach((row, index) => {
    const chain = normalizeChain(row, index)
    if (chain === undefined) {
      errors.push(`第 ${index + 1} 条链无效（缺 id 或没有可用成员），已跳过`)
      return
    }
    if (seen.has(chain.id)) {
      errors.push(`链 id "${chain.id}" 重复，第 ${index + 1} 条已跳过`)
      return
    }
    seen.add(chain.id)
    configuredChains.push(chain)
    if (chain.enabled === false) return
    chains.push(chain)
  })

  return { version, ...(schema === undefined ? {} : { $schema: schema }), chains, configuredChains, policy: normalizePolicy(raw.policy), errors }
}

/**
 * 从 JSON 文件加载。文件不存在 / 读不动 / 解析失败都**不抛**，
 * 返回空链表 + 一条错误，让插件照常启动（用户拍板：校验不阻断运行）。
 */
export function loadChains(filePath) {
  let text
  try {
    text = readFileSync(filePath, 'utf8')
  } catch (error) {
    const code = error?.code
    if (code === 'ENOENT') {
      return { chains: [], policy: { ...DEFAULT_POLICY }, errors: [], missing: true }
    }
    return { chains: [], policy: { ...DEFAULT_POLICY }, errors: [`读取 ${filePath} 失败：${code ?? error}`] }
  }

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { chains: [], policy: { ...DEFAULT_POLICY }, errors: [`解析 ${filePath} 失败：${error.message}`] }
  }

  return { ...normalizeDocument(parsed), missing: false }
}

/**
 * 轮转游标：进程内存态。重启丢掉只是换个起点，不丢数据。
 * 严格每轮轮转会破坏所有 provider 的 prompt cache，所以用 stickyLimit 折中。
 */
const rotation = new Map()

/** 按策略给出本次请求的候选顺序。peek=true 时不消耗轮次。 */
export function orderCandidates(chain, options = {}) {
  const members = chain.models
  if (members.length <= 1 || chain.strategy !== 'round-robin') return [...members]

  const limit = chain.stickyLimit
  const cursor = rotation.get(chain.id) ?? { index: 0, used: 0 }
  const index = Math.min(Math.max(cursor.index, 0), members.length - 1)
  const ordered = [...members.slice(index), ...members.slice(0, index)]

  if (options.peek !== true) {
    const used = cursor.used + 1
    rotation.set(
      chain.id,
      used >= limit ? { index: (index + 1) % members.length, used: 0 } : { index, used },
    )
  }
  return ordered
}

/** 丢掉已不存在的链的游标，避免 Map 无限长。 */
export function pruneRotation(chains) {
  const live = new Set(chains.map((chain) => chain.id))
  for (const key of rotation.keys()) if (!live.has(key)) rotation.delete(key)
}

/** 测试用：游标是进程态。 */
export function resetRotation() {
  rotation.clear()
}

/**
 * 渠道冷却表：进程内存态，按 `provider/model` 记到某个时间点为止。
 *
 * 为什么按成员而不是按链：同一个 `a/x` 往往同时出现在多条链里，
 * 它挂了就该在**所有**链里一起被跳过，否则用户换条链又被同样的配额墙撞一次。
 * 重启丢掉只是让大家重新试一次，不丢正确性。
 */
const cooldownUntil = new Map()

/** 一个成员的冷却键。 */
export function cooldownKey(member) {
  return `${member.provider}\u0000${member.model}`
}

/** 标记一个成员冷却 ms 毫秒。ms 非正则忽略。 */
export function markCooldown(member, ms, now = Date.now()) {
  if (!(Number(ms) > 0)) return
  cooldownUntil.set(cooldownKey(member), now + Math.trunc(Number(ms)))
}

/** 该成员此刻是否在冷却期。 */
export function isCooling(member, now = Date.now()) {
  const until = cooldownUntil.get(cooldownKey(member))
  return until !== undefined && until > now
}

/** 冷却到期时间（毫秒时间戳），没有则 undefined —— 只用于日志。 */
export function cooldownUntilOf(member) {
  return cooldownUntil.get(cooldownKey(member))
}

/** 丢掉已过期、或已不在任何链里的冷却记录，避免 Map 无限长。 */
export function pruneCooldown(chains, now = Date.now()) {
  const live = new Set()
  for (const chain of chains) for (const member of chain.models) live.add(cooldownKey(member))
  for (const [key, until] of cooldownUntil) {
    if (!live.has(key) || until <= now) cooldownUntil.delete(key)
  }
}

/** 测试用：冷却表是进程态。 */
export function resetCooldown() {
  cooldownUntil.clear()
}
