/**
 * 徽标会话隔离、诊断开关与提交时序回归：执行真实客户端源码，模拟 Hook/DOM 边界，
 * 不代替宿主视觉验收。开关默认关闭；测试用 localStorage 桩显式开启诊断。
 */
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import assert from 'node:assert/strict'
import { createWebUiHandler } from '../src/webui.mjs'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const a = { sessionId: 'A', provider: '渠道甲', model: '模型甲', chain: 'fast', time: 1 }
const b = { sessionId: 'B', provider: '渠道乙', model: '模型乙', chain: 'quality', time: 2 }
let passed = 0
function check(label, run) { run(); passed++; console.log('✓ ' + label) }
async function checkAsync(label, run) { await run(); passed++; console.log('✓ ' + label) }

function harness(code, options = {}) {
  const { diagnostics = false, storageThrows = false, noAbortSignalAny = false } = options
  let module, component, cursor = 0, pending = [], rows = [a], deferred, deferredDiagnostics, visible = true
  const cells = [], calls = [], requests = []
  let clock = 0
  let timerSeq = 0
  const timers = new Map()
  let style = { display: 'inline-flex', visibility: 'visible', opacity: '0.85', color: 'rgb(220,220,220)' }
  let pageVisibility = 'visible'
  let styleReads = 0
  const documentListeners = new Map()
  const windowListeners = new Map()
  const observerInstances = []
  let frameSeq = 0
  const frameMap = new Map()

  // 固定时钟：让节流与轮询可复现，避免测试依赖真实等待。
  class FakeDate extends Date {
    constructor(...args) {
      if (args.length === 0) super(clock)
      else super(...args)
    }
    static now() { return clock }
  }

  const addListener = (map, type, fn) => {
    if (!map.has(type)) map.set(type, new Set())
    map.get(type).add(fn)
  }
  const removeListener = (map, type, fn) => { map.get(type)?.delete(fn) }
  const fire = (map, type) => { for (const fn of [...(map.get(type) ?? [])]) fn() }

  const node = {
    isConnected: true,
    getBoundingClientRect: () => ({ x: 500, y: 60, left: 500, top: 60, width: 180, height: 22, bottom: 82, right: 680 }),
    checkVisibility: () => visible,
  }
  const react = {
    useState(initial) {
      const index = cursor++
      cells[index] ??= { value: initial }
      return [cells[index].value, (value) => { cells[index].value = value }]
    },
    useRef(initial) { const index = cursor++; return (cells[index] ??= { current: initial }) },
    useEffect(effect, deps) {
      const index = cursor++
      const old = cells[index]
      if (!old || deps.some((value, i) => !Object.is(value, old.deps[i]))) {
        pending.push(() => { old?.cleanup?.(); cells[index] = { deps, cleanup: effect() } })
      }
    },
    createElement: (tag, props, children) => ({ tag, props, children }),
  }
  const fetch = async (url, requestOptions = {}) => {
    const call = {
      url,
      body: requestOptions.body ? JSON.parse(requestOptions.body) : undefined,
      signal: requestOptions.signal,
    }
    calls.push(call)
    if (url.endsWith('/served')) {
      requests.push(requestOptions.signal)
      if (deferred) return await deferred
      return { ok: true, json: async () => ({ served: rows }) }
    }
    if (deferredDiagnostics) return await deferredDiagnostics
    return { ok: true }
  }
  const document = {
    get visibilityState() { return pageVisibility },
    addEventListener: (type, fn) => addListener(documentListeners, type, fn),
    removeEventListener: (type, fn) => removeListener(documentListeners, type, fn),
  }
  runInNewContext(code, {
    window: { __ModuleLoader__: { load: (value) => { module = value.factory(() => react) } } },
    fetch, AbortController, console, Date: FakeDate,
    // noAbortSignalAny 模拟旧宿主：只有 timeout，没有 any，迫使源码走自行计时分支。
    AbortSignal: noAbortSignalAny ? { timeout: (ms) => AbortSignal.timeout(ms) } : AbortSignal,
    setTimeout: (fn, delay = 0) => {
      const id = ++timerSeq
      timers.set(id, { due: clock + Math.max(0, Number(delay) || 0), fn })
      return id
    },
    clearTimeout: (id) => { timers.delete(id) },
    requestAnimationFrame: (fn) => { const id = ++frameSeq; frameMap.set(id, fn); return id },
    cancelAnimationFrame: (id) => { frameMap.delete(id) },
    ResizeObserver: class {
      constructor(callback) { this.callback = callback; this.connected = false; observerInstances.push(this) }
      observe() { this.connected = true }
      disconnect() { this.connected = false }
    },
    getComputedStyle: () => { styleReads++; return style },
    innerHeight: 1000, innerWidth: 1920,
    localStorage: storageThrows
      ? { getItem() { throw new Error('存储被禁用') } }
      : { getItem: (key) => (diagnostics && key === 'multi-chain:diagnostics' ? '1' : null) },
    navigator: { userAgent: 'test-agent' },
    addEventListener: (type, fn) => addListener(windowListeners, type, fn),
    removeEventListener: (type, fn) => removeListener(windowListeners, type, fn),
    document,
  })
  module.apply({ slots: {
    inject: (_name, generator) => { for (const _value of generator()) { /* 收集注册 disposer 的宿主边界 */ } },
    register: (options, value) => { if (options.name === 'conversation.session.header.actions') component = value; return () => {} },
  } })

  const runFrames = () => {
    let guard = 0
    while (frameMap.size > 0 && guard++ < 20) {
      const work = [...frameMap.values()]
      frameMap.clear()
      work.forEach((run) => run())
    }
  }

  return {
    calls, requests,
    render(sessionId) { cursor = 0; return component({ sessionId }) },
    commit(tree) {
      if (tree?.props.ref) tree.props.ref.current = node
      const work = pending; pending = []; work.forEach((run) => run())
      runFrames()
    },
    // 模拟宿主卸载组件：执行已挂载 effect 的 cleanup，不再次调用渲染函数。
    unmount() {
      for (const cell of cells) {
        if (cell?.cleanup) {
          const cleanup = cell.cleanup
          cell.cleanup = undefined
          cleanup()
        }
      }
    },
    flushFrames: runFrames,
    pendingFrames: () => frameMap.size,
    setRows(value) { rows = value },
    defer(value) { deferred = value },
    deferDiagnostics(value) { deferredDiagnostics = value },
    hide() { visible = false },
    showCheckVisibility() { visible = true },
    setStyle(patch) { style = { ...style, ...patch } },
    resetStyleReads() { styleReads = 0 },
    styleReads: () => styleReads,
    hidePage() { pageVisibility = 'hidden'; fire(documentListeners, 'visibilitychange') },
    showPage() { pageVisibility = 'visible'; fire(documentListeners, 'visibilitychange') },
    fireResize() { fire(windowListeners, 'resize') },
    fireVisibility() { fire(documentListeners, 'visibilitychange') },
    fireObserver() { for (const observer of observerInstances) if (observer.connected) observer.callback() },
    activeObservers: () => observerInstances.filter((observer) => observer.connected).length,
    windowListenerCount: (type) => windowListeners.get(type)?.size ?? 0,
    documentListenerCount: (type) => documentListeners.get(type)?.size ?? 0,
    advance(ms) {
      clock += ms
      let guard = 0
      while (guard++ < 100) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.due <= clock)
          .sort((left, right) => left[1].due - right[1].due)[0]
        if (due === undefined) break
        timers.delete(due[0])
        due[1].fn()
      }
    },
    resetDiagnostics() { calls.splice(0, calls.length, ...calls.filter((call) => call.url.endsWith('/served'))) },
    mountReports: () => calls.filter((call) => call.url.endsWith('/client-mounted')),
    badgeReports: () => calls.filter((call) => call.url.endsWith('/badge-rendered')),
  }
}
// 清空微任务队列，排空 fetch / json / finally 多层异步；不使用定时等待。
async function settle() { for (let i = 0; i < 14; i++) await Promise.resolve() }

// —— 默认关闭：徽标正常显示，但完全不做诊断测量与诊断 POST ——
const off = harness(source)
off.commit(off.render('A')); await settle()
let tree = off.render('A')
check('正对照：A 会话显示 A 成员', () => assert.match(tree.children, /渠道甲\/模型甲/))
off.commit(tree); await settle()
check('默认关闭：不注册诊断观察器与 resize 诊断监听', () => {
  assert.equal(off.activeObservers(), 0)
  assert.equal(off.windowListenerCount('resize'), 0)
  // visibilitychange 仅保留核心轮询的 1 个监听，没有诊断测量监听。
  assert.equal(off.documentListenerCount('visibilitychange'), 1)
})
check('默认关闭：不产生 client-mounted 或 badge-rendered 诊断 POST', () => {
  assert.equal(off.mountReports().length, 0)
  assert.equal(off.badgeReports().length, 0)
})
check('默认关闭：served 查询与徽标显示仍正常', () => {
  assert.equal(off.requests.length, 1)
  assert.match(off.render('A').children, /渠道甲\/模型甲/)
})
check('默认关闭：读取诊断开关抛错也按关闭处理', () => {
  assert.equal(harness(source, { storageThrows: true }).mountReports().length, 0)
})
check('切换到 B 的首次渲染不闪现 A', () => assert.equal(off.render('B'), null))
off.commit(null); await settle()
check('只有 A 记录时 B 保持空，不借全局最新', () => assert.equal(off.render('B'), null))
off.commit(null)

const abort = harness(source)
abort.defer(new Promise(() => {}))
abort.commit(abort.render('A')); await settle()
abort.defer(undefined)
abort.commit(abort.render(undefined)); await settle()
check('切换会话中止在途请求', () => assert.equal(abort.requests[0].aborted, true))

// —— 显式开启：测量只走统一调度、单在途上报、会话切换清理 ——
const on = harness(source, { diagnostics: true })
on.commit(on.render('A')); await settle()
check('开启诊断：apply 注册阶段有 client-mounted 证据', () => {
  assert.ok(on.mountReports().length >= 1)
  assert.equal(typeof on.mountReports()[0].body.state, 'string')
})
check('渲染阶段不提前上报 DOM', () => assert.equal(on.badgeReports().length, 0))
tree = on.render('A')
on.commit(tree); await settle()
check('提交后上报会话和真实测量字段', () => {
  const payload = on.badgeReports().at(-1).body
  assert.equal(payload.sessionId, 'A'); assert.equal(payload.stage, 'dom-committed')
  assert.equal(payload.rect.width, 180); assert.equal(payload.visible, true)
  assert.equal(payload.display, 'inline-flex'); assert.equal(payload.pageVisibility, 'visible')
})
check('事件突发只排一个测量帧，不重复同步测量', () => {
  on.advance(1000); on.resetStyleReads()
  on.setStyle({ opacity: '0.7' })
  for (let i = 0; i < 6; i++) { on.fireResize(); on.fireObserver(); on.fireVisibility() }
  assert.equal(on.pendingFrames(), 1)
  on.flushFrames()
  assert.equal(on.styleReads(), 1)
})
await checkAsync('同样 rect 但样式变化仍上报，不只比较 rect', () => {
  on.advance(1000)
  on.resetDiagnostics()
  on.setStyle({ display: 'none' })
  on.fireResize(); on.flushFrames(); on.advance(1000)
  return settle().then(() => {
    const payload = on.badgeReports().at(-1)?.body
    assert.ok(payload, '样式变化应产生上报')
    assert.equal(payload.rect.width, 180)
    assert.equal(payload.display, 'none')
  })
})
await checkAsync('上报有最小间隔，连续变化不会逐次发送', () => {
  on.advance(1000); on.resetDiagnostics()
  on.setStyle({ color: 'rgb(1, 2, 3)' }); on.fireResize(); on.flushFrames()
  assert.equal(on.badgeReports().length, 1)
  return settle().then(() => {
    on.setStyle({ color: 'rgb(4, 5, 6)' }); on.fireResize(); on.flushFrames()
    assert.equal(on.badgeReports().length, 1)
    on.advance(399)
    assert.equal(on.badgeReports().length, 1)
    on.advance(1)
    assert.equal(on.badgeReports().length, 2)
    return settle()
  }).then(() => {
    assert.equal(on.badgeReports().at(-1).body.color, 'rgb(4, 5, 6)')
  })
})
await checkAsync('上报单在途且最新状态合并', () => {
  on.advance(1000); on.resetDiagnostics()
  let release
  on.deferDiagnostics(new Promise((resolve) => { release = resolve }))
  on.setStyle({ opacity: '0.6' }); on.fireResize(); on.flushFrames(); on.advance(1000)
  assert.equal(on.badgeReports().length, 1)
  on.setStyle({ opacity: '0.5' }); on.fireResize(); on.flushFrames(); on.advance(1000)
  assert.equal(on.badgeReports().length, 1)
  release({ ok: true }); return settle().then(() => {
    on.advance(1000); return settle()
  }).then(() => {
    const last = on.badgeReports().at(-1).body
    assert.equal(on.badgeReports().length, 2)
    assert.equal(last.opacity, '0.5')
  })
})

const missing = harness(source)
missing.commit(missing.render(undefined)); await settle()
check('没有权威身份时不渲染、不发 served 请求', () => {
  assert.equal(missing.render(undefined), null); assert.equal(missing.requests.length, 0)
})
const own = harness(source, { diagnostics: true })
own.setRows([a, b]); own.commit(own.render('B')); await settle()
tree = own.render('B')
check('B 从多会话列表选自己的记录', () => assert.match(tree.children, /渠道乙\/模型乙/))
own.hide(); own.commit(tree); await settle()
check('DOM 存在但不可见时上报 visible=false', () => assert.equal(own.badgeReports().at(-1).body.visible, false))

const late = harness(source)
let resolveOld
late.defer(new Promise((resolve) => { resolveOld = resolve }))
late.commit(late.render('A'))
late.defer(undefined); late.setRows([b]); late.commit(late.render('B')); await settle()
resolveOld({ ok: true, json: async () => ({ served: [a] }) }); await settle()
check('A 的延迟响应不能覆盖 B', () => assert.match(late.render('B').children, /渠道乙\/模型乙/))

// —— 清理：观察器、事件、rAF、定时器与在途请求都要随卸载/切换消失 ——
const cleanup = harness(source, { diagnostics: true })
cleanup.commit(cleanup.render('A')); await settle()
cleanup.commit(cleanup.render('A')); await settle()
cleanup.advance(1000)
check('开启诊断时确有观察器和事件', () => {
  assert.equal(cleanup.activeObservers(), 1)
  assert.equal(cleanup.windowListenerCount('resize'), 1)
  assert.equal(cleanup.documentListenerCount('visibilitychange'), 2)
})
cleanup.deferDiagnostics(new Promise(() => {}))
cleanup.setStyle({ opacity: '0.4' }); cleanup.fireResize(); cleanup.flushFrames(); cleanup.advance(1000)
cleanup.defer(new Promise(() => {})); cleanup.advance(4000)
check('切换前诊断与 served 请求都在途', () => {
  assert.equal(cleanup.badgeReports().at(-1).signal.aborted, false)
  assert.equal(cleanup.requests.at(-1).aborted, false)
})
cleanup.commit(cleanup.render(undefined)); await settle()
check('卸载/切换清理观察器、事件与 rAF', () => {
  assert.equal(cleanup.activeObservers(), 0)
  assert.equal(cleanup.windowListenerCount('resize'), 0)
  assert.equal(cleanup.documentListenerCount('visibilitychange'), 0)
  assert.equal(cleanup.pendingFrames(), 0)
})
check('卸载/切换中止在途诊断与 served 请求', () => {
  assert.equal(cleanup.badgeReports().at(-1).signal.aborted, true)
  assert.equal(cleanup.requests.at(-1).aborted, true)
})
const reportsAfterCleanup = cleanup.badgeReports().length
cleanup.resetStyleReads(); cleanup.fireResize(); cleanup.fireObserver(); cleanup.flushFrames(); cleanup.advance(4000)
check('卸载后事件不再触发测量或上报', () => {
  assert.equal(cleanup.styleReads(), 0)
  assert.equal(cleanup.badgeReports().length, reportsAfterCleanup)
})

// —— 挂载诊断也有独立 key：卸载时删除待发并 abort，不残留 component-mounted ——
const mountUnmount = harness(source, { diagnostics: true })
await settle()
mountUnmount.advance(800); await settle()
mountUnmount.deferDiagnostics(new Promise(() => {}))
mountUnmount.commit(mountUnmount.render('A')); await settle()
mountUnmount.advance(800); await settle()
const mountedCall = mountUnmount.mountReports().find((call) => call.body.state === 'component-mounted')
check('卸载前 component-mounted 在途且未中止', () => {
  assert.ok(mountedCall, '应已发出 component-mounted')
  assert.equal(mountedCall.signal.aborted, false)
})
const mountedCount = mountUnmount.mountReports().length
mountUnmount.unmount(); await settle()
check('卸载时 abort 在途 component-mounted，且不再产生新的 client-mounted', () => {
  assert.equal(mountedCall.signal.aborted, true)
  assert.equal(mountUnmount.mountReports().length, mountedCount)
})
mountUnmount.advance(4000); await settle()
check('卸载后推进定时器也不会补发 client-mounted', () => {
  assert.equal(mountUnmount.mountReports().length, mountedCount)
})

// —— apply 与 badge 分 key 且待发至少 2 条：registered 不会被 component-mounted 挤掉 ——
const sequence = harness(source, { diagnostics: true })
await settle()
sequence.advance(800); await settle()
check('apply 状态序列保留 callback-ran 与 registered', () => {
  assert.deepEqual(sequence.mountReports().map((call) => call.body.state), ['callback-ran', 'registered'])
})
sequence.commit(sequence.render('A')); await settle()
sequence.advance(800); await settle()
check('component-mounted 与 apply 状态分 key 并存', () => {
  assert.deepEqual(sequence.mountReports().map((call) => call.body.state),
    ['callback-ran', 'registered', 'component-mounted'])
})

// —— 无 AbortSignal.any 的旧宿主：自行计时超时，外部取消仍能中止 ——
const noAny = harness(source, { diagnostics: true, noAbortSignalAny: true })
noAny.defer(new Promise(() => {}))
noAny.commit(noAny.render('A')); await settle()
check('无 AbortSignal.any：自行计时 10 秒超时中止请求', () => {
  assert.equal(noAny.requests.length, 1)
  assert.equal(noAny.requests[0].aborted, false)
  noAny.advance(10000)
  assert.equal(noAny.requests[0].aborted, true)
})
const noAnyAbort = harness(source, { diagnostics: true, noAbortSignalAny: true })
noAnyAbort.defer(new Promise(() => {}))
noAnyAbort.commit(noAnyAbort.render('A')); await settle()
noAnyAbort.unmount(); await settle()
check('无 AbortSignal.any：卸载仍能中止在途 served 请求', () => assert.equal(noAnyAbort.requests[0].aborted, true))

// —— 隐藏页面暂停 served 轮询，恢复立即刷新且不并发、不串值 ——
const hidden = harness(source)
hidden.commit(hidden.render('A')); await settle()
check('隐藏前已完成一次 served 查询', () => assert.equal(hidden.requests.length, 1))
hidden.hidePage(); hidden.advance(20000); await settle()
check('隐藏页面暂停 served 轮询', () => assert.equal(hidden.requests.length, 1))
let releaseServed
hidden.defer(new Promise((resolve) => { releaseServed = resolve }))
hidden.showPage(); await settle()
check('恢复可见立即刷新', () => assert.equal(hidden.requests.length, 2))
hidden.hidePage(); hidden.showPage(); hidden.advance(20000); await settle()
check('在途时不并发轮询', () => assert.equal(hidden.requests.length, 2))
releaseServed({ ok: true, json: async () => ({ served: [a] }) }); await settle(); await settle()
check('在途结束后补一次刷新且结果仍属本会话', () => {
  assert.equal(hidden.requests.length, 3)
  assert.match(hidden.render('A').children, /渠道甲\/模型甲/)
})
hidden.defer(undefined)
hidden.advance(4000); await settle()
check('恢复后按 POLL_MS 继续串行轮询', () => assert.equal(hidden.requests.length, 4))

// 负对照：同一行为判据对修复前源码应复现串会话，防止测试本身永远报绿。
if (process.argv[2]) {
  const old = harness(readFileSync(process.argv[2], 'utf8'))
  old.commit(old.render('B')); await settle()
  check('负对照：修复前 B 会错误显示 A', () => assert.match(old.render('B').children, /渠道甲\/模型甲/))

  // 旧行为负对照：修复前源码即使未加开关也会持续发诊断 POST。
  const oldDiag = harness(readFileSync(process.argv[2], 'utf8'))
  oldDiag.commit(oldDiag.render('A')); await settle()
  oldDiag.commit(oldDiag.render('A')); await settle()
  check('负对照：修复前默认就会发诊断 POST', () => {
    assert.ok(oldDiag.mountReports().length > 0)
    assert.ok(oldDiag.badgeReports().length > 0)
  })
}

let stored
const handler = createWebUiHandler({ reportBadgeRendered: (value) => { stored = value } })
const submit = async (body) => {
  const req = { method: 'POST', url: '/multi-chain/api/badge-rendered', headers: {host:'127.0.0.1:8080','content-type':'application/json'}, socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) } }
  await handler(req, { writeHead() {}, end() {} })
}
await submit({ label: '渠道/模型', sessionId: 'A', stage: 'dom-committed', visible: false,
  rect: { x: 1, y: 2, width: 0, height: 22 }, color: 'transparent', display: 'none' })
check('服务端保留 DOM 证据及 false 值', () => {
  assert.equal(stored.stage, 'dom-committed'); assert.equal(stored.sessionId, 'A')
  assert.equal(stored.visible, false); assert.equal(stored.rect.width, 0); assert.equal(stored.display, 'none')
})
await submit({ label: '旧客户端' })
check('旧上报标记为 render-branch，不能冒充 DOM 提交', () => {
  assert.equal(stored.stage, 'render-branch'); assert.equal(stored.visible, undefined)
})
console.log(`徽标回归：${passed} 通过 / 0 失败（模拟边界，待宿主验收）`)
