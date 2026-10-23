// 只读复核后的回归：文件清理、跨 provider 能力回环、思考暂存、超限响应与探针预算。
import {test} from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import {syncBuiltinESMExports} from 'node:module'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createServer} from 'node:http'
import {createConfigStore} from '../src/config-store.mjs'
import {validateAndSerialize,createWebUiHandler} from '../src/webui.mjs'
import {MultiChainAdapter,finishAborted,exceptionFinish} from '../src/adapter.mjs'
import {normalizeDocument} from '../src/chains.mjs'

test('F0 所有取消终态满足宿主failure消费契约',async()=>{
 const consume=finish=>{assert.equal(finish.reason.kind,'aborted');assert.equal(finish.reason.failure.code,'ABORTED');assert.equal(typeof finish.reason.failure.message,'string');assert.ok(finish.reason.failure.message.length>0);return new Error(finish.reason.failure.message)}
 consume(finishAborted());consume(exceptionFinish(new DOMException('下游中止','AbortError')))
 const doc=normalizeDocument({chains:[{id:'a',models:['p/m']}]}),make=stream=>new MultiChainAdapter({chains:()=>doc.chains,policy:()=>doc.policy,llm:()=>({stream})})
 for(const stream of [async function*(){throw new DOMException('下游中止','AbortError')},async function*(){yield {type:'finish',reason:{kind:'aborted'}}},async function*(){yield {type:'text-delta',text:'部分回答'};throw new DOMException('下游中止','AbortError')}]){
   const chunks=[];for await(const chunk of make(stream).stream({model:'a'}))chunks.push(chunk);consume(chunks.at(-1))
 }
 const controller=new AbortController();controller.abort();const chunks=[];for await(const chunk of make(async function*(){assert.fail('不可调用')}).stream({model:'a',signal:controller.signal}))chunks.push(chunk);consume(chunks.at(-1))
})
test('F1 锁被外部清理不掩盖成功保存',()=>{
 const dir=fs.mkdtempSync(join(tmpdir(),'chain-cleanup-')), file=join(dir,'chains.json')
 const original=fs.renameSync
 fs.renameSync=(...args)=>{original(...args);fs.unlinkSync(file+'.lock')};syncBuiltinESMExports()
 try {const store=createConfigStore(file,validateAndSerialize);const saved=store.save({chains:[]},'"missing"');assert.notEqual(saved.revision,'"missing"');assert.deepEqual(JSON.parse(fs.readFileSync(file,'utf8')).chains,[])}
 finally {fs.renameSync=original;syncBuiltinESMExports();fs.rmSync(dir,{recursive:true,force:true})}
})
test('F2 异步虚拟 provider 能力回环产生可诊断错误',async()=>{
 let adapter,calls=0
 const chains=normalizeDocument({chains:[{id:'a',models:['Virtual/back']}]}).chains
 adapter=new MultiChainAdapter({chains:()=>chains,llm:()=>({async resolveModelInfo(){calls++;await Promise.resolve();return adapter.resolveModel('MultiChain','a')}})})
 await assert.rejects(adapter.resolveModel('MultiChain','a'),{code:'MULTI_CHAIN_CAPABILITY_CYCLE'})
 assert.equal(calls,1)
})
test('F2 并发独立能力解析互不误判为回环',async()=>{
 const chains=normalizeDocument({chains:[{id:'a',models:['p/m']}]}).chains
 const adapter=new MultiChainAdapter({chains:()=>chains,llm:()=>({async resolveModelInfo(){await Promise.resolve();return {inputModalities:['text','image']}}})})
 const results=await Promise.all([adapter.resolveModel('MultiChain','a'),adapter.resolveModel('MultiChain','a')]);assert.equal(results.length,2);assert.deepEqual(results[0].inputModalities,['text','image'])
 assert.equal(Object.hasOwn((await adapter.listModels('MultiChain'))[0],'inputModalities'),false)
})
test('F3 reasoning 在首个答案前暂存，失败成员内容不交付',async()=>{
 const doc=normalizeDocument({chains:[{id:'a',models:['p/m','q/n']}]}),reason={type:'reasoning-delta',index:0,text:'暂存思考'},text={type:'text-delta',index:1,text:'答案'}
 let release
 const gate=new Promise(resolve=>{release=resolve})
 const adapter=new MultiChainAdapter({chains:()=>doc.chains,policy:()=>doc.policy,llm:()=>({async *stream({provider}){yield reason;if(provider==='p'){yield {type:'finish',reason:{kind:'error',failure:{code:'SERVER'}}};return}await gate;yield text;yield {type:'finish',reason:{kind:'stop'}}}})})
 const iterator=adapter.stream({model:'a'})[Symbol.asyncIterator]();let received=false
 const first=iterator.next().then(value=>{received=true;return value})
 await new Promise(resolve=>setImmediate(resolve));assert.equal(received,false)
 release();assert.deepEqual((await first).value,reason)
 const rest=[];for await(const item of {[Symbol.asyncIterator]:()=>iterator})rest.push(item)
 assert.equal(rest.filter(item=>item.type==='reasoning-delta').length,0);assert.equal(rest[0].text,'答案')
})
test('F4 真实 HTTP 大请求返回413及原因，不调用保存且服务继续可用',async()=>{
 let saved=0
 const handler=createWebUiHandler({saveChains(){saved++;return {chains:[]}}})
 const server=createServer((req,res)=>{handler(req,res).catch(error=>{res.writeHead(500);res.end(error.message)})})
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)})
 try {
 const origin='http://127.0.0.1:'+server.address().port
 const response=await fetch(origin+'/multi-chain/api/chains',{method:'PUT',headers:{origin,'content-type':'application/json','if-match':'"x"'},body:JSON.stringify({padding:'x'.repeat(70000)}),signal:AbortSignal.timeout(10000)})
 assert.equal(response.status,413);assert.match((await response.json()).error,/64 KiB/);assert.equal(saved,0)
 const diagnostic=await fetch(origin+'/multi-chain/api/client-mounted',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({padding:'x'.repeat(9000)}),signal:AbortSignal.timeout(10000)})
 assert.equal(diagnostic.status,413)
 assert.equal((await fetch(origin+'/multi-chain/',{signal:AbortSignal.timeout(10000)})).status,200)
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
})
test('F6 探针超过500模型明确截断且不把后续渠道伪装成空目录',async()=>{
 const dir=fs.mkdtempSync(join(tmpdir(),'chain-probe-limit-')),previous=process.env.DSH_MULTI_CHAIN_DIR;process.env.DSH_MULTI_CHAIN_DIR=dir
 const disposers=[];const listed=[]
 try{
 const {apply}=await import(new URL('../src/index.mjs?limit='+Date.now(),import.meta.url))
 apply({llm:{registerAdapter(){return ()=>{}},listProviders:()=>[{id:'p'},{id:'q'}],async listModels(id){listed.push(id);return Array.from({length:501},(_,i)=>({id:'m'+i}))},async resolveModelInfo(){return {inputModalities:['text']}}},logger:()=>({info(){},warn(){}}),effect(fn){const off=fn();if(off)disposers.push(off)},webServer:{register(){return ()=>{}}}}, {})
 for(let i=0;i<8&&!fs.existsSync(join(dir,'capabilities.json'));i++)await new Promise(resolve=>setImmediate(resolve))
 const report=JSON.parse(fs.readFileSync(join(dir,'capabilities.json'),'utf8'))
 assert.equal(report.truncated,true);assert.equal(report.modelLimit,500);assert.deepEqual(listed,['p']);assert.equal(report.providers.length,1);assert.equal(report.providers[0].models.length,500)
 }finally{disposers.reverse().forEach(fn=>fn());if(previous===undefined)delete process.env.DSH_MULTI_CHAIN_DIR;else process.env.DSH_MULTI_CHAIN_DIR=previous;fs.rmSync(dir,{recursive:true,force:true})}
})
