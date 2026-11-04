'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process'),{chromium}=require('playwright'),{waitFor}=require('./browser_poll.cjs');
const base=process.env.RUN_INSPECTOR_URL,out=process.env.RUN_INSPECTOR_OUTPUT;if(!base||!out)throw Error('Use the run-inspector fixture.');fs.mkdirSync(out,{recursive:true});
const defer=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1100},reducedMotion:'reduce'}),checks=[],errors=[],layouts=[];let release;
 page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>{const interval=setInterval;window.__inspectorPolls=[];window.setInterval=(fn,delay,...args)=>{const id=interval(fn,delay,...args);if(delay===1500)window.__inspectorPolls.push(id);return id;};});
 const call=(url,data)=>page.evaluate(({url,data})=>api(url,data),{url,data}),pass=s=>{checks.push(s);console.log('PASS '+s);};
 const nav=async id=>{await page.evaluate(id=>navigate('runs',id),id);await page.waitForFunction(id=>state.detail?.conversation?.id===id&&!state.busy,id);};
 const settled=async(id,n)=>waitFor(async()=>{const d=await call('/api/tasks/'+id);return d.conversation.turns[n-1]?.status==='SUCCEEDED'&&!d.conversation.current.job?.active;},'Task did not settle');
 const dialog=page.locator('#task-chat-run-dialog'),open=async number=>{await page.locator('[data-chat-turn="'+number+'"] .chat-answer-actions [data-chat-inspect-run]').click();await dialog.waitFor({state:'visible'});};
 const readDone=()=>page.waitForFunction(()=>runInspector&&!runInspector.loading),refresh=async()=>{await page.locator('[data-run-inspector-refresh]').click();await readDone();};
 try{
  await page.goto(base);await page.waitForFunction(()=>state.connected&&!state.busy);await page.evaluate(()=>window.__inspectorPolls.forEach(clearInterval));
  const originalWorkspace=await page.evaluate(()=>state.workspaceId),agent=await call('/api/agents',{name:'运行记录核对助手',description:'合成记录读取验收',runtime:'mock',model:'builtin',options:{},prompt:'整理本轮结果。',skills:[],mcp_servers:[],revision:0});
  const first=await call('/api/tasks',{goal:'第一项任务的运行记录',agent_id:agent.id,agent_revision:1,request_id:'inspector-first'}),a=first.run.run_id;await settled(a,1);
  await call('/api/tasks/'+a+'/messages',{content:'第二轮需要独立核对与导出',request_id:'inspector-followup',revision:1});await settled(a,2);const child=(await call('/api/tasks/'+a)).conversation.turns[1].run_id;
  const second=await call('/api/tasks',{goal:'另一项任务的运行记录',agent_id:agent.id,agent_revision:1,request_id:'inspector-second'}),b=second.run.run_id;await settled(b,1);await nav(a);await page.locator('#task-chat-input').fill('查看记录时保留的草稿');
  await page.route(base+'/api/runs/'+child,route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'合成读取失败'})}),{times:1});
  await open(2);await dialog.getByText('合成读取失败',{exact:true}).waitFor();assert.equal(await dialog.locator('a[download]').count(),0);await refresh();assert.equal(await page.evaluate(()=>taskChatUI.inspected.run.run_id),child);assert.equal(await dialog.locator('#run-inspector-title').textContent(),'第 2 轮运行记录');
  const readAt=await page.evaluate(()=>runInspector.readAt);await page.route(base+'/api/runs/'+child,route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'合成刷新失败'})}),{times:1});await refresh();await dialog.getByText('仍显示上次成功读取的记录，可重试更新。',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>runInspector.readAt),readAt);assert(await dialog.locator('.runtime-process').isVisible());
  pass('读取失败在原窗口内可重试；刷新失败保留原记录和读取时间，并明确标注保留内容');

  await page.route('**/__inspector-text.css',route=>route.fulfill({status:200,contentType:'text/css',body:'html[data-inspector-scale="2"] #task-chat-run-dialog :is(h2,p,button,a,summary){font-size:28px!important;line-height:1.5!important}'}));
  await page.evaluate(url=>new Promise((resolve,reject)=>{const link=document.createElement('link');link.rel='stylesheet';link.href=url;link.onload=resolve;link.onerror=reject;document.head.append(link);}),base+'/__inspector-text.css');
  for(const theme of ['light','dark'])for(const width of [1024,1440])for(const scale of [1,2]){
   await page.setViewportSize({width,height:1100});await page.evaluate(({theme,scale})=>{const s=document.querySelector('#appearance-select');s.value=theme;s.dispatchEvent(new Event('change',{bubbles:true}));document.documentElement.dataset.inspectorScale=String(scale);},{theme,scale});
   const button=page.locator('[data-run-inspector-refresh]');await button.focus();await button.scrollIntoViewIfNeeded();
   const bounds=await button.evaluate(el=>{const r=el.getBoundingClientRect(),d=el.closest('dialog');return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,root:document.documentElement.scrollWidth,width:innerWidth,dialogScroll:d.scrollWidth,dialogClient:d.clientWidth,font:parseFloat(getComputedStyle(el).fontSize),focused:document.activeElement===el};});
   assert(bounds.root<=width+1&&bounds.dialogScroll<=bounds.dialogClient+1&&bounds.left>=0&&bounds.right<=width+1&&bounds.top>=0&&bounds.bottom<=1101);assert(bounds.focused&&bounds.font>=14*scale);layouts.push({theme,width,scale,bounds});
   if(width===1440&&scale===1)await page.screenshot({path:path.join(out,'run-inspector-'+theme+'.png'),animations:'disabled'});
  }
  await page.evaluate(()=>delete document.documentElement.dataset.inspectorScale);await refresh();
  pass('浅深主题、1024/1440 宽度及两倍文字下，重试入口可聚焦、可到达且无横向溢出');
  const href=await dialog.locator('a[download]').getAttribute('href');assert(href.includes('/'+child+'/download?'));assert(href.endsWith('workspace_id='+encodeURIComponent(originalWorkspace)));
  const downloading=page.waitForEvent('download');await dialog.locator('a[download]').click();const download=await downloading,file=path.join(out,'second-turn.zip');await download.saveAs(file);
  const verified=spawnSync(process.env.AGENT_TEST_PYTHON||'python3',['-m','agent_framework','verify-export',file],{encoding:'utf8'});assert.equal(verified.status,0,verified.stderr);const manifest=JSON.parse(verified.stdout).manifest;assert.equal(manifest.snapshot.run_id,child);assert.equal(manifest.snapshot.status,'SUCCEEDED');
  pass('下载绑定刚刚查看的轮次与工作空间，实际记录包校验通过且属于第二轮运行');

  await page.keyboard.press('Escape');assert.equal(await page.locator('#task-chat-input').inputValue(),'查看记录时保留的草稿');
  const entered=defer(),gate=defer();release=gate.resolve;await page.route(base+'/api/runs/'+child,async route=>{entered.resolve();await gate.promise;await route.continue();});
  await open(2);await entered.promise;await page.evaluate(()=>window.__oldInspector=runInspector);assert(await dialog.getByText('正在读取本轮运行记录…',{exact:true}).isVisible());await page.keyboard.press('Escape');await nav(b);gate.resolve();await page.waitForFunction(()=>!window.__oldInspector.loading);await page.unroute(base+'/api/runs/'+child);release=null;
  assert(!(await dialog.isVisible()));assert.equal(await page.evaluate(()=>state.detail.conversation.id),b);assert.equal(await page.evaluate(()=>taskChatUI.inspected),null);
  pass('慢读取期间关闭窗口并切换任务，旧响应不会重新打开窗口或覆盖当前任务');

  await nav(a);await open(2);await readDone();await page.route(base+'/api/runs/'+child,route=>route.fulfill({status:403,contentType:'application/json',body:JSON.stringify({error:'合成访问范围已变化'})}),{times:1});await refresh();assert.equal(await dialog.locator('.runtime-process').count(),0);assert.equal(await dialog.locator('a[download]').count(),0);assert.equal(await page.evaluate(()=>taskChatUI.inspected),null);await page.keyboard.press('Escape');
  const space=await call('/api/workspaces',{name:'记录核对另一个空间',description:'','business':'合成验收','scenario':'范围隔离','revision':0});await page.evaluate(()=>loadWorkspaces());const entered2=defer(),gate2=defer(),finished2=defer();release=gate2.resolve;
  await page.route(base+'/api/runs/'+child,async route=>{const response=await route.fetch();entered2.resolve();await gate2.promise;await route.fulfill({response}).catch(()=>{});finished2.resolve();});await open(2);await entered2.promise;
  const changed=page.waitForURL(url=>url.searchParams.get('workspace_id')===space.id);await page.evaluate(id=>void switchWorkspace(id),space.id);await changed;await page.waitForFunction(id=>state.connected&&!state.busy&&state.workspaceId===id,space.id);gate2.resolve();await finished2.promise;await page.unroute(base+'/api/runs/'+child);release=null;
  assert.equal(await page.evaluate(()=>state.workspaceId),space.id);assert(!(await dialog.isVisible()));assert.equal(await page.evaluate(()=>taskChatUI.inspected),null);
  pass('访问失效时移除旧内容与下载；真实切换空间后，原空间的迟到读取不能恢复窗口');
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({checks,errors,layouts,download:{run_id:child,workspace:originalWorkspace,verified:true}},null,2));
 }catch(error){await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});fs.writeFileSync(path.join(out,'failure.json'),JSON.stringify({checks,errors,error:error.stack,text:await page.locator('body').innerText()},null,2));throw error;}
 finally{release?.();await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
