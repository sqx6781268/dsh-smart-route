// 将实际 tarball 安装到全新临时目录，检查包导出和无宿主导入的运行入口；不修改用户 profile。
import {mkdtempSync,writeFileSync,readFileSync,rmSync,existsSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {spawnSync} from 'node:child_process'
import assert from 'node:assert/strict'
const artifact=process.argv[2]
if(!artifact)throw new Error('用法：node scripts/install-smoke.mjs <tarball完整路径>，由 npm run release:prepare 自动传入 npm CLI')
const npmCLI=process.env.npm_execpath
if(!npmCLI)throw new Error('需要 npm_execpath 指向当前 npm CLI')
const expectedVersion=JSON.parse(readFileSync(new URL('../package.json',import.meta.url),'utf8')).version
const dir=mkdtempSync(join(tmpdir(),'multi-chain-install-'))
try {
 writeFileSync(join(dir,'package.json'),JSON.stringify({name:'isolated-plugin-install',version:'1.0.0',private:true}))
 const install=spawnSync(process.execPath,[npmCLI,'install','--offline','--ignore-scripts','--no-audit','--no-fund',resolve(artifact)],{cwd:dir,encoding:'utf8',timeout:60000})
 assert.equal(install.status,0,install.stderr||install.stdout)
 const require=createRequire(join(dir,'package.json'))
 const pkg=require('dsh-multi-chain/package.json')
 assert.equal(pkg.name,'dsh-multi-chain');assert.equal(pkg.version,expectedVersion)
 assert.equal(require('dsh-multi-chain/locale/zh.json').meta.title,'多链路由')
 assert.ok(require.resolve('dsh-multi-chain/client'))
 const entry=await import(pathToFileURL(require.resolve('dsh-multi-chain')).href)
 assert.equal(typeof entry.apply,'function')
 const installed=join(dir,'node_modules','dsh-multi-chain')
 for(const path of ['LICENSE','README.md','THIRD_PARTY_NOTICES.md','src/editor.html','src/chains.schema.json','cordis.patch.yml'])assert.ok(existsSync(join(installed,path)),path+' 未进入安装包')
 assert.ok(!existsSync(join(installed,'reference-smart-route')))
 const {createWebUiHandler}=await import(pathToFileURL(join(installed,'src/webui.mjs')).href)
 let code,html
 await createWebUiHandler({})({method:'GET',url:'/multi-chain/',headers:{host:'127.0.0.1:8080'},socket:{remoteAddress:'127.0.0.1'}},{writeHead(value){code=value},end(value){html=value}})
 assert.equal(code,200);assert.ok(html.includes('多链路由 · 链编辑器'))
 console.log('实际 tarball 离线干净安装通过：包导出、入口、语言、编辑器、Schema 和许可证齐全。')
} finally {rmSync(dir,{recursive:true,force:true})}
