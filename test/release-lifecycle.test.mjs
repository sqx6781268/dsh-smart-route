import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,existsSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
test('R10 停用时清理定时器，进行中的探针不得写文件',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'multi-chain-dispose-'));const previous=process.env.DSH_MULTI_CHAIN_DIR;process.env.DSH_MULTI_CHAIN_DIR=dir
 const dispose=[];let resolveModels,handler
 try {
 const pending=new Promise(resolve=>{resolveModels=resolve})
 const {apply}=await import(new URL('../src/index.mjs?dispose='+Date.now(),import.meta.url))
 apply({llm:{registerAdapter(){return ()=>{}},listProviders:()=>[{id:'test',name:'test'}],listModels:()=>pending},logger:()=>({info(){},warn(){}}),effect(fn){const value=fn();if(value)dispose.push(value)},webServer:{register(value){handler=value.handler;return ()=>{}}}}, {})
 assert.equal(typeof handler,'function')
 dispose.reverse().forEach(fn=>fn())
 resolveModels([])
 await new Promise(resolve=>setImmediate(resolve))
 assert.equal(existsSync(join(dir,'capabilities.json')),false)
 } finally {if(previous===undefined)delete process.env.DSH_MULTI_CHAIN_DIR;else process.env.DSH_MULTI_CHAIN_DIR=previous;rmSync(dir,{recursive:true,force:true})}
})
