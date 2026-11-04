'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{chromium}=require('playwright'),H=require('./ui95_helpers.cjs');
const base=process.env.RUN_HISTORY_URL,out=process.env.RUN_HISTORY_OUTPUT;if(!base||!out)throw Error('Use the isolated history fixture');fs.mkdirSync(out,{recursive:true});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true}),context=await browser.newContext({viewport:{width:1440,height:1100},reducedMotion:'reduce'}),page=await context.newPage(),other=await context.newPage(),checks=[],errors=[],posts=[],layouts=[];
 for(const p of [page,other]){p.setDefaultTimeout(15000);p.on('pageerror',e=>errors.push(e.message));p.on('request',r=>{if(r.method()==='POST')posts.push({path:new URL(r.url()).pathname,body:r.postDataJSON()});});}
 const config=JSON.parse(fs.readFileSync(path.join(out,'fixture.json'),'utf8')),call=(p,url,data)=>p.evaluate(({url,data})=>api(url,data),{url,data}),pass=text=>{checks.push(text);console.log('PASS '+text);};
 const detailReady=async(p,id)=>{await p.waitForFunction(id=>state.detail?.conversation?.id===id&&!state.busy&&!!state.detail.archive,id);await H.settled(p);};
 const nav=async(p,id)=>{await H.nav(p,'runs',id);await detailReady(p,id);};
 const listReady=async()=>{await page.waitForFunction(()=>state.view==='runs'&&!state.selected&&!state.busy&&state.runHistory?.dataPath===runsRequest()&&!state.runHistory.pending&&!state.runHistory.error);await H.settled(page);};
 const archived=async(p,value,revision)=>p.waitForFunction(({value,revision})=>taskArchiveValue().archived===value&&taskArchiveValue().revision>=revision&&!taskArchiveOperation()?.pending,{value,revision});
 try{
  process.env.AGENT_UI_BASE_URL=base;const [a,b,c,d]=config.roots;await page.goto(base+'?workspace_id='+config.workspace+'#/runs/'+a);await detailReady(page,a);
  const original=await call(page,'/api/tasks/'+a);await page.locator('#task-chat-input').fill('归档时仍要保留的未发送草稿');await page.locator('[data-task-archive]').focus();await page.keyboard.press('Enter');await archived(page,true,1);assert.equal(await page.evaluate(()=>document.activeElement?.id),'task-archive-action');
  const saved=await call(page,'/api/tasks/'+a);assert.deepEqual(saved.run,original.run);assert.deepEqual(saved.conversation.turns.map(t=>t.reply),original.conversation.turns.map(t=>t.reply));assert.equal(await page.locator('#task-chat-input').inputValue(),'归档时仍要保留的未发送草稿');
  const exported=await call(page,'/api/tasks/'+a+'/export?kind=json');assert(exported.archive.archived);assert.equal(exported.turns[0].reply.content,original.conversation.turns[0].reply.content);
  const markdown=await page.evaluate(({id,workspace})=>fetch('/api/tasks/'+id+'/export?kind=markdown&workspace_id='+workspace).then(r=>r.text()),{id:a,workspace:config.workspace}),originalContent=original.conversation.turns[0].reply.content;assert(typeof originalContent==='string'&&originalContent.length>0);assert(markdown.includes(originalContent));
  for(const theme of ['light','dark'])for(const width of [1024,1440])for(const scale of [1,2]){
   await page.setViewportSize({width,height:1100});await page.evaluate(({theme,scale})=>{document.documentElement.dataset.theme=theme;document.documentElement.dataset.archiveTextScale=scale;if(!window.archiveScaleRule){document.styleSheets[0].insertRule('html[data-archive-text-scale="2"] #task-archive-action,html[data-archive-text-scale="2"] #task-archive-review,html[data-archive-text-scale="2"] .task-archive-notice,html[data-archive-text-scale="2"] .task-archive-notice *{font-size:28px!important}',0);window.archiveScaleRule=true;}},{theme,scale});
   const button=page.locator('#task-archive-action');await button.scrollIntoViewIfNeeded();await button.focus();await page.evaluate(()=>render());
   const bounds=await button.evaluate(el=>{const r=el.getBoundingClientRect();return {root:document.documentElement.scrollWidth,width:innerWidth,left:r.left,right:r.right,top:r.top,bottom:r.bottom,fontSize:parseFloat(getComputedStyle(el).fontSize),focused:document.activeElement===el};});
   assert(bounds.focused&&bounds.root<=width+1&&bounds.left>=0&&bounds.right<=width+1&&bounds.top>=0&&bounds.bottom<=1100,JSON.stringify(bounds));if(scale===2)assert.equal(bounds.fontSize,28);layouts.push({theme,width,scale,bounds});
   if(width===1440&&scale===1)await page.screenshot({path:path.join(out,'archived-'+theme+'.png'),animations:'disabled'});
   if(width===1024&&scale===2&&theme==='light')await page.screenshot({path:path.join(out,'archived-enlarged.png'),animations:'disabled'});
  }
  await page.evaluate(()=>delete document.documentElement.dataset.archiveTextScale);await page.setViewportSize({width:1440,height:1100});
  pass('归档保留执行结果、对话、导出和未发送草稿；八组桌面主题与字号下恢复入口可见且重绘保留焦点');

  await H.nav(page,'runs');await listReady();await page.locator('#run-search').fill('历史目标-0000');await listReady();await page.waitForFunction(()=>state.search==='历史目标-0000'&&!state.runHistory.pending&&state.runHistory.dataPath===runsRequest());assert.equal(await page.locator('tr[data-run]').count(),0);
  await page.locator('#run-filters-toggle').click();await page.locator('#run-visibility-filter').selectOption('archived');await listReady();assert.equal(await page.locator('tr[data-run]').count(),1);assert((await page.locator('tr[data-run] .status-cell').innerText()).includes('已归档'));
  await page.reload();await listReady();assert.equal(await page.locator('#run-visibility-filter').inputValue(),'archived');assert.equal(await page.locator('tr[data-run]').count(),1);
  await page.locator('tr[data-run] .task-link').click();await detailReady(page,a);await page.locator('#task-archive-action').click();await archived(page,false,2);assert.equal(await page.locator('#task-chat-input').inputValue(),'归档时仍要保留的未发送草稿');
  await H.nav(page,'runs');await listReady();assert.equal(await page.locator('tr[data-run]').count(),0);await page.locator('#run-visibility-filter').selectOption('all');await listReady();assert.equal(await page.locator('tr[data-run]').count(),1);
  pass('默认列表隐藏归档，已归档与包含归档范围可搜索；刷新保留筛选，移回后出现在对应范围');

  await nav(page,b);await other.goto(base+'?workspace_id='+config.workspace+'#/runs/'+b);await detailReady(other,b);
  const endpoint=base+'/api/tasks/'+b+'/archive',entered=deferred(),release=deferred();let held=false;
  await page.route(endpoint,async route=>{if(route.request().method()==='POST'&&!held){held=true;const response=await route.fetch();entered.resolve();await release.promise;return route.fulfill({response});}return route.continue();});
  await page.locator('[data-task-archive]').click();await entered.promise;await page.locator('#task-chat-input').fill('等待归档回执时继续编辑');await call(other,'/api/tasks/'+b+'/archive',{archived:false,revision:1});
  await page.waitForFunction(()=>taskArchiveValue().revision===2);release.resolve();await archived(page,false,2);await page.unroute(endpoint);assert(!(await page.locator('.task-archive-notice').innerText()).includes('已归档'));assert.equal(await page.evaluate(()=>document.activeElement?.id),'task-chat-input');assert.equal(await page.locator('#task-chat-input').inputValue(),'等待归档回执时继续编辑');
  pass('另一页面移回任务后，迟到的旧归档回执不能覆盖当前状态或显示错误结果');

  await nav(page,c);const lostEndpoint=base+'/api/tasks/'+c+'/archive';await page.locator('#task-chat-input').fill('回执不确定期间的草稿');
  await page.route(lostEndpoint,async route=>{if(route.request().method()==='POST'){await route.fetch();return route.abort('failed');}return route.continue();});
  await page.locator('[data-task-archive]').focus();await page.keyboard.press('Enter');await page.locator('[data-task-archive-review]').waitFor();assert.equal(await page.evaluate(()=>document.activeElement?.id),'task-archive-review');await page.unroute(lostEndpoint);const beforeRead=posts.length;
  await page.locator('[data-task-archive-review]').focus();await page.keyboard.press('Enter');await archived(page,true,1);assert.equal(await page.evaluate(()=>document.activeElement?.id),'task-archive-action');assert.equal(posts.length,beforeRead);await page.reload();await detailReady(page,c);assert(await page.evaluate(()=>taskArchiveValue().archived));assert.equal(posts.length,beforeRead);
  await page.locator('#task-chat-input').fill('归档后继续处理');await page.locator('#task-chat-form button[type=submit]').click();await page.waitForFunction(()=>state.detail?.conversation?.turns.length===2&&!state.detail.conversation.active&&state.detail.conversation.turns[1].status==='SUCCEEDED');await archived(page,false,2);
  assert.equal(await page.locator('.task-archive-notice').count(),0);assert((await call(page,'/api/runs?search='+encodeURIComponent('历史目标-0002'))).runs.some(r=>r.run_id===c));
  pass('归档回执丢失可只读核对，刷新不重放；发送新消息会自动移回列表并清除旧归档提示');

  await nav(page,d);await nav(other,d);const delayedEndpoint=base+'/api/tasks/'+d+'/archive',arrived=deferred(),go=deferred();
  await page.route(delayedEndpoint,async route=>{if(route.request().method()==='POST'){arrived.resolve();await go.promise;}return route.continue();});
  await page.locator('[data-task-archive]').click();await arrived.promise;await call(other,'/api/tasks/'+d+'/messages',{content:'较晚发送的继续处理要求',request_id:'newer-message',revision:1});
  await other.waitForFunction(()=>state.detail?.conversation?.turns.length===2&&state.detail.conversation.turns[1].status==='SUCCEEDED'&&!state.detail.conversation.active);go.resolve();await page.locator('[data-task-archive-review]').waitFor();await page.unroute(delayedEndpoint);
  assert(!(await call(page,'/api/tasks/'+d)).archive.archived);await page.locator('[data-task-archive-review]').click();await archived(page,false,1);
  pass('新消息先受理并完成时，先前尚未接受的归档请求因版本变化被拒绝，任务保持可见');

  await call(page,'/api/tasks/'+a+'/archive',{archived:true,revision:2});const all=await call(page,'/api/runs?visibility=all&search='+encodeURIComponent('历史目标-0000'));assert(all.runs[0].archive.archived);
  await page.evaluate(()=>startCommandSearch());await page.locator('#command-input').fill('历史目标-0000');await page.locator('[data-command]').filter({hasText:'历史目标-0000'}).waitFor();assert((await page.locator('#command-results').innerText()).includes('已归档'));
  await page.keyboard.press('Escape');await H.nav(page,'workbench');await page.locator('[data-run-filter="all"]').waitFor();await page.evaluate(()=>Object.assign(state,{runVisibility:'archived',runAgent:'old-agent',runDomain:'old-domain',runAfter:'2020-01-01',runBefore:'2020-01-02'}));await page.locator('[data-run-filter="all"]').click();await listReady();
  assert.equal(await page.evaluate(()=>state.runVisibility),'all');assert.equal(await page.evaluate(()=>state.runPage.filtered_total),await page.evaluate(()=>state.counts.total));
  await page.locator('#run-search').fill('历史目标-0000');await listReady();await page.waitForFunction(()=>state.search==='历史目标-0000'&&!state.runHistory.pending&&state.runHistory.dataPath===runsRequest());assert.equal(await page.locator('tr[data-run="'+a+'"]').count(),1);
  pass('全部任务统计进入含归档的完整列表并清除旧筛选，列表总数与统计一致');
  await H.switchSpace(page,config.other_workspace);await H.nav(page,'runs');await listReady();assert.equal(await page.locator('tr[data-run]').count(),0);assert.equal(await page.evaluate(()=>state.runVisibility),'active');
  assert.deepEqual(errors,[]);pass('全局搜索仍能找到并标识归档任务，切换空间不带入原范围或任务');
  fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({checks,errors,posts,layouts,roots:[a,b,c,d]},null,2));
 }catch(error){await page.screenshot({path:path.join(out,'failure.png'),animations:'disabled'}).catch(()=>{});fs.writeFileSync(path.join(out,'failure.json'),JSON.stringify({checks,errors,error:error.stack},null,2));throw error;}finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
