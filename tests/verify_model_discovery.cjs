'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{chromium}=require('playwright'),H=require('./ui95_helpers.cjs');
const base=process.env.MODEL_DISCOVERY_URL,out=process.env.MODEL_DISCOVERY_OUTPUT;if(!base||!out)throw Error('Use isolated fixture');fs.mkdirSync(out,{recursive:true});
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1100},reducedMotion:'reduce'}),errors=[],checks=[],requests=[],layouts=[];
 page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST')requests.push(new URL(r.url()).pathname);});
 const pass=t=>{checks.push(t);console.log('PASS '+t);},status=id=>page.locator('[data-model-status="'+id+'"]');
 const ready=()=>page.waitForFunction(()=>state.view==='runtimes'&&runtimeSettingsEditor&&!runtimeSettingsEditor.busy&&!state.busy);
 try{
  await page.goto(base);await page.waitForFunction(()=>state.connected&&!state.busy);await H.nav(page,'runtimes');await ready();await page.locator('[data-provider="codex"]').click();await page.locator('#codex-timeout').fill('93');
  await page.waitForFunction(()=>document.querySelector('[data-model-status="codex"]').textContent.includes('正在通过'));
  await page.locator('[data-provider="cursor"]').click();await page.waitForFunction(()=>document.querySelector('[data-model-status="cursor"]').textContent.includes('来源：'));
  assert.match(await status('codex').textContent(),/正在通过/);assert.equal(await page.locator('#cursor-model').inputValue(),'model-one');
  pass('Codex 查询持续通知时，Cursor 目录仍可先完成，配置页保持可操作');
  await page.waitForFunction(()=>document.querySelector('[data-model-status="codex"]').textContent.includes('超时'));
  // Selecting retries an uncached directory; inspect the retained failure before that explicit action.
  assert.match(await status('codex').textContent(),/刷新模型/);assert.equal(await page.locator('#codex-timeout').inputValue(),'93');assert.equal(await page.locator('#codex-model').inputValue(),'model-one');
  pass('查询超时返回可重试提示，原模型选择与未保存超时参数保持不变');
  await page.locator('[data-provider="codex"]').click();await page.waitForFunction(()=>document.querySelector('[data-model-status="codex"]').textContent.includes('来源：'));await page.locator('#codex-model').selectOption('model-two');
  await page.locator('[data-action="reload-models"][data-model-target="codex"]').click();await page.waitForFunction(()=>document.querySelector('[data-model-status="codex"]').textContent.includes('超时'));
  assert.equal(await page.locator('#codex-model').inputValue(),'model-two');assert.equal(await page.locator('#codex-timeout').inputValue(),'93');assert(!await page.locator('#runtime-save').isDisabled());
  const cached=await page.evaluate(()=>api('/api/runtime-config/models?provider=codex'));assert(cached.cached);assert.equal(cached.models.length,2);
  for(const theme of ['light','dark']){
   await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);await H.settled(page);await page.screenshot({path:path.join(out,'model-discovery-'+theme+'.png'),animations:'disabled'});
   const bounds=await page.locator('.runtime-editor').evaluate(el=>({width:innerWidth,scroll:document.documentElement.scrollWidth,panel:el.scrollWidth,panelWidth:el.clientWidth}));assert(bounds.scroll<=bounds.width+1&&bounds.panel<=bounds.panelWidth+1);layouts.push({theme,...bounds});
  }
  pass('刷新失败保留原目录和本页选择，服务端有效缓存可读，浅深色错误提示布局正常');
  await page.locator('[data-action="reload-models"][data-model-target="codex"]').click();await page.waitForFunction(()=>document.querySelector('[data-model-status="codex"]').textContent.includes('来源：'));assert.equal(await page.locator('#codex-model').inputValue(),'model-two');
  await H.nav(page,'agents');await H.nav(page,'runtimes');await ready();assert.equal(await page.locator('#codex-timeout').inputValue(),'93');assert.equal(await page.locator('#codex-model').inputValue(),'model-two');assert.equal(requests.filter(p=>p==='/api/runtime-config'||p==='/api/runs'||p==='/api/tasks').length,0);
  pass('显式重试可恢复模型目录，切换页面后编辑继续保留，全程未保存配置或创建任务');
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({checks,errors,requests,layouts},null,2));
 }catch(error){await page.screenshot({path:path.join(out,'failure.png'),animations:'disabled'}).catch(()=>{});fs.writeFileSync(path.join(out,'failure.json'),JSON.stringify({checks,errors,error:error.stack},null,2));throw error;}finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
