// 生成 Tabbit 可执行脚本，路径在本机生成，不写入发行源码；测试全程拦截自身页面请求。
import {readFileSync,writeFileSync} from 'node:fs'
import {pathToFileURL,fileURLToPath} from 'node:url'
import {resolve} from 'node:path'
const root=new URL('../',import.meta.url)
const output=process.argv[2]
if(!output){console.log('用法：npm run test:browser -- <输出脚本路径> [当前宿主URL]\n然后用 tabbit-cli nodejs --task 多链发布回归 --request-id 独立请求ID < 输出脚本路径。\n脚本只使用任务自建页面与测试内存，不访问用户配置；需已安装 Tabbit。');process.exit(0)}
const origin=new URL(process.argv[3]??'http://127.0.0.1:18080').origin
if(!['127.0.0.1','localhost','[::1]'].includes(new URL(origin).hostname))throw new Error('测试 URL 必须为本机')
const script=`globalThis.testRootURL=${JSON.stringify(root.href)};\nglobalThis.testOrigin=${JSON.stringify(origin)};\n`+readFileSync(new URL('../test/browser-editor.cjs',import.meta.url),'utf8')
writeFileSync(resolve(output),script,{encoding:'utf8',flag:'wx'})
console.log('已生成隔离浏览器回归脚本：'+fileURLToPath(pathToFileURL(resolve(output))))
