'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{chromium}=require('playwright'),H=require('./ui95_helpers.cjs');
const base=process.env.MESSAGE_EDITS_URL,out=process.env.MESSAGE_EDITS_OUTPUT;if(!base||!out)throw Error('Use isolated queue fixture');fs.mkdirSync(out,{recursive:true});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true}),context=await browser.newContext({viewport:{width:1440,height:1100},permissions:['clipboard-read','clipboard-write'],reducedMotion:'reduce'}),page=await context.newPage(),other=await context.newPage(),checks=[],errors=[],posts=[],layouts=[];
 const config=JSON.parse(fs.readFileSync(path.join(out,'fixture.json'),'utf8')),[a,b,c]=config.roots,call=(p,url,data)=>p.evaluate(({url,data})=>api(url,data),{url,data}),pass=text=>{checks.push(text);console.log('PASS '+text);};let release;
 for(const p of [page,other]){p.setDefaultTimeout(15000);p.on('pageerror',e=>errors.push(e.message));p.on('request',r=>{if(r.method()==='POST')posts.push({path:new URL(r.url()).pathname,body:r.postDataJSON()});});}
 const ready=async(p,id)=>{await p.waitForFunction(id=>state.detail?.conversation?.id===id&&!state.busy,id);await H.settled(p);};
 const nav=async(p,id)=>{await H.nav(p,'runs',id);await ready(p,id);};
 const open=async()=>{await page.locator('#chat-turn-2 [data-queue-edit]').click();await page.locator('#queue-edit-dialog').waitFor();};
 const saved=async(text)=>{await page.locator('#queue-edit-dialog').waitFor({state:'hidden'});await page.waitForFunction(text=>state.detail.conversation.turns[1].content===text,text);};
 try{
  await page.goto(base+'/?workspace='+config.workspace+'#/runs/'+a);await ready(page,a);await other.goto(base+'/?workspace='+config.workspace+'#/runs/'+a);await ready(other,a);
  const before=await call(page,'/api/tasks/'+a);await page.locator('#task-chat-input').fill('后续对话草稿独立保留');await open();await page.locator('#queue-edit-input').fill('周六 16 点开会');await page.locator('#queue-edit-save').click();await saved('周六 16 点开会');
  const changed=await call(page,'/api/tasks/'+a);assert.equal(changed.conversation.turns[1].run_id,before.conversation.turns[1].run_id);assert.equal(changed.conversation.turns[2].content,'随后整理会议记录');assert.equal(await page.locator('#task-chat-input').inputValue(),'后续对话草稿独立保留');assert.equal((await call(page,'/api/tasks/'+a+'/message-submissions/queued-first')).submission.content,'周五 15 点开会');
  pass('修改保持队列位置、运行身份与后续消息，原发送回执和未发送对话草稿保留');

  await open();await page.locator('#queue-edit-input').fill('周日 17 点开会');const endpoint=base+'/api/tasks/'+a+'/messages/2/edit',entered=deferred(),go=deferred();release=go.resolve;
  await page.route(endpoint,async route=>{if(route.request().method()==='POST'){entered.resolve();await go.promise;}return route.continue();});await page.locator('#queue-edit-save').click();await entered.promise;
  await call(other,'/api/tasks/'+a+'/messages/2/edit',{content:'另一页面改为周一','revision':1,'request_id':'other-edit'});go.resolve();await page.locator('#queue-edit-review').waitFor();await page.unroute(endpoint);release=null;assert.equal(await page.locator('#queue-edit-input').inputValue(),'周日 17 点开会');const writesBeforeReview=posts.length;
  await page.locator('#queue-edit-review').click();await page.locator('#queue-edit-keep').waitFor();assert.equal(posts.length,writesBeforeReview);assert.match(await page.locator('.queue-edit-current').innerText(),/另一页面改为周一/);
  for(const theme of ['light','dark'])for(const width of [1024,1440])for(const scale of [1,2]){
   await page.setViewportSize({width,height:1100});await page.evaluate(({theme,scale})=>{document.documentElement.dataset.theme=theme;document.documentElement.dataset.queueEditScale=scale;if(!window.queueEditRule){document.styleSheets[0].insertRule('html[data-queue-edit-scale="2"] #queue-edit-dialog :is(p,button,label,textarea,pre){font-size:28px!important}',0);window.queueEditRule=true;}},{theme,scale});
   const bounds=await page.locator('#queue-edit-keep').evaluate(el=>{el.scrollIntoView({block:'center'});el.focus();const r=el.getBoundingClientRect();return {root:document.documentElement.scrollWidth,width:innerWidth,left:r.left,right:r.right,top:r.top,bottom:r.bottom,font:parseFloat(getComputedStyle(el).fontSize),focused:document.activeElement===el};});
   assert(bounds.focused&&bounds.root<=width+1&&bounds.left>=0&&bounds.right<=width+1&&bounds.top>=0&&bounds.bottom<=1100,JSON.stringify(bounds));if(scale===2)assert.equal(bounds.font,28);
   const editor=await page.locator('#queue-edit-input').evaluate(el=>({width:el.getBoundingClientRect().width,dialog:el.closest('dialog').getBoundingClientRect().width}));assert(editor.width>editor.dialog*.8,JSON.stringify(editor));layouts.push({theme,width,scale,bounds,editor});
   if(width===1440&&scale===1)await page.screenshot({path:path.join(out,'queue-edit-'+theme+'.png'),animations:'disabled'});
  }
  await page.setViewportSize({width:1440,height:1100});await page.evaluate(()=>document.documentElement.dataset.queueEditScale=1);await page.locator('#queue-edit-keep').click();await page.locator('#queue-edit-save').click();await saved('周日 17 点开会');
  pass('多页面修改冲突保留本页输入，只读核对后明确保存；八种桌面主题与字号布局可操作');

  await nav(page,b);await open();await page.locator('#queue-edit-input').fill('已受理但丢失回执的修改');const lost=base+'/api/tasks/'+b+'/messages/2/edit';await page.route(lost,async route=>{if(route.request().method()==='POST'){await route.fetch();return route.abort('failed');}return route.continue();});await page.locator('#queue-edit-save').click();await page.locator('#queue-edit-review').waitFor();await page.unroute(lost);await page.locator('#queue-edit-input').fill('回执丢失后继续编辑');await page.keyboard.press('Escape');const lostWrites=posts.length;
  await page.reload();await ready(page,b);await page.locator('[aria-label="排队消息编辑"] [data-queue-edit]').click();assert.equal(await page.locator('#queue-edit-input').inputValue(),'回执丢失后继续编辑');assert.equal(posts.length,lostWrites);await page.locator('#queue-edit-review').click();await page.locator('#queue-edit-keep').waitFor();assert.match(await page.locator('#queue-edit-feedback').innerText(),/原修改已保存/);assert.equal(posts.length,lostWrites);
  await page.locator('#queue-edit-keep').click();await page.locator('#queue-edit-save').click();await saved('回执丢失后继续编辑');assert.equal(posts.length,lostWrites+1);
  pass('保存回执丢失后刷新恢复原请求及后续输入，核对不重发，后续编辑需明确再次保存');

  await nav(page,c);await open();await page.locator('#queue-edit-input').fill('已经开始时仍要保留的本页修改');await page.keyboard.press('Escape');await page.reload();await ready(page,c);await page.locator('[aria-label="排队消息编辑"] [data-queue-edit]').click();
  const late=base+'/api/tasks/'+c+'/messages/2/edit',arrived=deferred(),continuePost=deferred();release=continuePost.resolve;await page.route(late,async route=>{if(route.request().method()==='POST'){arrived.resolve();await continuePost.promise;}return route.continue();});await page.locator('#queue-edit-save').click();await arrived.promise;await call(other,'/__test/release-queue',{});
  await page.waitForFunction(()=>state.detail?.conversation?.turns[2].status==='SUCCEEDED');continuePost.resolve();await page.locator('#queue-edit-review').waitFor();await page.unroute(late);release=null;
  await page.locator('#queue-edit-review').click();await page.waitForFunction(()=>taskQueueEditor?.inspected?.status==='SUCCEEDED');assert(await page.locator('#queue-edit-save').isDisabled());assert.equal(await page.locator('#queue-edit-keep').count(),0);assert.equal(await page.locator('#queue-edit-input').inputValue(),'已经开始时仍要保留的本页修改');await page.locator('[data-queue-edit-copy]').click();await page.getByText('本页修改已复制。',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),'已经开始时仍要保留的本页修改');await page.screenshot({path:path.join(out,'queue-edit-started.png'),animations:'disabled'});
  const executed=await call(page,'/api/tasks/'+c),child=await call(page,'/api/runs/'+executed.conversation.turns[1].run_id);assert.equal(child.run.task.goal,'周五 15 点开会');
  const first=await call(page,'/api/tasks/'+a),firstChild=await call(page,'/api/runs/'+first.conversation.turns[1].run_id);assert.equal(firstChild.run.task.goal,'周日 17 点开会');const nextChild=await call(page,'/api/runs/'+first.conversation.turns[2].run_id);assert(nextChild.run.task.conversation_context.messages.some(m=>m.role==='user'&&m.content==='周日 17 点开会'));
  const exported=await page.evaluate(async url=>(await fetch(url)).text(),base+'/api/tasks/'+a+'/export?kind=markdown&workspace_id='+config.workspace);assert.match(exported,/排队期间已修改/);assert.match(exported,/周日 17 点开会/);
  pass('派发先发生时拒绝迟到修改并保留可复制输入；实际执行和后续上下文使用各自正确版本，导出标记修改');
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({checks,errors,posts,layouts},null,2));
 }catch(error){await page.screenshot({path:path.join(out,'failure.png'),animations:'disabled'}).catch(()=>{});fs.writeFileSync(path.join(out,'failure.json'),JSON.stringify({checks,errors,error:error.stack},null,2));throw error;}finally{release?.();await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
