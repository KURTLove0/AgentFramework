'use strict';
// Disposable synthetic data only; exercises the real confirmation and server.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright');
const base=process.env.WORKSPACE_SAFETY_URL;if(!base)throw Error('Set WORKSPACE_SAFETY_URL.');
const output=process.env.WORKSPACE_SAFETY_OUTPUT||'/private/tmp/workspace-safety';fs.mkdirSync(output,{recursive:true});
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),checks=[],errors=[],layouts=[];
 page.setDefaultTimeout(12000);page.on('pageerror',error=>errors.push(error.message));
 const call=(url,data,workspace)=>page.evaluate(({url,data,workspace})=>api(url,data,15000,true,workspace?{workspace,payload:data===undefined?undefined:JSON.stringify(data)}:null),{url,data,workspace});
 const pass=message=>{checks.push(message);console.log('PASS '+message);};
 const shot=name=>page.screenshot({path:path.join(output,name+'.png'),animations:'disabled'});
 const checkDone=()=>page.waitForFunction(()=>document.querySelector('#confirm-dialog').open&&document.querySelector('#confirm-submit').textContent==='删除空间');
 const openDelete=async id=>{await page.locator('[data-delete-workspace="'+id+'"]').click();await checkDone();};
 const dismiss=()=>page.locator('#confirm-dialog .dialog-foot [data-close]').click();
 try{
  await page.goto(base+'#/workspaces');await page.waitForFunction(()=>state.connected&&!state.busy&&state.view==='workspaces');
  await openDelete('workspace-default');assert(await page.locator('#confirm-submit').isDisabled());assert.match(await page.locator('#confirm-body').innerText(),/至少保留一个/);
  await page.keyboard.press('Escape');await page.locator('#confirm-dialog').waitFor({state:'hidden'});pass('最后一个空间在确认前说明原因，禁用删除并支持 Escape 返回');
  const workspace=await call('/api/workspaces',{name:'空间安全验收',business:'模拟业务',scenario:'排队消息',description:'临时隔离数据',revision:0}),wid=workspace.id;
  await call('/__test/release-queue',{});
  const created=await call('/api/runs',{runtime:'mock',start:true,grant:true},wid),root=created.run.run_id;
  let completed=false;
  for(let i=0;i<150;i++){
   const result=await call('/api/tasks/'+root,undefined,wid);
   if(result.run.status==='SUCCEEDED'&&!result.job?.active){completed=true;break;}
   await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert(completed,'initial task did not finish');
  await call('/__test/fill-queue',{});
  let detail=await call('/api/tasks/'+root+'/messages',{content:'请继续处理这条排队消息',request_id:'workspace-queued',revision:1},wid);
  assert.equal(detail.conversation.turns[1].status,'QUEUED');
  await page.evaluate(async()=>{await loadWorkspaces();render();});await openDelete(wid);
  assert(await page.locator('#confirm-submit').isDisabled());assert.match(await page.locator('#confirm-body').innerText(),/1 条排队消息/);
  let writes=0;const onRequest=request=>{if(request.method()==='POST'&&request.url().endsWith('/api/workspaces/'+wid+'/delete'))writes++;};page.on('request',onRequest);
  await page.evaluate(()=>document.querySelector('#confirm-submit').onclick());assert.equal(writes,0);
  for(const theme of ['light','dark'])for(const width of [1440,1024]){
   await page.setViewportSize({width,height:900});await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
   const layout=await page.evaluate(()=>{const dialog=document.querySelector('#confirm-dialog'),r=dialog.getBoundingClientRect();return {pageOverflow:document.documentElement.scrollWidth>innerWidth,dialogOverflow:dialog.scrollWidth>dialog.clientWidth,left:r.left,right:r.right};});
   assert(!layout.pageOverflow&&!layout.dialogOverflow&&layout.left>=0&&layout.right<=width);layouts.push({theme,width,...layout});await shot('blocked-'+theme+'-'+width);
  }
  pass('未创建执行记录的排队消息阻止删除，桌面深浅色确认框可完整阅读');
  detail=await call('/api/tasks/'+root+'/messages/2/cancel',{revision:detail.conversation.revision},wid);
  await page.locator('#workspace-delete-recheck').click();await checkDone();assert(await page.locator('#confirm-submit').isEnabled());
  const receipt=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/api/workspaces/'+wid+'/delete'));
  await page.locator('#confirm-submit').click();assert.equal((await receipt).status(),200);await page.locator('#confirm-dialog').waitFor({state:'hidden'});
  await page.getByText('历史数据继续保留，需要时可恢复使用。',{exact:true}).waitFor();assert.equal(writes,1);assert.equal((await call('/api/workspaces/'+wid)).revision,2);
  await page.locator('#workspace-feedback [data-restore-workspace="'+wid+'"]').click();await page.waitForFunction(id=>state.workspaces.some(w=>w.id===id&&!w.deleted),wid);
  const restored=await call('/api/tasks/'+root,undefined,wid);assert.equal(restored.run.status,'SUCCEEDED');assert.equal(restored.conversation.turns[1].status,'CANCELLED');
  pass('取消排队后可重新检查、删除与恢复，原任务和消息历史保留');

  await openDelete(wid);assert(await page.locator('#confirm-submit').isEnabled());
  const pending=await call('/api/runs',{runtime:'mock',start:false},wid);
  const rejected=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith('/api/workspaces/'+wid+'/delete'));
  await page.locator('#confirm-submit').click();assert.equal((await rejected).status(),409);await checkDone();
  assert(await page.locator('#confirm-submit').isDisabled());assert.match(await page.locator('#confirm-body').innerText(),/1 项未完成任务/);assert.equal(await page.locator('#confirm-error').getAttribute('hidden'),null);await shot('new-work-after-preview');
  await call('/api/runs/'+pending.run.run_id+'/cancel',{},wid);await dismiss();pass('检查后出现新任务时，提交仍被服务拒绝并重新展示阻止原因');

  let failOnce=true;await page.route('**/api/workspaces/'+wid+'/deletion-check',async route=>{if(failOnce){failOnce=false;return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'临时不可用'})});}return route.continue();});
  await openDelete(wid);assert(await page.locator('#confirm-submit').isDisabled());assert.match(await page.locator('#confirm-body').innerText(),/空间尚未删除/);
  await page.locator('#workspace-delete-recheck').click();await checkDone();assert(await page.locator('#confirm-submit').isEnabled());await dismiss();await page.unroute('**/api/workspaces/'+wid+'/deletion-check');pass('检查读取失败时保留空间，显式重试后恢复可用');

  await page.goto(base+'?workspace_id='+wid+'#/workspaces');await page.waitForFunction(id=>state.connected&&!state.busy&&state.workspaceId===id,wid);
  await openDelete(wid);await page.locator('#confirm-submit').click();
  await page.waitForURL(url=>url.searchParams.get('workspace_id')==='workspace-default'&&url.hash==='#/workspaces');
  await page.waitForFunction(()=>state.connected&&!state.busy&&state.meta.workspace.id==='workspace-default');
  assert.equal((await call('/api/workspaces/'+wid)).deleted,true);await shot('current-workspace-fallback');pass('删除当前空间后进入剩余空间的管理页，刷新后仍可恢复');
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({checks,errors,layouts},null,2));
 }catch(error){await shot('failure').catch(()=>{});fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({checks,errors,error:error.message,text:await page.locator('body').innerText()},null,2));throw error;}finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
