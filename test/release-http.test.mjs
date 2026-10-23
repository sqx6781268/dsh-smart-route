import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync,writeFileSync,readFileSync,rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { requestRejection } from '../src/http-guard.mjs'
import { createConfigStore } from '../src/config-store.mjs'
import { createWebUiHandler,validateAndSerialize } from '../src/webui.mjs'
const valid={host:'127.0.0.1:8080',origin:'http://127.0.0.1:8080','sec-fetch-site':'same-origin','content-type':'application/json'}
const req=(headers=valid)=>({method:'PUT',headers,socket:{remoteAddress:'127.0.0.1'}})
test('R4 正常本机 Web 和无浏览器来源的本机工具可用',()=>{assert.equal(requestRejection(req()),undefined);assert.equal(requestRejection(req({host:'localhost:8080','content-type':'application/json'})),undefined)})
test('R4 伪造 Host/Origin/跨站/不正确媒体类型均拒绝',()=>{for(const headers of [{...valid,host:'evil.example:8080'},{...valid,origin:'https://evil.example'},{...valid,origin:'null'},{...valid,'sec-fetch-site':'cross-site'},{...valid,'content-type':'text/plain'},{...valid,origin:undefined},{}])assert.ok(requestRejection(req(headers)))})
test('R4 IPv6 和 HTTPS 同源规则',()=>{assert.equal(requestRejection(req({...valid,host:'[::1]:8443',origin:'http://[::1]:8443'})),undefined);const https=req({...valid,origin:'https://127.0.0.1:8080'});https.socket.encrypted=true;assert.equal(requestRejection(https),undefined)})
test('R5 真实文件与 handler 防止旧草稿覆盖，包括外部文件变更',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'multi-chain-revision-'));const file=join(dir,'chains.json');const store=createConfigStore(file,validateAndSerialize)
 try {
 const handler=createWebUiHandler({readChains:()=>{const s=store.snapshot();return {...s,chains:s.configuredChains}},capabilities:()=>({providers:[]}),paths:{chainsFile:file},saveChains:store.save})
 const call=async(method,body,revision,headers={})=>{let status,text;await handler({...req({...valid,...headers,...(revision?{'if-match':revision}:{})}),method,url:'/multi-chain/api/'+(method==='GET'?'state':'chains'),async *[Symbol.asyncIterator](){yield Buffer.from(JSON.stringify(body))}},{writeHead(x){status=x},end(x){text=x}});return {status,body:JSON.parse(text)}}
 const start=await call('GET');assert.equal(start.body.revision,'"missing"')
 const a={chains:[{id:'a',name:'新的名字',models:['p/m']}]};const first=await call('PUT',a,start.body.revision);assert.equal(first.status,200)
 const stale=await call('PUT',{chains:[]},start.body.revision);assert.equal(stale.status,412);assert.equal(store.snapshot().chains[0].name,'新的名字')
 assert.equal((await call('PUT',a)).status,428)
 writeFileSync(file,JSON.stringify({chains:[]}));assert.equal((await call('PUT',a,first.body.revision)).status,412)
 const revision=store.snapshot().revision;assert.equal((await call('PUT',a,revision)).status,200)
 const bytes=readFileSync(file,'utf8');assert.equal((await call('PUT',{chains:[]},store.snapshot().revision,{origin:'https://evil.example'})).status,403);assert.equal(readFileSync(file,'utf8'),bytes)
 } finally {rmSync(dir,{recursive:true,force:true})}
})
