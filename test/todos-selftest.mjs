/** 配置版本、停用链保存与真实适配器观察链路回归；只写独立临时目录。 */
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeDocument, normalizePolicy, resetCooldown } from '../src/chains.mjs'
import { validateAndSerialize, createWebUiHandler } from '../src/webui.mjs'
let passed = 0
const check = (label, run) => { run(); passed++; console.log('✓ ' + label) }
const config = { chains: [{ id:'active', name:'启用链', models:['a/x','b/y'] }, { id:'disabled', enabled:false, models:['b/y'] }] }
const normalized = normalizeDocument(config)
check('旧格式无 version 按 1 读取', () => assert.equal(normalized.version,1))
check('路由过滤停用链，配置仍保留', () => { assert.equal(normalized.chains.length,1); assert.equal(normalized.configuredChains.length,2) })
const saved = JSON.parse(validateAndSerialize('unused', {...config,$schema:'./chains.schema.json'}))
check('保存写版本并保留停用链和 schema', () => { assert.equal(saved.version,1); assert.equal(saved.chains[1].enabled,false); assert.equal(saved.$schema,'./chains.schema.json') })
check('未知版本不能被降级重写', () => assert.throws(() => validateAndSerialize('unused',{...config,version:2}),/不支持配置版本/))
check('显式 null 版本不能冒充旧格式', () => assert.throws(() => validateAndSerialize('unused',{...config,version:null}),/不支持配置版本/))
check('缺少 chains 拒绝写盘', () => assert.throws(() => validateAndSerialize('unused',{}),/chains/))
check('有效链夹无效成员时拒绝静默丢失', () => assert.throws(() => validateAndSerialize('unused',{chains:[{id:'a',models:['a/x','bad']}]}),/无效或重复/))
check('缺省 neverCodes 保持默认保护', () => assert.deepEqual(normalizePolicy({mode:'all'}).neverCodes,['ABORTED','CONTEXT_WINDOW_EXCEEDED']))
check('显式空 neverCodes 仍允许用户覆盖', () => assert.deepEqual(normalizePolicy({neverCodes:[]}).neverCodes,[]))

const dir = mkdtempSync(join(tmpdir(),'multi-chain-todos-'))
const previous = process.env.DSH_MULTI_CHAIN_DIR
process.env.DSH_MULTI_CHAIN_DIR = dir
const disposers = []
try {
  writeFileSync(join(dir,'chains.json'),JSON.stringify(config))
  let handler, adapter
  const failure = {type:'finish',reason:{kind:'error',failure:{code:'AUTH',message:'不应写入面板的异常原文'}}}
  const llm = {
    registerAdapter(_providers,value) { adapter = value; return () => {} },
    listProviders:() => [], listModels:async () => [],
    async *stream(options) {
      if(options.provider==='a') yield failure
      else { yield {type:'text-delta',text:'不应写入面板的回答'}; yield {type:'finish',reason:{kind:'stop'}} }
    },
  }
  const {apply} = await import(new URL('../src/index.mjs?todos='+Date.now(),import.meta.url))
  apply({llm,logger:()=>({info(){},warn(){}}),effect(fn){const dispose=fn(); if(dispose) disposers.push(dispose)},webServer:{register(options){handler=options.handler;return ()=>{}}}}, {})
  async function call(method,url,body) {
    let status,payload
    const revision = method === 'PUT' ? (await call('GET','/multi-chain/api/state')).body.revision : undefined
    await handler({method,url,headers:{host:'127.0.0.1:8080','content-type':'application/json',...(revision?{'if-match':revision}:{})},socket:{remoteAddress:'127.0.0.1'},async *[Symbol.asyncIterator](){yield Buffer.from(JSON.stringify(body))}},
      {writeHead(code){status=code},end(value){payload=value}})
    return {status,body:JSON.parse(payload)}
  }
  const state = await call('GET','/multi-chain/api/state')
  check('HTTP 编辑状态包含停用链', () => assert.equal(state.body.chains.length,2))
  const initialModels = await adapter.listModels('MultiChain')
  check('路由模型目录不暴露停用链', () => assert.deepEqual(initialModels.map(model => model.id),['active']))
  for await(const _chunk of adapter.stream({model:'active',sessionId:'test-session',messages:[{text:'不应写入面板的提示词'}]})) { /* 跑真实路由 */ }
  const served = await call('GET','/multi-chain/api/served')
  check('实际 served API 保留会话、链和成员', () => assert.deepEqual(served.body.served.map(row => [row.sessionId,row.chain,row.provider,row.model]),[['test-session','active','b','y']]))
  const status = await call('GET','/multi-chain/api/status')
  check('真实降级链产生尝试、降级与提交记录', () => assert.deepEqual(status.body.events.map(e=>e.kind),['committed','attempt','degrade','attempt']))
  check('面板区分作答和降级成员', () => {const row=status.body.chains[0]; assert.equal(row.lastDegrade.provider,'a');assert.equal(row.lastServed.provider,'b');assert.equal(row.lastServed.degraded,true)})
  check('面板显示 AUTH 成员冷却', () => assert.ok(status.body.chains[0].members[0].cooldownUntil>Date.now()))
  check('记录不含提示词、回答、异常原文', () => assert.ok(!JSON.stringify(status.body).includes('不应写入面板')))
  for(let i=0;i<60;i++) for await(const _chunk of adapter.stream({model:'active',sessionId:'test-session'})) { /* 验证有界记录 */ }
  const bounded = await call('GET','/multi-chain/api/status')
  check('运行记录限制为最近 100 条', () => assert.equal(bounded.body.events.length,100))
  await call('PUT','/multi-chain/api/chains',config)
  check('实际保存不丢停用链且写版本', () => {const doc=JSON.parse(readFileSync(join(dir,'chains.json'),'utf8'));assert.equal(doc.chains.length,2);assert.equal(doc.version,1)})
  await call('PUT','/multi-chain/api/chains',{...config,policy:{cooldown:false}})
  for await(const _chunk of adapter.stream({model:'active',sessionId:'cooldown-disabled'})) { /* 关闭后要重新尝试旧冷却成员 */ }
  const afterDisable = await call('GET','/multi-chain/api/status')
  check('关闭冷却立即允许旧冷却成员重试', () => assert.equal(afterDisable.body.events[2].kind,'degrade'))
  const models = await adapter.listModels('MultiChain')
  check('实际路由目录只有启用链', () => assert.deepEqual(models.map(m=>m.id),['active']))
  const schema = await call('GET','/multi-chain/chains.schema.json')
  check('schema 路由提供版本约束', () => assert.equal(schema.body.properties.version.const,1))
} finally {
  disposers.reverse().forEach(dispose=>dispose())
  if(previous===undefined) delete process.env.DSH_MULTI_CHAIN_DIR; else process.env.DSH_MULTI_CHAIN_DIR=previous
  resetCooldown(); rmSync(dir,{recursive:true,force:true})
}
let code
const registrations = []
const {runInNewContext} = await import('node:vm')
runInNewContext(readFileSync(new URL('../lib/client.js',import.meta.url),'utf8'),{window:{__ModuleLoader__:{load(value){code=value.factory(()=>({createElement:(...args)=>args}))}}},
  fetch:async()=>({ok:true}),AbortSignal})
code.apply({slots:{inject(_name,fn){for(const _ of fn()){}},register(options,component){registrations.push({options,component});return ()=>{}}}})
check('设置总页和插件配置页都注册编辑器', () => assert.equal(registrations.filter(r=>['settings.plugins.tab','plugins.bundle.config'].includes(r.options.name)).length,2))
check('设置页内嵌同源编辑器 iframe', () => {
  const tree=registrations.find(r=>r.options.name==='settings.plugins.tab').component()
  assert.equal(tree[3][0],'iframe');assert.equal(tree[3][1].src,'/multi-chain/')
})
console.log(`待办回归：${passed} 通过 / 0 失败`)
// 宿主未提供 effect 生命周期的延迟探针不属于本断言范围，收工后退出测试进程。
process.exit(0)
