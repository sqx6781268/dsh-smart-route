// 通过明确清单导出公开源码并实际打包；不推送、不调用 npm publish。
import {cpSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync,existsSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {fileURLToPath} from 'node:url'
import {spawnSync} from 'node:child_process'
import {createHash} from 'node:crypto'
const root=fileURLToPath(new URL('../',import.meta.url))
const pkg=JSON.parse(readFileSync(join(root,'package.json'),'utf8'))
const output=resolve(process.argv[2]??join(root,'release',pkg.version+'-'+Date.now()))
if(existsSync(output))throw new Error('输出目录已存在，为避免覆盖请换路径')
function run(command,args,cwd){const result=spawnSync(command,args,{cwd,encoding:'utf8',timeout:120000});if(result.status!==0)throw new Error((result.stderr||result.stdout||'命令失败')+'\n'+String(result.error??''));return result.stdout}
run(process.execPath,['scripts/check.mjs'],root)
run(process.execPath,['scripts/test.mjs'],root)
mkdirSync(output,{recursive:true})
const source=join(output,'source');mkdirSync(source)
const files=['package.json','cordis.patch.yml','README.md','LICENSE','THIRD_PARTY_NOTICES.md','CHANGELOG.md','CONTRIBUTING.md','SECURITY.md','.gitignore','.github','src','lib','locale','test','scripts','examples']
for(const path of files)cpSync(join(root,path),join(source,path),{recursive:true})
mkdirSync(join(source,'docs'))
for(const doc of ['配置说明.md','发布验收说明.md'])cpSync(join(root,'docs',doc),join(source,'docs',doc))
run(process.execPath,['scripts/check.mjs'],source)
run(process.execPath,['scripts/test.mjs'],source)
const npmCLI=process.env.npm_execpath
if(!npmCLI)throw new Error('请通过 npm run release:prepare 执行，以使用当前 npm CLI')
const packed=JSON.parse(run(process.execPath,[npmCLI,'pack','--json','--ignore-scripts','--pack-destination',output],source))[0]
const tarball=join(output,packed.filename)
run(process.execPath,['scripts/install-smoke.mjs',tarball],source)
const sha256=createHash('sha256').update(readFileSync(tarball)).digest('hex')
writeFileSync(join(output,'SHA256SUMS'),sha256+'  '+packed.filename+'\n')
const report={version:pkg.version,node:process.version,source,tarball,sha256,files:packed.files.map(item=>item.path),note:'本流程验证干净源码、全部离线测试与tarball安装；宿主/浏览器验收结果另见发布验收说明，不自动宣称通过。未推送或发布。'}
writeFileSync(join(output,'release-report.json'),JSON.stringify(report,null,2)+'\n')
console.log(JSON.stringify(report,null,2))
