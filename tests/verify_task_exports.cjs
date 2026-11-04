'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{spawnSync}=require('node:child_process'),{chromium}=require('playwright'),H=require('./ui95_helpers.cjs');
const base=process.env.MESSAGE_EDITS_URL,out=process.env.MESSAGE_EDITS_OUTPUT;if(!base||!out)throw Error('Use isolated queue fixture');fs.mkdirSync(out,{recursive:true});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const python=(args)=>{const p=spawnSync(process.env.AGENT_TEST_PYTHON||'python3',args,{encoding:'utf8'});assert.equal(p.status,0,p.stderr);return JSON.parse(p.stdout);};
const inspect=file=>{const verified=python(['-m','agent_framework','verify-export',file]);assert(verified.valid);return python(['-c','import json,sys,zipfile\nwith zipfile.ZipFile(sys.argv[1]) as z:\n print(json.dumps({"manifest":json.loads(z.read("manifest.json")),"conversation":json.loads(z.read("conversation.json")),"edits":[json.loads(x) for x in z.read("edit-history.jsonl").splitlines()],"runs":[json.loads(x) for x in z.read("runs.jsonl").splitlines()]}))',file]);};
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1100},reducedMotion:'reduce'}),checks=[],errors=[],posts=[],layouts=[],downloads=[],exportRequests=[],documentByteChecks=[],focusChecks=[],pendingLayouts=[];
 page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(new URL(r.url()).pathname.endsWith('/export'))exportRequests.push({url:r.url(),at:Date.now()});if(r.method()==='POST')posts.push(new URL(r.url()).pathname);});page.on('download',d=>downloads.push(d));
 const config=JSON.parse(fs.readFileSync(path.join(out,'fixture.json'),'utf8')),[a,b]=config.roots,call=(url,data)=>page.evaluate(({url,data})=>api(url,data),{url,data}),pass=text=>{checks.push(text);console.log('PASS '+text);};let release;
 const ready=async id=>{await page.waitForFunction(id=>state.detail?.conversation?.id===id&&!state.busy,id);await H.settled(page);};
 const nav=async id=>{await H.nav(page,'runs',id);await ready(id);};
 const dialog=page.locator('#task-export-dialog'),open=async()=>{if(!await page.locator('#task-thread-properties').isVisible())await page.locator('[data-chat-properties]').click();await page.locator('#task-thread-properties [data-task-export]').click();await dialog.waitFor();};
 const download=async(name)=>{const event=page.waitForEvent('download');await page.locator('#task-export-download').click();const d=await event;assert.equal(d.suggestedFilename(),a+'-task-export.zip');const file=path.join(out,name+'.zip');await d.saveAs(file);await page.waitForFunction(()=>taskExportRequest?.complete&&!taskExportRequest.loading);return inspect(file);};
 const choose=async kind=>{await page.locator('#task-export-format').focus();await page.locator('#task-export-format').selectOption(kind);await page.waitForFunction(kind=>taskExportRequest?.kind===kind,kind);assert.equal(await page.evaluate(()=>document.activeElement.id),'task-export-format');};
 // Read a clone of the exact browser response: Playwright's response.body()
 // may re-fetch no-store attachments through Network.loadNetworkResource.
 const documentDownload=async(kind,name)=>{const extension=kind==='json'?'json':'md',count=await page.evaluate(()=>documentExportResponses.length),requests=exportRequests.length,event=page.waitForEvent('download');await page.locator('#task-export-download').click();const d=await event;assert.equal(d.suggestedFilename(),a+'-conversation.'+extension);const file=path.join(out,name+'.'+extension);await d.saveAs(file);const raw=fs.readFileSync(file),captured=await page.evaluate(()=>documentExportResponses);assert.equal(captured.length,count+1);assert.equal(exportRequests.length,requests+1);assert.deepEqual(raw,Buffer.from(captured[count].bytes));documentByteChecks.push({kind,bytes:raw.length,file:path.basename(file),exact:true,requests:1});await page.waitForFunction(()=>taskExportRequest?.complete&&!taskExportRequest.loading);return kind==='json'?JSON.parse(raw.toString('utf8')):raw.toString('utf8');};

 try{
  if(process.env.TASK_EXPORT_LEGACY)await page.route('**/task_export.js',route=>route.fulfill({contentType:'text/javascript',body:fs.readFileSync(process.env.TASK_EXPORT_LEGACY,'utf8')}));
  await page.goto(base+'/?workspace_id='+config.workspace+'#/runs/'+a);await ready(a);assert.equal(await page.evaluate(()=>state.workspaceId),config.workspace);await page.evaluate(()=>{window.documentExportResponses=[];const nativeFetch=fetch;window.fetch=async(...args)=>{const response=await nativeFetch(...args),url=String(args[0]);if(/\/export\?kind=(json|markdown)$/.test(url)&&response.ok){const bytes=Array.from(new Uint8Array(await response.clone().arrayBuffer()));documentExportResponses.push({url,bytes});}return response;};});
  await call('/api/tasks/'+a+'/messages/2/edit',{content:'周六 16 点开会','revision':0,request_id:'export-edit-1'});
  const content='周日 17 点开会\n议题：完整交付 😀 <img src=x onerror=alert(1)>';
  let detail=await call('/api/tasks/'+a+'/messages/2/edit',{content,revision:1,request_id:'export-edit-2'});
  await call('/api/tasks/'+a+'/messages/3/cancel',{revision:detail.detail.conversation.revision});await page.waitForFunction(()=>state.detail?.conversation?.turns[2].cancelled_queue);
  await page.locator('#task-chat-input').fill('未发送的后续要求');await page.locator('#chat-turn-2 [data-queue-edit]').click();await page.locator('#queue-edit-input').fill('未保存的排队编辑');await page.keyboard.press('Escape');const writes=posts.length;
  await open();assert.match(await dialog.innerText(),/未发送、未保存/);assert.equal(downloads.length,0);const first=await download('queued-task');
  assert.equal(first.manifest.snapshot.task_id,a);assert.equal(first.manifest.snapshot.turn_count,3);assert.equal(first.manifest.snapshot.run_count,1);assert.equal(first.manifest.snapshot.edit_count,2);
  assert.equal(first.conversation.turns[1].content,content);assert.equal(first.conversation.turns[2].status,'CANCELLED');assert.equal(first.edits[0].before,'周五 15 点开会');assert.equal(first.edits[1].after,content);assert.equal(first.runs[0].run.run_id,a);assert.equal(first.conversation.export_scope.workspace_id,config.workspace);
  assert(!JSON.stringify(first).includes('未发送的后续要求'));assert(!JSON.stringify(first).includes('未保存的排队编辑'));assert.match(await dialog.innerText(),/已交给浏览器下载/);await page.locator('#task-export-close').click();assert.equal(await page.locator('#task-chat-input').inputValue(),'未发送的后续要求');await page.locator('#chat-turn-2 [data-queue-edit]').click();assert.equal(await page.locator('#queue-edit-input').inputValue(),'未保存的排队编辑');await page.keyboard.press('Escape');assert.equal(posts.length,writes);
  pass('通过真实下载保存并离线校验完整任务包，含所有轮次和两次修改；排队、取消、未保存内容边界正确，两个草稿保留');

  const endpoint=base+'/api/tasks/'+a+'/export?kind=bundle';let fail=true;
  await page.route(endpoint,route=>fail?(fail=false,route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'模拟下载暂时不可用'})})):route.continue());
  await open();await page.locator('#task-export-download').click();await page.waitForFunction(()=>taskExportRequest?.error&&!taskExportRequest.loading);assert.match(await dialog.innerText(),/模拟下载暂时不可用/);assert.equal(downloads.length,1);assert.equal(await page.evaluate(()=>document.activeElement.id),'task-export-download');await download('retry-task');await page.unroute(endpoint);await page.locator('#task-export-close').click();
  pass('下载失败后显示具体原因并保留明确重试入口，重试只下载一次且键盘焦点可继续操作');

  const entered=deferred(),go=deferred(),delivered=deferred();release=go.resolve;
  await page.route(endpoint,async route=>{const response=await route.fetch();entered.resolve();await go.promise;await route.fulfill({response}).catch(()=>{});delivered.resolve();});
  await open();await page.locator('#task-export-download').click();await entered.promise;await nav(b);await open();go.resolve();await delivered.promise;await page.unroute(endpoint);release=null;await H.settled(page);assert.equal(await page.evaluate(()=>taskExportRequest.task),b);assert.equal(downloads.length,2);assert(!await page.evaluate(()=>taskExportRequest.complete));await page.locator('#task-export-close').click();
  pass('切换任务中止旧下载，迟到响应不会替新任务触发文件下载或成功提示');

  await nav(a);await call('/__test/release-queue',{});await page.waitForFunction(()=>state.detail?.conversation?.turns[1].status==='SUCCEEDED');await open();const finished=await download('completed-task');
  assert.equal(finished.manifest.snapshot.run_count,2);assert.equal(finished.manifest.snapshot.edit_count,2);assert.equal(finished.runs[1].run.task.goal,content);assert.equal(finished.runs[1].run.status,'SUCCEEDED');assert.equal(finished.conversation.turns[2].status,'CANCELLED');assert.equal(finished.edits[1].after,finished.runs[1].run.task.goal);
  await choose('json');assert(!await page.evaluate(()=>taskExportRequest.complete));const json=await documentDownload('json','conversation');assert.equal(json.id,a);assert.equal(json.turns.length,3);assert.equal(json.turns[1].content,content);assert.equal(json.turns[1].edit_revision,2);assert.equal(json.turns[2].status,'CANCELLED');assert.equal(json.export_snapshot.revision,json.revision);assert(!JSON.stringify(json).includes('未发送的后续要求'));assert(!JSON.stringify(json).includes('未保存的排队编辑'));assert.match(await dialog.innerText(),/不含完整修改历史/);
  await choose('markdown');const markdown=await documentDownload('markdown','conversation');assert(markdown.includes(content)&&markdown.includes('导出时间：')&&markdown.includes('（已取消排队，未执行）')); assert(!markdown.includes('未发送的后续要求')&&!markdown.includes('未保存的排队编辑'));assert.equal(await page.locator('#task-chat-input').inputValue(),'未发送的后续要求');
  pass('JSON 与 Markdown 可直接选择下载，文件名和响应字节完全一致，包含全部已保存轮次、取消状态及修改版本；草稿不进入文件');

  await page.locator('#task-export-close').click();await page.locator('#task-thread-properties [data-task-conversation-export]').click();await dialog.waitFor();assert.equal(await page.locator('#task-export-format').inputValue(),'markdown');const docEndpoint=base+'/api/tasks/'+a+'/export?kind=markdown',docEntered=deferred(),docGo=deferred();release=docGo.resolve;let docRequests=0;
  await page.route(docEndpoint,async route=>{docRequests++;docEntered.resolve();await docGo.promise;await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'文档下载暂时不可用'})});});
  await page.locator('#task-export-download').click();await docEntered.promise;assert(await page.locator('#task-export-format').isDisabled());await page.locator('#task-export-download').dispatchEvent('click');assert.equal(docRequests,1);const priorDownloads=downloads.length;docGo.resolve();await page.waitForFunction(()=>!!taskExportRequest?.error&&!taskExportRequest.loading);release=null;assert.equal(downloads.length,priorDownloads);assert.match(await dialog.innerText(),/文档下载暂时不可用/);assert.equal(await page.locator('#task-export-format').inputValue(),'markdown');assert.equal(await page.evaluate(()=>document.activeElement.id),'task-export-download');await page.unroute(docEndpoint);await documentDownload('markdown','retry-document');
  await choose('json');const jsonEndpoint=base+'/api/tasks/'+a+'/export?kind=json';await page.route(jsonEndpoint,route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({id:'wrong-task',turns:[]})}));const beforeInvalid=downloads.length;await page.locator('#task-export-download').click();await page.waitForFunction(()=>!!taskExportRequest?.error&&!taskExportRequest.loading);assert.equal(downloads.length,beforeInvalid);assert.match(await dialog.innerText(),/记录不完整|编号不一致/);await page.unroute(jsonEndpoint);await documentDownload('json','retry-json');
  pass('原对话入口默认 Markdown，准备中固定格式且重复点击不重发；文档失败可原格式重试，错误任务的 JSON 不会落盘');

  for(const [kind,location,failure] of [['bundle','footer',false],['markdown','header',false],['json','footer',true],['bundle','header',true]]){
   await choose(kind);const endpoint=base+'/api/tasks/'+a+'/export?kind='+kind,entered=deferred(),go=deferred();release=go.resolve;
   let requests=0;const before=downloads.length,requestCount=exportRequests.length,responseCount=await page.evaluate(()=>documentExportResponses.length),event=failure?null:page.waitForEvent('download');event?.catch(()=>{});
   await page.route(endpoint,async route=>{requests++;const response=failure?null:await route.fetch();entered.resolve();await go.promise;if(failure)await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'键盘下载恢复测试'})}).catch(()=>{});else await route.fulfill({response}).catch(()=>{});});
   await page.locator('#task-export-download').focus();await page.keyboard.press('Enter');await entered.promise;
   assert.equal(await page.evaluate(()=>document.activeElement.id),'task-export-download');
   assert.equal(await page.locator('#task-export-download').getAttribute('aria-disabled'),'true');
   await page.keyboard.press('Enter');await page.keyboard.press('Space');assert.equal(requests,1);
   if(!focusChecks.length){
    for(const [theme,width,scale] of [['light',1440,1],['dark',1024,2]]){
     await page.setViewportSize({width,height:1100});await page.evaluate(({theme,scale})=>{document.documentElement.dataset.theme=theme;document.documentElement.dataset.exportScale=scale;if(!window.exportFontRule){document.styleSheets[0].insertRule('html[data-export-scale="2"] #task-export-dialog :is(p,li,button,label,select){font-size:28px!important}',0);window.exportFontRule=true;}},{theme,scale});
     const bounds=await page.locator('#task-export-download').evaluate(el=>{const r=el.getBoundingClientRect(),body=el.closest('dialog').querySelector('.dialog-body');return {focused:document.activeElement===el,left:r.left,right:r.right,top:r.top,bottom:r.bottom,font:parseFloat(getComputedStyle(el).fontSize),scroll:body.scrollWidth,bodyWidth:body.clientWidth,root:document.documentElement.scrollWidth};});
     assert(bounds.focused&&bounds.root<=width+1&&bounds.left>=0&&bounds.right<=width+1&&bounds.top>=0&&bounds.bottom<=1100&&bounds.scroll<=bounds.bodyWidth+1,JSON.stringify(bounds));if(scale===2)assert.equal(bounds.font,28);
     pendingLayouts.push({theme,width,scale,bounds});await page.screenshot({path:path.join(out,'task-export-pending-'+theme+'.png'),animations:'disabled'});
    }
    await page.setViewportSize({width:1440,height:1100});await page.evaluate(()=>{document.documentElement.dataset.theme='light';document.documentElement.dataset.exportScale=1;});
   }
   // Reverse through the dialog's controls instead of assuming that Tab from
   // its last control never visits the browser's own chrome.
   await page.keyboard.press('Shift+Tab');if(location==='header')await page.keyboard.press('Shift+Tab');const target=location==='footer'?'task-export-close':'task-export-dismiss';
   assert.equal(await page.evaluate(()=>document.activeElement.id),target);
   go.resolve();await page.waitForFunction(()=>taskExportRequest&&!taskExportRequest.loading);release=null;
   assert.equal(await page.evaluate(()=>document.activeElement.id),target);assert.equal(downloads.length,before+(failure?0:1));assert.equal(exportRequests.length,requestCount+1);
   if(failure)assert.match(await dialog.innerText(),/键盘下载恢复测试/);
   else{
    const d=await event,extension=kind==='bundle'?'zip':'md',file=path.join(out,'focus-'+kind+'-'+location+'.'+extension);await d.saveAs(file);
    if(kind==='bundle')assert.equal(inspect(file).manifest.snapshot.task_id,a);
    else{const captured=await page.evaluate(()=>documentExportResponses);assert.equal(captured.length,responseCount+1);const raw=fs.readFileSync(file);assert.deepEqual(raw,Buffer.from(captured[responseCount].bytes));documentByteChecks.push({kind,bytes:raw.length,file:path.basename(file),exact:true,requests:1});}
   }
   focusChecks.push({kind,location,failure,requests,focus:target});await page.unroute(endpoint);
  }
  pass('键盘下载准备期间保留焦点，Enter 和空格不会重复下载；Tab 可移到关闭按钮，成功或失败后仍留在用户选择的位置');

  for(const kind of ['bundle','markdown','json']){await choose(kind);for(const theme of ['light','dark'])for(const width of [1024,1440])for(const scale of [1,2]){
   await page.setViewportSize({width,height:1100});await page.evaluate(({theme,scale})=>{document.documentElement.dataset.theme=theme;document.documentElement.dataset.exportScale=scale;if(!window.exportFontRule){document.styleSheets[0].insertRule('html[data-export-scale="2"] #task-export-dialog :is(p,li,button,label,select){font-size:28px!important}',0);window.exportFontRule=true;}},{theme,scale});
   const bounds=await page.locator('#task-export-download').evaluate(el=>{el.focus();const r=el.getBoundingClientRect(),d=el.closest('dialog'),body=d.querySelector('.dialog-body'),p=body.querySelector('p');return {root:document.documentElement.scrollWidth,width:innerWidth,left:r.left,right:r.right,top:r.top,bottom:r.bottom,font:parseFloat(getComputedStyle(el).fontSize),bodyFont:parseFloat(getComputedStyle(p).fontSize),scroll:body.scrollWidth,bodyWidth:body.clientWidth,focused:document.activeElement===el};});
   assert(bounds.focused&&bounds.root<=width+1&&bounds.left>=0&&bounds.right<=width+1&&bounds.top>=0&&bounds.bottom<=1100&&bounds.scroll<=bounds.bodyWidth+1,JSON.stringify(bounds));if(scale===2){assert.equal(bounds.font,28);assert.equal(bounds.bodyFont,28);}layouts.push({kind,theme,width,scale,bounds});
   if(width===1440&&scale===1){await dialog.locator('.dialog-body').evaluate(el=>el.scrollTop=0);await page.screenshot({path:path.join(out,'task-export-'+(kind==='bundle'?'':kind+'-')+theme+'.png'),animations:'disabled'});}
  }}
  await page.setViewportSize({width:1440,height:1100});await page.evaluate(()=>document.documentElement.dataset.exportScale=1);await page.locator('#task-export-close').click();assert.equal(await page.locator('#task-chat-input').inputValue(),'未发送的后续要求');assert.equal(posts.length,writes+1);
  pass('执行后重新下载包含真实采用的修改内容和完整执行记录；三种格式共 24 种主题、宽度及正常/28px 字号检查通过，下载没有写请求');
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({checks,errors,posts,layouts,pendingLayouts,documentByteChecks,focusChecks,exportRequests,downloads:downloads.length},null,2));
 }catch(error){await page.screenshot({path:path.join(out,'failure.png'),animations:'disabled'}).catch(()=>{});fs.writeFileSync(path.join(out,'failure.json'),JSON.stringify({checks,errors,error:error.stack},null,2));throw error;}finally{release?.();await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
