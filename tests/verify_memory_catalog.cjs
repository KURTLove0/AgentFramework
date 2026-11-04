'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{chromium}=require('playwright'),H=require('./ui95_helpers.cjs'),{waitFor}=require('./browser_poll.cjs');
const base=process.env.MEMORY_CATALOG_URL,out=process.env.MEMORY_CATALOG_OUTPUT;if(!base||!out)throw Error('Run the memory-catalog browser suite.');fs.mkdirSync(out,{recursive:true});
const gate=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true}),context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),page=await context.newPage(),other=await context.newPage(),checks=[],errors=[],writes=[];
 for(const tab of [page,other]){tab.setDefaultTimeout(15000);tab.on('pageerror',e=>errors.push(e.message));}
 page.on('request',r=>{if(r.method()==='POST')writes.push(new URL(r.url()).pathname);});
 const call=(tab,url,data)=>tab.evaluate(({url,data})=>api(url,data),{url,data}),pass=message=>{checks.push(message);console.log('PASS '+message);};
 const ready=async(offset,query='')=>{await page.waitForFunction(({offset,query})=>state.libraryResult?.query===query&&state.library?.memory?.episode_page?.offset===offset&&!state.libraryRead?.pending&&!state.libraryRead?.error,{offset,query});await H.settled(page);};
 const ids=()=>page.locator('.library-episodes > [data-key]').evaluateAll(elements=>elements.map(e=>e.dataset.key.slice('episode-'.length)));
 const next=async(offset,query='')=>{await page.locator('#library-memory-next').click();await ready(offset,query);};
 const search=async query=>{await page.locator('#hub-query').fill(query);await page.locator('#hub-search-submit').click();await ready(0,query);};
 const shot=async name=>{await page.evaluate(()=>document.fonts.ready);await page.screenshot({path:path.join(out,name+'.png'),animations:'disabled'});};
 try{
  process.env.AGENT_UI_BASE_URL=base;
  const fixture=JSON.parse(fs.readFileSync(path.join(out,'fixture.json'),'utf8')),workspace=fixture.workspace;
  await page.goto(base+'?workspace_id='+workspace+'#/library');await page.waitForFunction(()=>state.connected&&!state.busy&&state.library);await page.locator('#hub-tab-memory').click();await ready(0);
  await other.goto(base+'?workspace_id='+workspace);await other.waitForFunction(()=>state.connected&&!state.busy);
  const first=await ids();assert.equal(first.length,50);assert.equal(first[0],'bench-run-136');assert.equal(await page.locator('.library-episodes img').count(),0);assert.equal(await page.evaluate(()=>window.memoryXSS),undefined);
  await next(50);const second=await ids();await next(100);const last=await ids();assert.equal(last.length,37);assert(await page.locator('#library-memory-next').isDisabled());assert.deepEqual([...first,...second,...last],Array.from({length:137},(_,i)=>'bench-run-'+(136-i)));
  await page.locator('#library-memory-previous').click();await ready(50);assert.deepEqual(await ids(),second);assert.equal(await page.evaluate(()=>document.activeElement.id),'library-memory-heading');pass('137条私有情节记忆完整翻到末页，无重复和遗漏；上一页恢复原顺序，键盘焦点可继续操作');

  const agent=await H.agent(other,'general-assistant@1.0.0','记忆归档验收助手');
  const saved=await call(other,'/api/tasks',{agent_id:agent.id,agent_revision:agent.revision,request_id:'memory-archive-browser-fixture',goal:'记忆历史浏览验收：整理一份简洁的会议纪要'}),run=saved.run.run_id;
  await waitFor(async()=>(await call(other,'/api/runs/'+run)).run.status==='SUCCEEDED','The offline task did not finish');
  await page.evaluate(()=>refresh());await ready(50);assert.deepEqual(await ids(),second);assert.equal(await page.evaluate(()=>state.library.memory.episode_page.newer_count),1);assert((await page.locator('.library-memory-update').innerText()).includes('1 条新归档'));
  await page.locator('#library-memory-previous').click();await ready(0);assert.deepEqual(await ids(),first);assert.equal(await page.evaluate(()=>state.library.counts.episodes),138);
  await page.locator('#library-memory-latest').click();await ready(0);assert.equal((await ids())[0],run);await page.locator('[data-key="episode-'+run+'"] > summary').click();await page.locator('[data-key="episode-'+run+'"] > a').click();await page.waitForFunction(id=>state.view==='workbench'&&state.detail?.run.run_id===id,run);assert.equal(await page.evaluate(()=>state.detail.run.status),'SUCCEEDED');await H.nav(page,'library');await ready(0);pass('真实离线任务归档后保持正在浏览的位置并提示新记录；主动查看最新后可打开原始任务与证据');

  await search('ordinary');assert.equal(await page.evaluate(()=>state.library.memory.episode_page.filtered_total),134);await next(50,'ordinary');await next(100,'ordinary');assert.equal((await ids()).length,34);
  await search('benchmarkneedle');assert.deepEqual(await ids(),['bench-run-100','bench-run-50','bench-run-0']);assert.equal(await page.evaluate(()=>state.libraryMemory.stack.length),0);assert(await page.locator('#library-memory-previous').isDisabled());pass('关键词搜索跨越旧的50条上限，结果总数准确；改搜其他关键词后从第一页开始');

  await search('');const cursor=await page.evaluate(()=>state.library.memory.episode_page.next_cursor),matches=url=>url.pathname==='/api/knowledge-hub'&&url.searchParams.get('memory_cursor')===cursor;
  await page.route(matches,route=>route.fulfill({status:503,json:{error:'模拟历史页暂时不可用'}}));await page.locator('#library-memory-next').click();await page.locator('[data-library-search-retry]').waitFor();assert.equal(await page.locator('.library-episodes').count(),0);assert((await page.locator('#hub-panel').innerText()).includes('模拟历史页暂时不可用'));
  await page.locator('#hub-query').fill('尚未提交的输入');await page.unroute(matches);await page.locator('[data-library-search-retry]').click();await ready(50);assert.equal(await page.locator('#hub-query').inputValue(),'尚未提交的输入');assert.equal(await page.evaluate(()=>state.libraryMemory.stack.length),1);
  const pageTwo=await ids();await page.locator('#library-memory-previous').click();await ready(0);assert.equal((await ids())[0],run);pass('翻页失败时隐藏旧记录，重试回到原目标页，保留新输入和上一页历史');

  const delayedCursor=await page.evaluate(()=>state.library.memory.episode_page.next_cursor),delayedMatch=url=>url.pathname==='/api/knowledge-hub'&&url.searchParams.get('memory_cursor')===delayedCursor,started=gate(),release=gate();
  await page.route(delayedMatch,async route=>{const response=await route.fetch();started.resolve();await release.promise;await route.fulfill({response});});
  await page.locator('#library-memory-next').click();await started.promise;await search('benchmarkneedle');const response=page.waitForResponse(r=>delayedMatch(new URL(r.url())));release.resolve();await(await response).finished();await page.unroute(delayedMatch);await H.settled(page);assert.deepEqual(await ids(),['bench-run-100','bench-run-50','bench-run-0']);assert.equal(await page.evaluate(()=>state.libraryMemory.stack.length),0);pass('翻页等待时可以发起新搜索，迟到的旧页不会覆盖新结果');

  await search('');await next(50);const prior=await ids();const badCursor=await page.evaluate(()=>state.library.memory.episode_page.next_cursor),badMatch=url=>url.pathname==='/api/knowledge-hub'&&url.searchParams.get('memory_cursor')===badCursor;
  await page.route(badMatch,route=>route.fulfill({status:400,json:{error:'记忆分页位置无效，请从最新记录开始'}}));await page.locator('#library-memory-next').click();await page.locator('[data-library-search-restore]').waitFor();await page.locator('[data-library-search-restore]').click();assert.deepEqual(await ids(),prior);assert.equal(await page.evaluate(()=>state.libraryMemory.stack.length),1);
  await page.locator('#library-memory-next').click();await page.locator('[data-library-memory-page="latest"]').click();await ready(0);assert.equal((await ids())[0],run);assert.equal(await page.evaluate(()=>state.libraryMemory.stack.length),0);await page.unroute(badMatch);pass('失效分页可返回上次成功页，也可从最新记录恢复，无需刷新整个应用');

  const layouts=[];let css='';await page.route('**/__memory-text.css*',route=>route.fulfill({status:200,contentType:'text/css',body:css}));
  for(const theme of ['light','dark'])for(const width of [1024,1440])for(const scale of [1,2]){
   await page.setViewportSize({width,height:1000});await page.evaluate(theme=>{const select=document.querySelector('#appearance-select');select.value=theme;select.dispatchEvent(new Event('change',{bubbles:true}));},theme);
   const baseline=await page.locator('#library-memory-next').evaluate(e=>parseFloat(getComputedStyle(e).fontSize));
   if(scale===2){css='.library-episodes p,.library-episodes button,.library-episodes summary{font-size:'+(baseline*2)+'px!important;line-height:1.6!important;}';await page.evaluate(url=>new Promise((resolve,reject)=>{const link=document.createElement('link');link.id='memory-text-scale';link.rel='stylesheet';link.href=url;link.onload=()=>resolve();link.onerror=()=>reject(Error('Text scaling unavailable'));document.head.append(link);}),base+'/__memory-text.css?case='+layouts.length);}
   await page.locator('#library-memory-next').focus();await page.locator('.library-memory-nav').scrollIntoViewIfNeeded();await H.settled(page);
   const bounds=await page.locator('.library-episodes').evaluate(e=>{const b=e.querySelector('#library-memory-next'),r=b.getBoundingClientRect();return {root:document.documentElement.scrollWidth,scroll:e.scrollWidth,client:e.clientWidth,focused:document.activeElement===b,left:r.left,right:r.right,top:r.top,bottom:r.bottom,font:parseFloat(getComputedStyle(b).fontSize)};});
   assert(bounds.root<=width&&bounds.scroll<=bounds.client+1&&bounds.left>=0&&bounds.right<=width&&bounds.top>=0&&bounds.bottom<=1000&&bounds.focused,JSON.stringify({theme,width,scale,bounds}));assert(bounds.font>=baseline*scale-.1);layouts.push({theme,width,scale,baseline,bounds});if(width===1440&&scale===1)await shot('memory-history-'+theme);await page.evaluate(()=>document.getElementById('memory-text-scale')?.remove());
  }
  pass('长摘要与分页在8组桌面深浅色和200%文字场景下无横向溢出，键盘焦点和按钮始终可见');
  assert.deepEqual(writes,[]);
  const alternate=await call(other,'/api/workspaces',{name:'记忆隔离验证',business:'测试',scenario:'测试',description:'独立空间',revision:0});await H.switchSpace(page,alternate.id);await H.nav(page,'library');await page.locator('#hub-tab-memory').click();await ready(0);assert.equal(await page.evaluate(()=>state.library.counts.episodes),0);assert.equal(await page.locator('.library-episodes > [data-key]').count(),0);await H.switchSpace(page,workspace);await H.nav(page,'library');await page.locator('#hub-tab-memory').click();await ready(0);assert.equal(await page.evaluate(()=>state.library.counts.episodes),138);assert.equal(await page.evaluate(()=>state.libraryMemory.stack.length),0);assert.deepEqual(errors,[]);pass('新空间看不到原空间的情节记忆，切回后重新建立浏览窗口；全部浏览和恢复操作只读取数据');
  fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({checks,errors,layouts,seeded:137,totalAfterArchive:138,run,workspace,pageSizes:[first.length,second.length,last.length],pageTwoCount:pageTwo.length,browsingWrites:[],externalModelCalls:0},null,2));
 }catch(error){await shot('failure').catch(()=>{});fs.writeFileSync(path.join(out,'failure.json'),JSON.stringify({checks,errors,error:error.stack,text:await page.locator('body').innerText()},null,2));throw error;}finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
