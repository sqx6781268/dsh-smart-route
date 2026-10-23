/**
 * 多链路由浏览器半身：头部显示本会话最近实际打中的成员。
 * 宿主 ModuleLoader 装配模块；会话插槽通过 props 注入权威 sessionId。
 * 不写自定义会话事件，轮询服务端进程内记录；失败时收起徽标。
 */
window.__ModuleLoader__.load({
  id: 'dsh-multi-chain',
  factory: (require) => {
    const react = require('react')
    const POLL_MS = 4000

    /** 缺少身份或本会话记录时收起，绝不借用其他会话的数据。 */
    function servedEntryOf(list, sessionId) {
      if (typeof sessionId !== 'string' || sessionId === '') return null
      return list.find((item) => item?.sessionId === sessionId) ?? null
    }

    function ServedBadge({ sessionId } = {}) {
      const [entry, setEntry] = react.useState(null)
      const badgeRef = react.useRef(null)

      react.useEffect(() => {
        void fetch('/multi-chain/api/client-mounted', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ state: 'component-mounted', sessionId, userAgent: globalThis.navigator?.userAgent }),
          signal: AbortSignal.timeout(10000),
        }).catch(() => {})
      }, [sessionId])

      react.useEffect(() => {
        let disposed = false
        let timer
        let request
        setEntry(null)
        if (typeof sessionId !== 'string' || sessionId === '') return
        const tick = async () => {
          request = new AbortController()
          try {
            const res = await fetch('/multi-chain/api/served', {
              cache: 'no-store',
              signal: AbortSignal.any([request.signal, AbortSignal.timeout(10000)]),
            })
            if (!res.ok) throw new Error('HTTP ' + res.status)
            const data = await res.json()
            if (!disposed) setEntry(servedEntryOf(Array.isArray(data?.served) ? data.served : [], sessionId))
          } catch {
            if (!disposed) setEntry(null)
          } finally {
            if (!disposed) timer = setTimeout(tick, POLL_MS)
          }
        }
        void tick()
        return () => {
          disposed = true
          request?.abort()
          if (timer !== undefined) clearTimeout(timer)
        }
      }, [sessionId])

      // 会话切换后的首次渲染仍可能保有旧状态，身份不匹配时立即收起。
      const hit = entry?.sessionId === sessionId ? entry : null
      const label = typeof hit?.provider === 'string' && typeof hit?.model === 'string'
        ? hit.provider + '/' + hit.model : null
      const chain = hit?.chain
      const servedTime = hit?.time

      // DOM 提交后才读 ref 和布局；可见性读数仍需结合真实截图判断遮挡。
      react.useEffect(() => {
        const node = badgeRef.current
        if (label === null || node === null) return
        let previous
        const measure = () => {
          if (!node.isConnected) return
          const rect = node.getBoundingClientRect()
          const style = getComputedStyle(node)
          const inViewport = rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth
          const visible = rect.width > 0 && rect.height > 0 && inViewport && node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
          const payload = {
            label, chain, sessionId, servedTime, stage: 'dom-committed',
            pageVisibility: document.visibilityState,
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            display: style.display, visibility: style.visibility, opacity: style.opacity, color: style.color,
            visible,
          }
          const signature = JSON.stringify(payload)
          if (signature === previous) return
          previous = signature
          void fetch('/multi-chain/api/badge-rendered', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: signature, signal: AbortSignal.timeout(10000),
          }).catch(() => {})
        }
        const frame = requestAnimationFrame(measure)
        const observer = new ResizeObserver(measure)
        observer.observe(node)
        globalThis.addEventListener('resize', measure)
        document.addEventListener('visibilitychange', measure)
        return () => {
          cancelAnimationFrame(frame)
          observer.disconnect()
          globalThis.removeEventListener('resize', measure)
          document.removeEventListener('visibilitychange', measure)
        }
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
        globalThis.__dshMultiChainMounted = state
        void fetch('/multi-chain/api/client-mounted', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ state, userAgent: globalThis.navigator?.userAgent }),
          signal: AbortSignal.timeout(10000),
        }).catch(() => {})
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
