/** 文件原文修订号用于并发比较；锁协调多个插件进程，临时文件原子替换。 */
import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, mkdirSync, writeFileSync, renameSync, unlinkSync, openSync, closeSync } from 'node:fs'
import { dirname } from 'node:path'
import { CONFIG_VERSION, DEFAULT_POLICY, normalizeDocument } from './chains.mjs'
export function conflict(message, statusCode = 412) { return Object.assign(new Error(message), { statusCode }) }
export function createConfigStore(file, serialize) {
  const snapshot = () => {
    let bytes
    try { bytes = readFileSync(file) } catch (error) {
      if (error.code !== 'ENOENT') throw error
      return { version: CONFIG_VERSION, chains: [], configuredChains: [], policy: { ...DEFAULT_POLICY }, errors: [], missing: true, revision: '"missing"' }
    }
    const revision = '"' + createHash('sha256').update(bytes).digest('hex') + '"'
    try { return { ...normalizeDocument(JSON.parse(bytes.toString('utf8'))), revision } }
    catch (error) { return { version: CONFIG_VERSION, chains: [], configuredChains: [], policy: { ...DEFAULT_POLICY }, errors: ['配置 JSON 无法解析：' + error.message], revision } }
  }
  const save = (raw, expectedRevision) => {
    if (typeof expectedRevision !== 'string') throw conflict('缺少配置修订号，请重新加载后保存', 428)
    const text = serialize(file, raw)
    mkdirSync(dirname(file), { recursive: true })
    const lock = file + '.lock'
    let fd
    try { fd = openSync(lock, 'wx', 0o600) } catch (error) {
      if (error.code === 'EEXIST') throw conflict('配置正在被其他进程保存，请稍后重试', 409)
      throw error
    }
    const temp = file + '.' + randomUUID() + '.tmp'
    try {
      if (snapshot().revision !== expectedRevision) throw conflict('配置已在另一页面或文件中更新，请保留草稿并重新加载后整理')
      writeFileSync(temp, text, { encoding: 'utf8', mode: 0o600 })
      if (snapshot().revision !== expectedRevision) throw conflict('配置文件在保存期间发生变更，请重新加载')
      renameSync(temp, file)
      return snapshot()
    } finally {
      try { unlinkSync(temp) } catch { /* 尚未创建或已重命名 */ }
      // 清理不能覆盖已成功落盘的返回值，或掩盖最初的保存错误。
      try { closeSync(fd) } catch { /* 文件描述符已被外部释放 */ }
      try { unlinkSync(lock) } catch { /* 外部已清理或暂时不可删除，不能误报保存失败 */ }
    }
  }
  return { snapshot, save }
}
