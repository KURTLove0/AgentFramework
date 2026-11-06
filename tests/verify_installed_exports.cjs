'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {spawnSync}=require('node:child_process'),{chromium}=require('playwright'),H=require('./ui95_helpers.cjs');
const base=process.env.INSTALLED_EXPORT_URL,out=process.env.INSTALLED_EXPORT_OUTPUT,python=process.env.INSTALLED_EXPORT_PYTHON;
if(!base||!out||!python)throw Error('Use verify_release.py --browser-check with an installed environment');
const config=JSON.parse(fs.readFileSync(path.join(out,'fixture.json'),'utf8')),[a,b]=config.roots;
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function installed(args,expected=0){
 const result=spawnSync(python,['-I',...args],{encoding:'utf8',timeout:15000});
 assert.equal(result.status,expected,result.error?.message||result.stderr);return result;
}
const packageOrigin=JSON.parse(installed(['-c','import json,sys\nfrom pathlib import Path\nimport agent_framework,agent_framework.task_exports\nprefix=Path(sys.prefix).resolve()\nmodule=Path(agent_framework.task_exports.__file__).resolve()\nassert module.is_relative_to(prefix)\nprint(json.dumps({"prefix":str(prefix),"module":str(module),"version":agent_framework.__version__}))']).stdout);
function inspect(file){
 const verified=JSON.parse(installed(['-m','agent_framework','verify-export',file]).stdout);assert.equal(verified.valid,true);
 return JSON.parse(installed(['-c','import json,sys,zipfile\nwith zipfile.ZipFile(sys.argv[1]) as z:\n print(json.dumps({"manifest":json.loads(z.read("manifest.json")),"conversation":json.loads(z.read("conversation.json")),"runs":[json.loads(line) for line in z.read("runs.jsonl").splitlines()],"edits":z.read("edit-history.jsonl").decode(),"contains_unsent":any("只留在输入框中的独立草稿".encode() in z.read(name) for name in z.namelist())}))',file]).stdout);
}
const signature=view=>({id:view.id,revision:view.revision,status:view.status,task_name:view.task_name,archive:view.archive,
 turns:view.turns.map(t=>({number:t.number,run_id:t.run_id,content:t.content,status:t.status,reply:t.reply,checkpoint_version:t.checkpoint_version,event_seq:t.event_seq,edit_revision:t.edit_revision}))});
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1100},reducedMotion:'reduce'});
 const checks=[],errors=[],posts=[],requests=[],downloads=[],files=[],layouts=[],pendingLayouts=[],focusChecks=[];let release=null,expected;
 page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));page.on('download',d=>downloads.push(d));
 page.on('request',r=>{if(r.method()==='POST')posts.push(new URL(r.url()).pathname);if(new URL(r.url()).pathname.endsWith('/export'))requests.push(r.url());});
 await page.addInitScript(()=>{
  const original=fetch;window.exportResponses=[];window.ignoreExportAbort=false;
  window.fetch=async(input,options)=>{
   const url=new URL(typeof input==='string'?input:input.url,location.href),isExport=/\/api\/tasks\/[^/]+\/export$/.test(url.pathname);
   const response=await original(input,isExport&&ignoreExportAbort?{...options,signal:undefined}:options);
   if(isExport&&response.ok)exportResponses.push({url:url.href,bytes:Array.from(new Uint8Array(await response.clone().arrayBuffer()))});
   return response;
  };
 });
 const pass=text=>{checks.push(text);console.log('PASS '+text);},call=url=>page.evaluate(url=>api(url),url);
 const ready=async id=>{await page.waitForFunction(id=>state.detail?.conversation?.id===id&&!state.busy,id);await H.settled(page);};
 const nav=async id=>{await H.nav(page,'runs',id);await ready(id);};
 const dialog=page.locator('#task-export-dialog');
 const open=async()=>{if(!await page.locator('#task-thread-properties').isVisible())await page.locator('[data-chat-properties]').click();await page.locator('#task-thread-properties [data-task-export]').click();await dialog.waitFor();};
 const choose=async kind=>{await page.locator('#task-export-format').selectOption(kind);await page.waitForFunction(kind=>taskExportRequest?.kind===kind,kind);};
 const counts=async()=>({responses:await page.evaluate(()=>exportResponses.length),requests:requests.length});
 const assertView=view=>{assert.deepEqual(signature(view),signature(expected.conversation));assert.equal(view.export_snapshot.revision,view.revision);assert(Number.isFinite(view.export_snapshot.captured_at));};
 async function save(download,kind,name,before){
  const suffix=kind==='bundle'?'-task-export.zip':'-conversation.'+(kind==='json'?'json':'md');assert.equal(download.suggestedFilename(),a+suffix);
  const file=path.join(out,name+path.extname(suffix));await download.saveAs(file);await page.waitForFunction(()=>taskExportRequest?.complete&&!taskExportRequest.loading);
  const captured=await page.evaluate(()=>exportResponses),raw=fs.readFileSync(file);assert.equal(captured.length,before.responses+1);assert.equal(requests.length,before.requests+1);
  assert.equal(captured[before.responses].url,base+'/api/tasks/'+a+'/export?kind='+kind);assert.deepEqual(raw,Buffer.from(captured[before.responses].bytes));
  if(kind==='bundle'){
   const value=inspect(file);assertView(value.conversation);assert.equal(value.manifest.scope.workspace_id,config.workspace);
   assert.equal(value.manifest.snapshot.turn_count,2);assert.equal(value.manifest.snapshot.run_count,2);assert.equal(value.manifest.snapshot.edit_count,0);assert.equal(value.edits,'');assert.equal(value.contains_unsent,false);
   assert.deepEqual(value.runs.map(r=>r.run.task.goal),config.contents);assert(value.runs.every(r=>r.run.status==='SUCCEEDED'));
  }else if(kind==='json')assertView(JSON.parse(raw.toString('utf8')));
  else{
   const text=raw.toString('utf8');assert(text.includes(config.name)&&text.includes('导出时间：'));
   for(const turn of expected.conversation.turns){assert(text.includes(turn.content));assert.equal(typeof turn.reply.content,'string');assert(text.includes(turn.reply.content));}
  }
  assert(!raw.includes(Buffer.from('只留在输入框中的独立草稿')));
  files.push({file:path.basename(file),kind,bytes:raw.length,sha256:crypto.createHash('sha256').update(raw).digest('hex'),exact_response_bytes:true,requests:1});return file;
 }
 async function download(kind,name){
  await choose(kind);const before=await counts(),event=page.waitForEvent('download');event.catch(()=>{});
  await page.locator('#task-export-download').focus();await page.keyboard.press('Enter');return save(await event,kind,name,before);
 }
 async function layout(pending){
  for(const theme of ['light','dark'])for(const width of [1024,1440])for(const scale of [1,2]){
   await page.setViewportSize({width,height:1100});await page.evaluate(({theme,scale})=>{document.documentElement.dataset.theme=theme;document.documentElement.dataset.installedExportScale=scale;if(!window.installedExportRule){document.styleSheets[0].insertRule('html[data-installed-export-scale="2"] #task-export-dialog :is(p,li,button,label,select){font-size:28px!important}',0);window.installedExportRule=true;}},{theme,scale});
   const bounds=await page.locator('#task-export-download').evaluate(el=>{el.focus();const r=el.getBoundingClientRect(),body=el.closest('dialog').querySelector('.dialog-body');return {focused:document.activeElement===el,left:r.left,right:r.right,top:r.top,bottom:r.bottom,font:parseFloat(getComputedStyle(el).fontSize),root:document.documentElement.scrollWidth,scroll:body.scrollWidth,bodyWidth:body.clientWidth};});
   assert(bounds.focused&&bounds.left>=0&&bounds.right<=width+1&&bounds.top>=0&&bounds.bottom<=1100&&bounds.root<=width+1&&bounds.scroll<=bounds.bodyWidth+1,JSON.stringify(bounds));if(scale===2)assert.equal(bounds.font,28);
   (pending?pendingLayouts:layouts).push({theme,width,scale,bounds});
   if(width===1024&&scale===2)await page.screenshot({path:path.join(out,'installed-export-'+(pending?'pending-':'ready-')+theme+'.png'),animations:'disabled'});
  }
  await page.setViewportSize({width:1440,height:1100});await page.evaluate(()=>document.documentElement.dataset.installedExportScale=1);
 }
 try{
  await page.goto(base+'/?workspace_id='+config.workspace+'#/runs/'+a);await ready(a);assert.equal(await page.evaluate(()=>state.workspaceId),config.workspace);
  expected=await call('/api/tasks/'+a);assert.equal(expected.conversation.task_name.name,config.name);assert.equal(expected.conversation.archive.archived,true);
  assert.deepEqual(expected.conversation.turns.map(t=>t.content),config.contents);assert.equal(expected.conversation.turns.length,2);assert(expected.conversation.turns.every(t=>t.status==='SUCCEEDED'&&t.reply));
  await page.locator('#task-chat-input').fill('只留在输入框中的独立草稿');await open();assert.equal(downloads.length,0);
  pass('正式安装服务通过公开接口创建两轮已完成对话，名称和归档状态可读；校验器来自安装虚拟环境');

  const bundle=await download('bundle','complete-task');await download('json','conversation');await download('markdown','conversation');await choose('bundle');await layout(false);
  pass('ZIP、JSON、Markdown 实际落盘并逐字节对应本次响应；两轮完整原文和回复、名称、归档及快照边界一致');

  const endpoint=base+'/api/tasks/'+a+'/export?kind=bundle',entered=deferred(),go=deferred();release=go.resolve;
  await page.route(endpoint,async route=>{const response=await route.fetch();entered.resolve();await go.promise;await route.fulfill({response}).catch(()=>{});});
  const before=await counts(),event=page.waitForEvent('download');event.catch(()=>{});await page.locator('#task-export-download').focus();await page.keyboard.press('Enter');await entered.promise;
  assert.equal(await page.evaluate(()=>document.activeElement.id),'task-export-download');assert.equal(await page.locator('#task-export-download').getAttribute('aria-disabled'),'true');
  await page.keyboard.press('Enter');await page.keyboard.press('Space');assert.equal(requests.length,before.requests+1);await layout(true);
  await page.keyboard.press('Shift+Tab');assert.equal(await page.evaluate(()=>document.activeElement.id),'task-export-cancel');await page.keyboard.press('Shift+Tab');assert.equal(await page.evaluate(()=>document.activeElement.id),'task-export-close');await page.keyboard.press('Shift+Tab');assert.equal(await page.evaluate(()=>document.activeElement.id),'task-export-dismiss');
  go.resolve();await save(await event,'bundle','keyboard-task',before);release=null;assert.equal(await page.evaluate(()=>document.activeElement.id),'task-export-dismiss');await page.unroute(endpoint);
  focusChecks.push({outcome:'success',target:'task-export-dismiss',requests:1});
  pass('安装后的等待按钮保留焦点，重复 Enter/空格不重发；成功后保留顶部关闭焦点，16 组就绪与等待布局通过');

  for(const [kind,body,status] of [['markdown',{error:'安装后导出暂时不可用'},503],['json',{id:'wrong-task',turns:[]},200]]){
   await choose(kind);const url=base+'/api/tasks/'+a+'/export?kind='+kind,held=deferred(),respond=deferred();release=respond.resolve;
   await page.route(url,async route=>{held.resolve();await respond.promise;await route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)}).catch(()=>{});});
   const count=downloads.length,requestCount=requests.length;await page.locator('#task-export-download').focus();await page.keyboard.press('Enter');await held.promise;
   await page.keyboard.press('Shift+Tab');assert.equal(await page.evaluate(()=>document.activeElement.id),'task-export-cancel');await page.keyboard.press('Shift+Tab');assert.equal(await page.evaluate(()=>document.activeElement.id),'task-export-close');respond.resolve();await page.waitForFunction(()=>!!taskExportRequest?.error&&!taskExportRequest.loading);release=null;
   assert.equal(await page.evaluate(()=>document.activeElement.id),'task-export-close');assert.equal(downloads.length,count);assert.equal(requests.length,requestCount+1);
   assert.match(await dialog.innerText(),kind==='markdown'?/安装后导出暂时不可用/:/记录不完整|编号不一致/);await page.unroute(url);await download(kind,'retry-'+kind);
   focusChecks.push({kind,outcome:'failure',target:'task-export-close',requests:1});
  }
  pass('503 和错误任务 JSON 均保留原因与关闭焦点，不生成文件；明确重试按原格式取得完整内容');

  await choose('bundle');const waiting=deferred(),finish=deferred(),delivered=deferred();release=finish.resolve;const stale=await counts(),downloadCount=downloads.length;
  await page.evaluate(()=>ignoreExportAbort=true);await page.route(endpoint,async route=>{const response=await route.fetch();waiting.resolve();await finish.promise;await route.fulfill({response}).catch(()=>{});delivered.resolve();});
  await page.locator('#task-export-download').click();await waiting.promise;await nav(b);await open();await page.locator('#task-export-format').focus();finish.resolve();await delivered.promise;
  await page.waitForFunction(count=>exportResponses.length===count+1,stale.responses);await H.settled(page);release=null;await page.unroute(endpoint);await page.evaluate(()=>ignoreExportAbort=false);
  assert.equal(await page.evaluate(()=>taskExportRequest.task),b);assert.equal(await page.evaluate(()=>taskExportRequest.complete),false);assert.equal(await page.evaluate(()=>document.activeElement.id),'task-export-format');assert.equal(downloads.length,downloadCount);
  pass('切换任务后，即使模拟传输忽略取消并迟到返回，也不下载旧文件或改变新窗口的焦点');

  const damaged=path.join(out,'intentionally-damaged-task.zip');installed(['-c','import sys,zipfile\nwith zipfile.ZipFile(sys.argv[1]) as source,zipfile.ZipFile(sys.argv[2],"w") as target:\n for name in source.namelist():\n  raw=source.read(name)\n  target.writestr(name,raw+b" " if name=="conversation.json" else raw)',bundle,damaged]);
  const rejected=installed(['-m','agent_framework','verify-export',damaged],1);assert.match(rejected.stderr,/哈希|hash|SHA|摘要|校验|大小|长度/);
  pass('安装后的 CLI 接受完整任务包，并明确拒绝正文被改动但清单未更新的副本');

  await page.locator('#task-export-close').click();await nav(a);assert.equal(await page.locator('#task-chat-input').inputValue(),'只留在输入框中的独立草稿');
  const after=await call('/api/tasks/'+a);assert.deepEqual(after.run,expected.run);assert.deepEqual(signature(after.conversation),signature(expected.conversation));assert.equal((await call('/api/runs')).counts.total,2);
  assert.deepEqual(posts,[]);assert.deepEqual(errors,[]);assert.equal(downloads.length,6);
  pass('导出和失败恢复不发送写请求，不改写历史、名称或归档；切换回来仍保留未发送草稿');
  fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({checks,errors,packageOrigin,files,downloads:downloads.length,posts,requests,layouts,pendingLayouts,focusChecks,damaged_copy_rejected:true},null,2));
 }catch(error){await page.screenshot({path:path.join(out,'failure.png'),animations:'disabled'}).catch(()=>{});fs.writeFileSync(path.join(out,'failure.json'),JSON.stringify({checks,errors,files,error:error.stack},null,2));throw error;}
 finally{release?.();await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
