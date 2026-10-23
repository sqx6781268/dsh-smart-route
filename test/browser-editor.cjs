// Tabbit 脚本体，由 scripts/browser-test.mjs 注入源码位置和测试 URL；不能直接 node 执行。
const {createWebUiHandler,validateAndSerialize}=await import(new URL('src/webui.mjs',testRootURL).href);
const {normalizeDocument}=await import(new URL('src/chains.mjs',testRootURL).href);
globalThis.testConfig={version:1,chains:[{id:'fast',name:'快速链',models:['a/x','b/y']},{id:'off',name:'停用链',enabled:false,models:['b/y']}]};
globalThis.revision=1;globalThis.failSave=false;globalThis.invalidVersion=false;globalThis.pageErrors=[];
page.on('pageerror',error=>pageErrors.push(error.message));
const snapshot=()=>{const doc=normalizeDocument(invalidVersion?{...testConfig,version:2}:testConfig);return {...doc,chains:doc.configuredChains,revision:'"'+revision+'"'}};
const handler=createWebUiHandler({readChains:snapshot,capabilities:()=>({providers:[{id:'a',name:'渠道甲',models:[{id:'x',name:'模型甲'}]},{id:'b',name:'渠道乙',models:[{id:'y',name:'模型乙'}]}]}),paths:{chainsFile:'隔离测试配置'},
 saveChains(raw,expected){if(expected!==snapshot().revision)throw Object.assign(new Error('配置已在另一页面更新'),{statusCode:412});if(failSave)throw new Error('测试保存失败');testConfig=JSON.parse(validateAndSerialize('unused',raw));revision++;return snapshot()},
 runtimeStatus:()=>({generatedAt:Date.now(),retention:100,chains:[],events:[]})});
const install=async p=>{await p.route(testOrigin+'/multi-chain/**',async route=>{
 const request=route.request();let status=200,headers={},body='';
 await handler({url:request.url(),method:request.method(),headers:{...request.headers(),host:new URL(testOrigin).host},socket:{remoteAddress:'127.0.0.1'},async *[Symbol.asyncIterator](){yield Buffer.from(request.postData()||'')}},{writeHead(code,value){status=code;headers=value},end(value){body=value}});
 await route.fulfill({status,headers,body});
});};
await install(page);
await page.goto(testOrigin+'/multi-chain/',{waitUntil:'domcontentloaded',timeout:10000});
await expect(page.getByLabel('链 1 名称',{exact:true})).toHaveValue('快速链',{timeout:10000});
const second=await context.newPage();await install(second);await second.goto(testOrigin+'/multi-chain/',{waitUntil:'domcontentloaded'});
await expect(second.getByLabel('链 1 名称',{exact:true})).toHaveValue('快速链');
await page.getByLabel('链 1 名称',{exact:true}).fill('快速链已改');
await page.getByLabel('快速链 成员 1 模型',{exact:true}).selectOption('b/y');
await expect(page.getByLabel('快速链 成员 1 手动输入',{exact:true})).toHaveValue('b/y');
await page.getByLabel('快速链 成员 1 手动输入',{exact:true}).fill('a/x');
await page.locator('#save').click();await expect(page.getByRole('status')).toHaveText('已保存，配置已加载。');
assert.equal(testConfig.chains[0].name,'快速链已改');assert.equal(testConfig.chains[1].enabled,false);
await second.getByLabel('链 1 名称',{exact:true}).fill('过期草稿');await second.locator('#save').click();
await expect(second.getByRole('alert')).toContainText('另一页面更新');await expect(second.getByLabel('链 1 名称',{exact:true})).toHaveValue('过期草稿');assert.equal(testConfig.chains[0].name,'快速链已改');
failSave=true;await page.getByLabel('链 1 名称',{exact:true}).fill('保存失败草稿');await page.locator('#save').click();
await expect(page.getByRole('alert')).toContainText('测试保存失败');await expect(page.getByLabel('链 1 名称',{exact:true})).toHaveValue('保存失败草稿');assert.equal(pageErrors.length,0);
await second.evaluate(()=>{DIRTY=false});
invalidVersion=true;await second.reload({waitUntil:'domcontentloaded'});
await expect(second.getByRole('alert')).toContainText('不支持配置版本');
await expect(second.locator('#save')).toBeDisabled();
await second.close();await page.evaluate(()=>{DIRTY=false});await page.close();
return {passed:true,cases:['输入绑定','下拉同步','保存及停用链保留','双页面冲突保留草稿','保存失败保留草稿'],pageErrors,mode:'真实源码 handler，独立测试内存，无用户配置写入'};
