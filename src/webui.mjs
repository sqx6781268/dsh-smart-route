/** 多链路由 HTTP 接口：编辑器、配置版本、运行状态及徽标诊断。 */
import { readFileSync } from 'node:fs'
import { requestRejection } from './http-guard.mjs'
import { CONFIG_VERSION, normalizeDocument } from './chains.mjs'
const editorFile = new URL('./editor.html', import.meta.url)
const schemaFile = new URL('./chains.schema.json', import.meta.url)

/** 插件路由自行限制本机访问，不依赖宿主 SPA 的登录状态。 */
export function isLoopbackRequest(request) {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket?.remoteAddress)
}
const BODY_TOO_LARGE = Symbol('body-too-large')
async function readJsonBody(req, maxBytes = 64 * 1024) {
  const chunks = []
  let size = 0
  // 手动读取迭代器：超限时不能调用 iterator.return()，否则 IncomingMessage 会销毁连接。
  const iterator = req[Symbol.asyncIterator]()
  while (true) {
    const next = await iterator.next()
    if (next.done) break
    const chunk = next.value
    size += chunk.length
    if (size > maxBytes) { req.resume?.(); return BODY_TOO_LARGE }
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch { return null }
}
function writeJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
  res.end(JSON.stringify(body))
}
/** 依赖通过入口注入；HTTP 层不直接改配置文件或发模型请求。 */
export function createWebUiHandler(deps) {
  return async function handler(req, res) {
    if (!isLoopbackRequest(req)) { writeJson(res, 403, { ok: false, error: '仅允许本机访问' }); return }
    const rejection = requestRejection(req)
    if (rejection) { writeJson(res, 403, { ok: false, error: rejection }); return }
    const url = new URL(req.url ?? '/', 'http://x')
    const path = url.pathname
    if ((path === '/multi-chain' || path === '/multi-chain/') && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      res.end(readFileSync(editorFile, 'utf8')); return
    }
    if (path === '/multi-chain/chains.schema.json' && req.method === 'GET') {
      writeJson(res, 200, JSON.parse(readFileSync(schemaFile, 'utf8'))); return
    }
    if (path === '/multi-chain/api/state' && req.method === 'GET') {
      const current = deps.readChains()
      writeJson(res, 200, { ok: true, revision: current.revision, version: current.version ?? CONFIG_VERSION, $schema: current.$schema,
        chains: current.chains, policy: current.policy, errors: current.errors,
        capabilities: deps.capabilities(), chainsFile: deps.paths.chainsFile, capabilitiesFile: deps.paths.capabilitiesFile })
      return
    }
    if (path === '/multi-chain/api/status' && req.method === 'GET') {
      if (!deps.runtimeStatus) { writeJson(res, 503, { ok: false, error: '运行状态暂不可用' }); return }
      writeJson(res, 200, { ok: true, ...deps.runtimeStatus() }); return
    }
    if (path === '/multi-chain/api/chains' && req.method === 'PUT') {
      const body = await readJsonBody(req)
      if (body === BODY_TOO_LARGE) { writeJson(res, 413, { ok: false, error: '请求体超过 64 KiB，请减少链或成员数量' }); return }
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        writeJson(res, 400, { ok: false, error: '请求体必须是 JSON 对象' }); return
      }
      try {
        const expected = req.headers?.['if-match']
        if (typeof expected !== 'string') { writeJson(res, 428, { ok: false, error: '缺少配置修订号，请重新加载' }); return }
        const result = deps.saveChains(body, expected)
        writeJson(res, 200, { ok: true, revision: result.revision, chains: result.chains.length, errors: result.errors })
      } catch (error) { writeJson(res, [409,412,428].includes(error.statusCode) ? error.statusCode : 400, { ok: false, error: error instanceof Error ? error.message : String(error) }) }
      return
    }
    if (path === '/multi-chain/api/served' && req.method === 'GET') {
      writeJson(res, 200, { ok: true, served: deps.recentServed?.(256) ?? [] }); return
    }
    if (path === '/multi-chain/api/client-mounted' && req.method === 'POST') {
      const body = await readJsonBody(req, 8 * 1024)
      if (body === BODY_TOO_LARGE) { writeJson(res, 413, { ok: false, error: '诊断请求体超过 8 KiB' }); return }
      if (body !== null && typeof body === 'object') deps.reportClientMounted?.({
        state: typeof body.state === 'string' ? body.state.slice(0, 120) : 'unknown',
        sessionId: typeof body.sessionId === 'string' ? body.sessionId.slice(0, 120) : undefined,
        userAgent: typeof body.userAgent === 'string' ? body.userAgent.slice(0, 200) : undefined, time: Date.now(),
      })
      writeJson(res, 200, { ok: true }); return
    }
    if (path === '/multi-chain/api/badge-rendered' && req.method === 'POST') {
      // 旧上报只证明渲染分支；新版由 DOM 提交后的 ref 测量。
      const body = await readJsonBody(req, 8 * 1024)
      if (body === BODY_TOO_LARGE) { writeJson(res, 413, { ok: false, error: '诊断请求体超过 8 KiB' }); return }
      if (body !== null && typeof body === 'object') deps.reportBadgeRendered?.({
        label: typeof body.label === 'string' ? body.label.slice(0, 120) : 'unknown',
        chain: typeof body.chain === 'string' ? body.chain.slice(0, 60) : undefined,
        sessionId: typeof body.sessionId === 'string' ? body.sessionId.slice(0, 120) : undefined,
        servedTime: Number.isFinite(body.servedTime) ? body.servedTime : undefined,
        stage: body.stage === 'dom-committed' ? 'dom-committed' : 'render-branch',
        visible: typeof body.visible === 'boolean' ? body.visible : undefined,
        pageVisibility: typeof body.pageVisibility === 'string' ? body.pageVisibility.slice(0, 20) : undefined,
        rect: body.rect && ['x', 'y', 'width', 'height'].every((key) => Number.isFinite(body.rect[key]))
          ? Object.fromEntries(['x', 'y', 'width', 'height'].map((key) => [key, body.rect[key]])) : undefined,
        ...Object.fromEntries(['display', 'visibility', 'opacity', 'color'].map((key) => [key,
          typeof body[key] === 'string' ? body[key].slice(0, 120) : undefined])), time: Date.now(),
      })
      writeJson(res, 200, { ok: true }); return
    }
    if (path === '/multi-chain/api/debug' && req.method === 'GET') {
      writeJson(res, 200, { ok: true, clientModules: deps.debugClientModules?.() ?? { available: false },
        clientMounted: deps.clientMounted?.() ?? null, badgeRendered: deps.badgeRendered?.() ?? null }); return
    }
    writeJson(res, 404, { ok: false, error: '未知路径' })
  }
}
/** 保存时拒绝会导致静默丢失的输入；停用链保留在配置，只有路由侧过滤。 */
export function validateAndSerialize(chainsFile, raw, describe = normalizeDocument) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('配置必须是对象：{ policy, chains }')
  const doc = describe(raw)
  if (doc.errors.length > 0) throw new Error('配置有误：' + doc.errors.join('；'))
  const configured = doc.configuredChains ?? doc.chains
  for (const [i, chain] of raw.chains.entries()) {
    if (!Array.isArray(chain.models) || configured[i]?.models.length !== chain.models.length) throw new Error(`第 ${i + 1} 条链含无效或重复成员，请修正后保存`)
  }
  if (raw.$schema !== undefined && typeof raw.$schema !== 'string') throw new Error('$schema 必须是字符串')
  return JSON.stringify({ ...(doc.$schema === undefined ? {} : { $schema: doc.$schema }), version: CONFIG_VERSION,
    policy: doc.policy, chains: configured }, null, 2) + '\n'
}
