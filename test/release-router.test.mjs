import { test } from 'node:test'
import assert from 'node:assert/strict'
import { MultiChainAdapter, classifyOutcome } from '../src/adapter.mjs'
import { normalizeDocument, normalizeCooldown, normalizeChain, resetCooldown, isCooling } from '../src/chains.mjs'
const config = () => normalizeDocument({chains:[{id:'p',models:['a/x','b/y']}]})
const collect = async (stream) => {const rows=[];for await(const row of stream) rows.push(row);return rows}
function harness(stream, policy, onServed) {
  const doc=config();const calls=[]
  const adapter=new MultiChainAdapter({chains:()=>doc.chains,policy:()=>policy??doc.policy,llm:()=>({stream(options){calls.push(options.provider);return stream(options)}}),onServed})
  return {calls,run:(options={})=>collect(adapter.stream({model:'p',sessionId:'s',...options}))}
}
const text={type:'text-delta',text:'正常回答'}
const stop={type:'finish',reason:{kind:'stop'}}
test('R1 调用前取消不接触任何成员',async()=>{const c=new AbortController();c.abort();const h=harness(async function*(){yield text});const out=await h.run({signal:c.signal});assert.deepEqual(h.calls,[]);assert.equal(out.at(-1).reason.kind,'aborted')})
test('R1 候选中取消并抛错不能降级',async()=>{const c=new AbortController();const h=harness(async function*(){c.abort();throw new DOMException('取消','AbortError')});const out=await h.run({signal:c.signal});assert.deepEqual(h.calls,['a']);assert.equal(out.at(-1).reason.kind,'aborted')})
test('R1 失败终态后切换前取消不进入备用',async()=>{const c=new AbortController();const h=harness(async function*(){yield {type:'finish',reason:{kind:'error',failure:{code:'SERVER'}}};c.abort()});const out=await h.run({signal:c.signal});assert.deepEqual(h.calls,['a']);assert.equal(out.at(-1).reason.kind,'aborted')})
test('R1 无 signal 的 AbortError 仍为中止',async()=>{const h=harness(async function*(){throw new DOMException('取消','AbortError')});assert.equal((await h.run()).at(-1).reason.kind,'aborted');assert.deepEqual(h.calls,['a'])})
test('R2 提交后异常有错误终态且不切换',async()=>{const h=harness(async function*(){yield text;throw Object.assign(new Error('连接中断'),{code:'TRANSPORT'})});const out=await h.run();assert.deepEqual(h.calls,['a']);assert.equal(out[0].text,text.text);assert.equal(out.at(-1).reason.failure.code,'TRANSPORT')})
test('R2 提交后缺结束原因有明确错误',async()=>{const h=harness(async function*(){yield text});assert.equal((await h.run()).at(-1).reason.failure.code,'INCOMPLETE_STREAM')})
test('正常流不会重复终态',async()=>{const h=harness(async function*(){yield text;yield stop});const out=await h.run();assert.equal(out.filter(x=>x.type==='finish').length,1);assert.equal(out.at(-1).reason.kind,'stop')})
test('R3 已知异常和 finish 服从同一 only/never 规则',async()=>{const policy={...config().policy,mode:'only',codes:['SERVER']};const h=harness(async function*(){throw Object.assign(new Error('认证失败'),{code:'AUTH'})},policy);assert.equal((await h.run()).at(-1).reason.failure.code,'AUTH');assert.deepEqual(h.calls,['a']);assert.equal(classifyOutcome(undefined,Object.assign(new Error(),{code:'CONTEXT_WINDOW_EXCEEDED'}),config().policy).degrade,false)})
test('R3 允许降级的 AUTH 异常进入冷却',async()=>{resetCooldown();const h=harness(async function*(options){if(options.provider==='a')throw Object.assign(new Error('认证失败'),{code:'AUTH'});yield text;yield stop});assert.equal((await h.run()).at(-1).reason.kind,'stop');assert.equal(isCooling({provider:'a',model:'x'}),true);resetCooldown()})
test('R7 观察回调异常不丢答案',async()=>{const h=harness(async function*(){yield text;yield stop},undefined,()=>{throw new Error('观察失败')});assert.deepEqual(await h.run(),[text,stop])})
test('R9 正小数不会归一化为零',()=>{assert.equal(normalizeCooldown({ms:.5}).ms,1);assert.equal(normalizeChain({models:['a/x'],stickyLimit:.5},0).stickyLimit,1)})
