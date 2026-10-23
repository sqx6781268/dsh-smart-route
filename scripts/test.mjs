// 用当前 Node 依次执行测试，任一失败保留退出码；不依赖系统 shell 的管道行为。
import {spawnSync} from 'node:child_process'
import {fileURLToPath} from 'node:url'
const cwd=fileURLToPath(new URL('../',import.meta.url))
for(const args of [['test/selftest.mjs'],['test/client-selftest.mjs'],['test/todos-selftest.mjs'],['--test','test/release-router.test.mjs','test/release-http.test.mjs','test/release-lifecycle.test.mjs','test/release-network.test.mjs','test/review-followup.test.mjs']]) {
 const result=spawnSync(process.execPath,args,{cwd,stdio:'inherit',timeout:30000})
 if(result.error) {console.error('测试无法完成：',result.error.message);process.exit(1)}
 if(result.status!==0) process.exit(result.status??1)
}
