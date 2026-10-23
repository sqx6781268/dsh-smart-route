/** 徽标会话隔离与提交时序回归：执行真实客户端源码，模拟 Hook/DOM 边界，不代替宿主视觉验收。 */
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import assert from 'node:assert/strict'
import { createWebUiHandler } from '../src/webui.mjs'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const a = { sessionId: 'A', provider: '渠道甲', model: '模型甲', chain: 'fast', time: 1 }
const b = { sessionId: 'B', provider: '渠道乙', model: '模型乙', chain: 'quality', time: 2 }
let passed = 0
function check(label, run) { run(); passed++; console.log('✓ ' + label) }

function harness(code) {
  let module, component, cursor = 0, pending = [], frames = [], rows = [a], deferred, visible = true
  const cells = [], calls = [], requests = []
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
  const fetch = async (url, options = {}) => {
    calls.push({ url, body: options.body ? JSON.parse(options.body) : undefined })
    if (url.endsWith('/served')) {
      requests.push(options.signal)
      if (deferred) return await deferred
      return { ok: true, json: async () => ({ served: rows }) }
    }
    return { ok: true }
  }
  runInNewContext(code, {
    window: { __ModuleLoader__: { load: (value) => { module = value.factory(() => react) } } },
    fetch, AbortSignal, AbortController, console,
    setTimeout: () => 1, clearTimeout: () => {},
    requestAnimationFrame: (fn) => { frames.push(fn); return 1 }, cancelAnimationFrame: () => {},
    ResizeObserver: class { observe() {} disconnect() {} },
    getComputedStyle: () => ({ display: 'inline-flex', visibility: 'visible', opacity: '0.85', color: 'rgb(220,220,220)' }),
    innerHeight: 1000, innerWidth: 1920,
    addEventListener: () => {}, removeEventListener: () => {},
    document: { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} },
  })
  module.apply({ slots: {
    inject: (_name, generator) => { for (const _value of generator()) { /* 收集注册 disposer 的宿主边界 */ } },
    register: (options, value) => { if (options.name === 'conversation.session.header.actions') component = value; return () => {} },
  } })
  return {
    calls, requests,
    render(sessionId) { cursor = 0; return component({ sessionId }) },
    commit(tree) {
      if (tree?.props.ref) tree.props.ref.current = node
      const work = pending; pending = []; work.forEach((run) => run())
      const scheduled = frames; frames = []; scheduled.forEach((run) => run())
    },
    setRows(value) { rows = value },
    defer(value) { deferred = value },
    hide() { visible = false },
    reports: () => calls.filter((call) => call.url.endsWith('/badge-rendered')),
  }
}
// 清空微任务队列，排空 fetch / json 两层异步；不使用定时等待。
async function settle() { for (let i = 0; i < 8; i++) await Promise.resolve() }

const h = harness(source)
h.commit(h.render('A')); await settle()
let tree = h.render('A')
check('正对照：A 会话显示 A 成员', () => assert.match(tree.children, /渠道甲\/模型甲/))
check('渲染阶段不提前上报 DOM', () => assert.equal(h.reports().length, 0))
h.commit(tree)
check('提交后上报会话和真实测量字段', () => {
  const payload = h.reports().at(-1).body
  assert.equal(payload.sessionId, 'A'); assert.equal(payload.stage, 'dom-committed')
  assert.equal(payload.rect.width, 180); assert.equal(payload.visible, true)
})
check('切换到 B 的首次渲染不闪现 A', () => assert.equal(h.render('B'), null))
h.commit(null); await settle()
check('只有 A 记录时 B 保持空，不借全局最新', () => assert.equal(h.render('B'), null))
h.commit(null)
check('切换会话中止旧请求', () => assert.equal(h.requests[0].aborted, true))

const missing = harness(source)
missing.commit(missing.render(undefined)); await settle()
check('没有权威身份时不渲染、不发 served 请求', () => {
  assert.equal(missing.render(undefined), null); assert.equal(missing.requests.length, 0)
})
const own = harness(source)
own.setRows([a, b]); own.commit(own.render('B')); await settle()
tree = own.render('B')
check('B 从多会话列表选自己的记录', () => assert.match(tree.children, /渠道乙\/模型乙/))
own.hide(); own.commit(tree)
check('DOM 存在但不可见时上报 visible=false', () => assert.equal(own.reports().at(-1).body.visible, false))

const late = harness(source)
let resolveOld
late.defer(new Promise((resolve) => { resolveOld = resolve }))
late.commit(late.render('A'))
late.defer(undefined); late.setRows([b]); late.commit(late.render('B')); await settle()
resolveOld({ ok: true, json: async () => ({ served: [a] }) }); await settle()
check('A 的延迟响应不能覆盖 B', () => assert.match(late.render('B').children, /渠道乙\/模型乙/))

// 负对照：同一行为判据对修复前源码应复现串会话，防止测试本身永远报绿。
if (process.argv[2]) {
  const old = harness(readFileSync(process.argv[2], 'utf8'))
  old.commit(old.render('B')); await settle()
  check('负对照：修复前 B 会错误显示 A', () => assert.match(old.render('B').children, /渠道甲\/模型甲/))
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
