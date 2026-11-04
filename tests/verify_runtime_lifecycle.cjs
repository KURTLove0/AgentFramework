'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{chromium}=require('playwright'),H=require('./ui95_helpers.cjs');
const cacheProbe=require('./runtime_cache_probe.cjs'),base=process.env.RUNTIME_LIFECYCLE_URL,out=process.env.RUNTIME_LIFECYCLE_OUTPUT;if(!base||!out)throw Error('Use isolated fixture');fs.mkdirSync(out,{recursive:true});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1100},reducedMotion:'reduce'}),errors=[],checks=[],posts=[],restores=[];let release;
 page.setDefaultTimeout(12000);page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST'&&new URL(r.url()).pathname==='/api/runtime-config')posts.push(r.postDataJSON());});
 const pass=t=>{checks.push(t);console.log('PASS '+t);},ready=()=>page.waitForFunction(()=>typeof state!=='undefined'&&state.view==='runtimes'&&typeof runtimeSettingsEditor!=='undefined'&&runtimeSettingsEditor&&!runtimeSettingsEditor.busy&&!state.busy);
 const call=(url,data)=>page.evaluate(({url,data})=>api(url,data),{url,data}),endpoint=base+'/api/runtime-config',cycle=()=>page.evaluate(()=>{window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}));window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true}));});
 try{
  restores.push(await cacheProbe(base));
  pass('独立 Chrome 的真实前进后退缓存恢复同一文档，保留输入，恢复后可明确保存；仅临时 HTML 允许缓存');
  await page.goto(base);await page.waitForFunction(()=>state.connected&&!state.busy);await H.nav(page,'runtimes');await ready();const startRevision=await page.evaluate(()=>state.runtimeConfig.settings.revision);await page.locator('#codex-timeout').fill('84');
  const scrollBefore=await page.evaluate(()=>{window.scrollTo({top:250,behavior:'instant'});return window.scrollY;});assert(scrollBefore>0);
  await page.goto('about:blank');await page.goBack({waitUntil:'commit'});await ready();assert.equal(await page.locator('#codex-timeout').inputValue(),'84');assert(!await page.locator('#codex-timeout').isDisabled());assert.equal(posts.length,0);assert(Math.abs(await page.evaluate(()=>window.scrollY)-scrollBefore)<2);
  await page.locator('#runtime-save').click();await ready();assert.equal((await call('/api/runtime-config')).settings.profiles.codex.timeout,84);assert.equal(posts.length,1);
  pass('浏览器重新加载式返回同样保留输入并可保存，返回本身不提交');

  const entered=deferred(),go=deferred(),delivered=deferred();release=go.resolve;let hold=true;
  await page.route(endpoint,async route=>{if(route.request().method()!=='POST'||!hold)return route.continue();hold=false;const response=await route.fetch();entered.resolve();await go.promise;await route.fulfill({response});delivered.resolve();});
  await page.locator('#codex-timeout').fill('85');await page.locator('#runtime-save').click();await entered.promise;const payload=posts.at(-1),count=posts.length;
  await page.evaluate(()=>{window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true}));attachRuntimeSettings();});assert.equal(await page.evaluate(()=>runtimeSettingsEditor),null);assert(await page.locator('#codex-timeout').isDisabled());
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true})));await ready();assert(!await page.locator('#codex-timeout').isDisabled());assert(await page.locator('#runtime-save').isDisabled());assert(!await page.locator('[data-runtime-settings="check"]').isDisabled());assert.equal(await page.evaluate(()=>document.querySelector('#runtime-form').hasAttribute('aria-busy')),false);assert.equal(posts.length,count);
  await page.locator('#codex-timeout').fill('86');go.resolve();await delivered.promise;await page.unroute(endpoint);release=null;await H.settled(page);assert.equal(await page.locator('#codex-timeout').inputValue(),'86');assert.equal(await page.evaluate(()=>runtimeSettingsEditor.attempt.payload.request_id),payload.request_id);assert.equal(await page.evaluate(()=>state.runtimeConfig.settings.revision),startRevision+1);
  await page.locator('[data-runtime-settings="check"]').click();await ready();assert.equal(posts.length,count);assert.equal(await page.evaluate(()=>state.runtimeConfig.settings.revision),startRevision+2);assert.equal(await page.locator('#codex-timeout').inputValue(),'86');
  await page.locator('#runtime-save').click();await ready();assert.equal(posts.length,count+1);assert.notEqual(posts.at(-1).request_id,payload.request_id);assert.equal((await call('/api/runtime-config')).settings.revision,startRevision+3);
  pass('保存中的生命周期恢复解除旧禁用状态，保留原编号；迟到回执不覆盖新输入，核对和后续保存均可继续');

  const readEntered=deferred(),readGo=deferred(),readDelivered=deferred();release=readGo.resolve;let holdRead=true;
  await page.route(endpoint,async route=>{if(route.request().method()!=='GET'||!holdRead)return route.continue();holdRead=false;const response=await route.fetch();readEntered.resolve();await readGo.promise;await route.fulfill({response});readDelivered.resolve();});
  await page.locator('[data-action="reload-runtime"]').click();await readEntered.promise;await page.locator('#codex-timeout').fill('90');const current=(await call('/api/runtime-config')).settings;delete current.updated_at;current.profiles.codex.timeout=100;await call('/api/runtime-config',current);
  await cycle();await ready();assert.equal(await page.locator('#codex-timeout').inputValue(),'90');assert.equal(await page.evaluate(()=>runtimeSettingsEditor.latest.settings.revision),startRevision+4);readGo.resolve();await readDelivered.promise;await page.unroute(endpoint);release=null;await H.settled(page);assert.equal(await page.evaluate(()=>runtimeSettingsEditor.latest.settings.revision),startRevision+4);assert.equal(await page.locator('#codex-timeout').inputValue(),'90');assert(await page.locator('[data-runtime-settings="keep"]').isVisible());
  for(const theme of ['light','dark']){await page.selectOption('#appearance-select',theme);await page.locator('[data-runtime-settings="keep"]').scrollIntoViewIfNeeded();await H.settled(page);await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));await page.screenshot({path:path.join(out,'runtime-lifecycle-'+theme+'.png'),animations:'disabled'});}
  await page.locator('[data-runtime-settings="keep"]').click();await ready();pass('慢读取期间恢复会重新核对当前版本，旧读取不能回退冲突信息或覆盖输入');

  await page.evaluate(()=>{window.runtimeStorageOriginal={get:Storage.prototype.getItem,set:Storage.prototype.setItem};Storage.prototype.getItem=function(k){if(k.startsWith('runtime-settings-draft:'))throw Error('isolated storage failure');return runtimeStorageOriginal.get.call(this,k);};Storage.prototype.setItem=function(k,v){if(k.startsWith('runtime-settings-draft:'))throw Error('isolated storage failure');return runtimeStorageOriginal.set.call(this,k,v);};});
  await page.locator('#codex-timeout').fill('95');const beforeRestore=posts.length;await cycle();await ready();assert.equal(await page.locator('#codex-timeout').inputValue(),'95');assert.match(await page.locator('#runtime-settings-recovery').innerText(),/无法保存恢复副本/);assert.equal(posts.length,beforeRestore);
  await page.evaluate(()=>{Storage.prototype.getItem=runtimeStorageOriginal.get;Storage.prototype.setItem=runtimeStorageOriginal.set;});await page.locator('#codex-timeout').fill('96');await cycle();await ready();assert.equal(await page.locator('#codex-timeout').inputValue(),'96');
  await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pagehide',{persisted:true})));await H.nav(page,'agents');await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true})));assert.equal(await page.evaluate(()=>runtimeSettingsEditor),null);await H.nav(page,'runtimes');await ready();assert.equal(await page.locator('#codex-timeout').inputValue(),'96');
  pass('存储不可用时页面缓存仍可恢复内存草稿；其他页面不会误开配置编辑器，返回后可继续');
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({checks,errors,posts,restores,controlled_lifecycle_cases:['pending save','late read','storage failure','different route']},null,2));
 }catch(error){await page.screenshot({path:path.join(out,'failure.png'),animations:'disabled'}).catch(()=>{});fs.writeFileSync(path.join(out,'failure.json'),JSON.stringify({checks,errors,restores,error:error.stack},null,2));throw error;}finally{release?.();await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
