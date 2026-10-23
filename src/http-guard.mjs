/** 本机 HTTP 边界：不信任代理头；仅接收回环 Host 与同源浏览器来源。 */
export function requestRejection(req) {
  const headers = req.headers ?? {}
  const host = headers.host
  let target
  try {
    if (typeof host !== 'string' || /[\s/@?#\\]/.test(host)) return '缺少或无效的 Host'
    target = new URL('http://' + host)
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) || target.pathname !== '/') return '仅允许本机 Host'
  } catch { return '无效的 Host' }
  const site = headers['sec-fetch-site']
  if (site !== undefined && !['same-origin', 'none'].includes(site)) return '拒绝跨站请求'
  const origin = headers.origin
  if (origin !== undefined) {
    try {
      const value = new URL(origin)
      const protocol = req.socket?.encrypted ? 'https:' : 'http:'
      if (value.origin === 'null' || origin !== value.origin || value.host !== target.host || value.protocol !== protocol) return '请求来源不匹配'
    } catch { return '无效的 Origin' }
  } else if (site === 'same-origin' && !['GET','HEAD'].includes(req.method)) {
    return '浏览器写入缺少 Origin'
  }
  // 无 Origin/Fetch Metadata 的本机工具可访问；不是面向公网的认证服务。
  if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
    if (typeof headers['content-type'] !== 'string' || headers['content-type'].split(';')[0].trim().toLowerCase() !== 'application/json') return '写入必须使用 application/json'
  }
}
