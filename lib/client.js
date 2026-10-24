/**
 * 多链路由浏览器半身：头部显示本会话最近实际打中的成员。
 * 宿主 ModuleLoader 装配模块；会话插槽通过 props 注入权威 sessionId。
 * 不写自定义会话事件，轮询服务端进程内记录；失败时收起徽标。
 * 性能边界：所有布局测量与诊断上报默认关闭，只有 localStorage 显式
 * 设置 multi-chain:diagnostics=1 才启用；诊断永不阻塞徽标主路径。
 */
window.__ModuleLoader__.load({
  id: 'dsh-multi-chain',
  factory: (require) => {
    const react = require('react')
    const POLL_MS = 4000
    const DIAGNOSTICS_KEY = 'multi-chain:diagnostics'
    const REQUEST_TIMEOUT_MS = 10000
    // 同一队列两次发送的最小间隔；事件突发先合并，再按此上限节流。
    const BADGE_REPORT_MIN_INTERVAL_MS = 400
    const MOUNT_REPORT_MIN_INTERVAL_MS = 750
    // 不同会话的待上报状态都保留最新一条，避免一个会话覆盖另一个会话。
    const BADGE_PENDING_LIMIT = 4
    // apply 与 badge 分属不同 key；至少保留 2 条，避免 component-mounted 挤掉 registered。
    const MOUNT_PENDING_LIMIT = 2

    /** 存储被禁用、隐私模式或读取抛错时一律按关闭处理，不能影响徽标显示。 */
    function diagnosticsEnabled() {
      try {
        return globalThis.localStorage?.getItem(DIAGNOSTICS_KEY) === '1'
      } catch {
        return false
      }
    }

    /**
     * 请求取消信号：优先用 AbortSignal.any 合并外部取消与 10 秒超时。
     * 无 AbortSignal.any 的旧宿主退回自行计时：外部取消或超时任一触发都 abort，
     * 请求结束后 dispose 清理定时器与监听，避免轮询累积泄漏。
     */
    function createRequestSignal(signal) {
      try {
        return {
          signal: AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
          dispose() {},
        }
      } catch {
        const controller = new AbortController()
        const onAbort = () => {
          clearTimeout(timer)
          controller.abort(signal.reason)
        }
        const timer = setTimeout(onAbort, REQUEST_TIMEOUT_MS)
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
        return {
          signal: controller.signal,
          dispose() {
            clearTimeout(timer)
            signal.removeEventListener('abort', onAbort)
          },
        }
      }
    }

    /**
     * 诊断上报队列：同一队列最多一个在途请求；同一 key 的新状态覆盖旧状态；
     * 发送之间保留最小间隔。默认关闭时根本不会创建队列。
     */
    function createReportQueue(path, minIntervalMs, maxPending) {
      const pending = new Map()
      let inflight = null
      let timer
      let lastSentAt = -Infinity

      const flush = () => {
        if (inflight !== null || pending.size === 0) return
        const wait = lastSentAt + minIntervalMs - Date.now()
        if (wait > 0) {
          if (timer === undefined) timer = setTimeout(() => { timer = undefined; flush() }, wait)
          return
        }
        const [key, body] = pending.entries().next().value
        pending.delete(key)
        const controller = new AbortController()
        inflight = { key, controller }
        lastSentAt = Date.now()
        const requestSignal = createRequestSignal(controller.signal)
        void fetch(path, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body), signal: requestSignal.signal,
        }).catch(() => {}).finally(() => {
          requestSignal.dispose()
          if (inflight?.controller === controller) inflight = null
          flush()
        })
      }

      return {
        push(key, body) {
          pending.delete(key)
          pending.set(key, body)
          while (pending.size > maxPending) pending.delete(pending.keys().next().value)
          flush()
        },
        /** 卸载或切换会话时丢掉该会话待发状态，并中止属于它的在途请求。 */
        drop(key) {
          pending.delete(key)
          if (inflight?.key === key) inflight.controller.abort()
        },
      }
    }

    // 模块加载时读取一次开关；切换开关后刷新页面即可生效。
    const diagnosticsOn = diagnosticsEnabled()
    const mountQueue = diagnosticsOn
      ? createReportQueue('/multi-chain/api/client-mounted', MOUNT_REPORT_MIN_INTERVAL_MS, MOUNT_PENDING_LIMIT)
      : null
    const badgeQueue = diagnosticsOn
      ? createReportQueue('/multi-chain/api/badge-rendered', BADGE_REPORT_MIN_INTERVAL_MS, BADGE_PENDING_LIMIT)
      : null

    /** 缺少身份或本会话记录时收起，绝不借用其他会话的数据。 */
    function servedEntryOf(list, sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return null
      return list.find((item) => item?.sessionId === sessionId) ?? null
    }

    /**
     * 诊断测量控制器：所有事件只调用 schedule，由单个 rAF 合并成一次测量；
     * 关闭诊断时不注册观察器、不挂事件、不申请 rAF，也不读取布局。
     */
    function createBadgeDiagnostics(sessionId, node, snapshot) {
      if (badgeQueue === null) return null
      const key = String(sessionId)
      let frame
      let lastSignature = null
      let disposed = false

      const measure = () => {
        if (disposed || !node.isConnected) return
        const rect = node.getBoundingClientRect()
        const style = getComputedStyle(node)
        const inViewport = rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth
        const cssVisible = typeof node.checkVisibility === 'function'
          ? node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
          : true
        const visible = rect.width > 0 && rect.height > 0 && inViewport && cssVisible
        const payload = {
          ...snapshot(), sessionId, stage: 'dom-committed',
          pageVisibility: document.visibilityState,
          rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          display: style.display, visibility: style.visibility, opacity: style.opacity, color: style.color,
          visible,
        }
        const signature = JSON.stringify(payload)
        // 用完整观测值判重，而不是只比较 rect：display/opacity/可见性变化仍要上报。
        if (signature === lastSignature) return
        lastSignature = signature
        badgeQueue.push(key, payload)
      }

      const schedule = () => {
        if (disposed || frame !== undefined) return
        frame = requestAnimationFrame(() => {
          frame = undefined
          measure()
        })
      }

      const observer = new ResizeObserver(schedule)
      observer.observe(node)
      globalThis.addEventListener('resize', schedule)
      document.addEventListener('visibilitychange', schedule)
      schedule()

      return {
        dispose() {
          disposed = true
          if (frame !== undefined) cancelAnimationFrame(frame)
          frame = undefined
          observer.disconnect()
          globalThis.removeEventListener('resize', schedule)
          document.removeEventListener('visibilitychange', schedule)
          badgeQueue.drop(key)
        },
      }
    }

    function ServedBadge({ sessionId } = {}) {
      const [entry, setEntry] = react.useState(null)
      const badgeRef = react.useRef(null)

      // 诊断关闭时不发任何 client-mounted 诊断 POST；开启时也进队列合并。
      react.useEffect(() => {
        if (mountQueue === null) return
        if (typeof sessionId !== 'string' || sessionId === '') return
        const key = 'badge:' + String(sessionId)
        mountQueue.push(key, {
          state: 'component-mounted',
          sessionId,
          userAgent: globalThis.navigator?.userAgent,
        })
        // 卸载/切换会话时删除该会话待发状态，并 abort 属于它的在途请求。
        return () => mountQueue.drop(key)
      }, [sessionId])

      // 核心轮询：串行单在途、会话切换中止旧请求、隐藏页面暂停并恢复立即刷新。
      react.useEffect(() => {
        let disposed = false
        let timer
        let request = null
        let inFlight = false
        let refreshQueued = false
        setEntry(null)
        if (typeof sessionId !== 'string' || sessionId === '') return
        const clearTimer = () => {
          if (timer !== undefined) {
            clearTimeout(timer)
            timer = undefined
          }
        }
        const tick = async () => {
          if (disposed || inFlight) return
          inFlight = true
          request = new AbortController()
          const requestSignal = createRequestSignal(request.signal)
          try {
            const res = await fetch('/multi-chain/api/served', {
              cache: 'no-store',
              signal: requestSignal.signal,
            })
            if (!res.ok) throw new Error('HTTP ' + res.status)
            const data = await res.json()
            if (!disposed) setEntry(servedEntryOf(Array.isArray(data?.served) ? data.served : [], sessionId))
          } catch {
            if (!disposed) setEntry(null)
          } finally {
            requestSignal.dispose()
            inFlight = false
            request = null
            if (!disposed) {
              // 隐藏页面不排下一次轮询；恢复可见时由事件立即补一次。
              if (document.visibilityState === 'hidden') return
              if (refreshQueued) {
                refreshQueued = false
                void tick()
                return
              }
              clearTimer()
              timer = setTimeout(() => {
                timer = undefined
                void tick()
              }, POLL_MS)
            }
          }
        }
        const onVisibilityChange = () => {
          if (disposed) return
          if (document.visibilityState === 'hidden') {
            refreshQueued = false
            clearTimer()
            return
          }
          clearTimer()
          // 已有请求在途时只登记一次补刷，避免并发轮询。
          if (inFlight) {
            refreshQueued = true
            return
          }
          refreshQueued = false
          void tick()
        }
        document.addEventListener('visibilitychange', onVisibilityChange)
        if (document.visibilityState !== 'hidden') void tick()
        return () => {
          disposed = true
          clearTimer()
          document.removeEventListener('visibilitychange', onVisibilityChange)
          request?.abort()
          request = null
        }
      }, [sessionId])

      // 会话切换后的首次渲染仍可能保有旧状态，身份不匹配时立即收起。
      const hit = entry?.sessionId === sessionId ? entry : null
      const label = typeof hit?.provider === 'string' && typeof hit?.model === 'string'
        ? hit.provider + '/' + hit.model : null
      const chain = hit?.chain
      const servedTime = hit?.time

      // DOM 提交后才测量；关闭诊断时这里直接返回，不做任何布局读取。
      react.useEffect(() => {
        const node = badgeRef.current
        if (label === null || node === null) return
        const controller = createBadgeDiagnostics(sessionId, node, () => ({ label, chain, servedTime }))
        return controller === null ? undefined : () => controller.dispose()
      }, [label, chain, sessionId, servedTime])

      if (label === null) return null
      const when = typeof servedTime === 'number' ? new Date(servedTime).toLocaleTimeString('zh-CN', { hour12: false }) : ''
      return react.createElement('span', {
        ref: badgeRef,
        'data-multi-chain-badge': '', 'data-session-id': sessionId,
        title: '多链路由本会话最近打中：' + label + (when === '' ? '' : ' · ' + when),
        style: {
          display: 'inline-flex', alignItems: 'center', gap: 4, flex: '0 0 auto',
          maxWidth: 220, padding: '1px 8px', borderRadius: 9,
          fontSize: 11, lineHeight: '18px',
          background: 'color-mix(in srgb, currentColor 8%, transparent)',
          border: '1px solid color-mix(in srgb, currentColor 18%, transparent)',
          opacity: 0.85, cursor: 'default', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        },
      }, '⛓ ' + label)
    }

    /** 复用同源编辑器，避免嵌入第二套配置模型。 */
    function MultiChainSettings() {
      return react.createElement('section', { 'data-multi-chain-settings': '' },
        react.createElement('p', { style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 13 } }, '配置保存后自动生效；运行记录仅保留本次启动期间的数据。'),
        react.createElement('iframe', { src: '/multi-chain/', title: '多链路由 · 链编辑器',
          style: { width: '100%', height: 'min(72vh, 900px)', minHeight: 420, border: '1px solid var(--dsw-alias-border-l3)', borderRadius: 8 } }))
    }

    // 只等待确定存在的 slots；会话身份由插槽属性提供，不等待全局 sessions。
    const inject = ['slots']
    function apply(ctx) {
      let mountedState = 'inject-called'
      const report = (state) => {
        mountedState = state
        // 本地状态标记零网络开销，不受诊断开关影响，便于排查装载阶段。
        globalThis.__dshMultiChainMounted = state
        if (mountQueue === null) return
        mountQueue.push('apply', { state, userAgent: globalThis.navigator?.userAgent })
      }
      try {
        ctx.slots.inject('conversation.session.header.actions', function* () {
          report('callback-ran')
          yield ctx.slots.register({
            name: 'conversation.session.header.actions', id: 'multi-chain-served', order: -4,
          }, ServedBadge)
          report('registered')
        })
      } catch (error) {
        console.warn('[multi-chain] 会话徽标插槽注册失败：', error)
        report('error: ' + (error instanceof Error ? error.message : String(error)))
      }
      report(mountedState)
      // 设置页为 root 范围列表；仅等待插槽就绪，不添加全局服务依赖。
      ctx.slots.inject('settings.plugins.tab', function* () {
        yield ctx.slots.register({ name: 'settings.plugins.tab', id: 'multi-chain', label: '多链路由', order: 50 }, MultiChainSettings)
      })
      ctx.slots.inject('plugins.bundle.config', function* () {
        yield ctx.slots.register({ name: 'plugins.bundle.config', key: 'dsh-multi-chain' }, MultiChainSettings)
      })
    }
    const exports = { apply, inject }
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    return exports
  },
})
