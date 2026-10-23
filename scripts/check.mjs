// 检查公开清单、JS/内嵌脚本语法、语言资源和用户文档中的本地链接。
import {readFileSync,readdirSync,existsSync} from 'node:fs'
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
import {resolve} from 'node:path'
import vm from 'node:vm'
import assert from 'node:assert/strict'
assert.ok(Number(process.versions.node.split('.')[0]) >= 24, '请使用 Node.js 24 或更新版本（桌面版可用宿主自带 Node）')
const root=fileURLToPath(new URL('../',import.meta.url))
const pkg=JSON.parse(readFileSync(resolve(root,'package.json'),'utf8'))
assert.equal(pkg.name,'dsh-multi-chain');assert.equal(pkg.license,'MIT');assert.equal(pkg.engines.dsh,'0.2.1-rc.2')
for(const path of pkg.files) assert.ok(existsSync(resolve(root,path)),'打包路径不存在：'+path)
for(const dir of ['src','lib','scripts'])for(const name of readdirSync(resolve(root,dir)))if(/\.(mjs|js)$/.test(name)) {
 const result=spawnSync(process.execPath,['--check',resolve(root,dir,name)],{encoding:'utf8'})
 assert.equal(result.status,0,result.stderr)
}
const html=readFileSync(resolve(root,'src/editor.html'),'utf8')
new vm.Script(html.match(/<script>([\s\S]*?)<\/script>/)[1])
for(const path of ['locale/en.json','locale/zh.json','examples/chains.json','src/chains.schema.json']) JSON.parse(readFileSync(resolve(root,path),'utf8'))
assert.equal(JSON.parse(readFileSync(resolve(root,'locale/zh.json'),'utf8')).meta.title,'多链路由')
for(const file of ['README.md','CONTRIBUTING.md','SECURITY.md']) {
 const text=readFileSync(resolve(root,file),'utf8')
 for(const match of text.matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/g))if(!/^(https?:|mailto:)/.test(match[1]))assert.ok(existsSync(resolve(root,match[1])),'文档链接不存在：'+match[1])
 assert.ok(!/[A-Z]:[\\/](?:Users|[^\s]+[\\/]02-)|127\.0\.0\.1:3438/i.test(text),'公开文档含本机绝对路径或测试端口')
}
console.log('发布清单、脚本语法、示例、语言与文档链接检查通过。')
