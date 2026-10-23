// 使用临时回环 HTTP 服务器验证浏览器同源请求形态，不连接实际宿主。
import {test} from 'node:test'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {createWebUiHandler} from '../src/webui.mjs'
test('R4/R5 真实 HTTP 同源读取写入与异源拒绝',async()=>{
 let revision='"1"',saved=0
 const handler=createWebUiHandler({readChains:()=>({version:1,revision,chains:[],policy:{},errors:[]}),capabilities:()=>({providers:[]}),paths:{chainsFile:'isolated'},saveChains(raw,expected){if(expected!==revision)throw Object.assign(new Error('冲突'),{statusCode:412});saved++;revision='"2"';return {chains:raw.chains,errors:[],revision}}})
 const server=createServer((req,res)=>{handler(req,res).catch(error=>{res.writeHead(500);res.end(error.message)})})
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)})
 try {
 const origin='http://127.0.0.1:'+server.address().port
 const state=await fetch(origin+'/multi-chain/api/state',{signal:AbortSignal.timeout(10000)})
 assert.equal(state.status,200);assert.equal((await state.json()).revision,'"1"')
 const body=JSON.stringify({chains:[]})
 const headers={origin,'sec-fetch-site':'same-origin','content-type':'application/json','if-match':'"1"'}
 const put=await fetch(origin+'/multi-chain/api/chains',{method:'PUT',headers,body,signal:AbortSignal.timeout(10000)})
 assert.equal(put.status,200);assert.equal((await put.json()).revision,'"2"');assert.equal(saved,1)
 const stale=await fetch(origin+'/multi-chain/api/chains',{method:'PUT',headers,body,signal:AbortSignal.timeout(10000)})
 assert.equal(stale.status,412);assert.equal(saved,1)
 const hostile=await fetch(origin+'/multi-chain/api/chains',{method:'PUT',headers:{...headers,origin:'https://evil.example'},body,signal:AbortSignal.timeout(10000)})
 assert.equal(hostile.status,403);assert.equal(saved,1)
 } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
})
