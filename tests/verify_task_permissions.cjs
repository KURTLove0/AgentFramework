'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{chromium}=require('playwright'),{waitFor}=require('./browser_poll.cjs');
const base=process.env.TASK_PERMISSION_URL,out=process.env.TASK_PERMISSION_OUTPUT;if(!base||!out)throw Error('Use the task-permissions fixture.');fs.mkdirSync(out,{recursive:true});
const defer=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),checks=[],errors=[],layouts=[],posts=[];let release;
 page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST'&&/\/api\/runs\/[^/]+\/(grant|revoke)$/.test(new URL(r.url()).pathname))posts.push({path:new URL(r.url()).pathname,data:r.postDataJSON()});});
 await page.addInitScript(()=>{const interval=setInterval;window.__permissionPolls=[];window.setInterval=(fn,delay,...args)=>{const id=interval(fn,delay,...args);if(delay===1500)window.__permissionPolls.push(id);return id;};});
 const call=(url,data)=>page.evaluate(({url,data})=>api(url,data),{url,data}),detail=id=>call('/api/runs/'+id),pass=text=>{checks.push(text);console.log('PASS '+text);};
 const ready=()=>page.waitForFunction(()=>state.connected&&!state.busy),nav=async id=>{await page.evaluate(id=>navigate('runs',id),id);await ready();await page.waitForFunction(id=>state.detail?.run?.run_id===id,id);};
 const open=async action=>{await page.locator('[data-action="'+action+'"]').click();await page.locator('#confirm-dialog[open]').waitFor();},submit=()=>page.locator('#confirm-submit').click(),close=()=>page.locator('#confirm-dialog .dialog-foot [data-close]').click();
 const settle=async id=>waitFor(async()=>{const d=await detail(id);return d.run.status==='SUCCEEDED'&&!d.job?.active;},'Task did not complete');
 try{
  await page.goto(base);await ready();await page.evaluate(()=>window.__permissionPolls.forEach(clearInterval));
  const a=await call('/__test/create-waiting',{}),id=a.run.run_id;await nav(id);await open('grant');const original=a.permissions.grant_token;
  const seen=defer(),gate=defer();release=gate.resolve;await page.route(base+'/api/runs/'+id+'/grant',async route=>{seen.resolve();await gate.promise;await route.continue();});
  await submit();await seen.promise;const changed=await call('/__test/change-task-proposal',{run_id:id});gate.resolve();await page.locator('.run-action-recovery').getByText(/提案或授权状态已变化/).waitFor();await page.unroute(base+'/api/runs/'+id+'/grant');release=null;
  assert.equal(posts.length,1);assert.equal(posts[0].data.proof,original);assert.notEqual(changed.permissions.grant_token,original);assert(await page.locator('#confirm-submit').isDisabled());assert.equal((await detail(id)).grant.valid,false);
  pass('普通任务只提交已审查提案的标记，内容变化时拒绝旧授权并保留原窗口');

  await page.route('**/__permission-text.css*',route=>route.fulfill({status:200,contentType:'text/css',body:'html[data-permission-scale="2"] #confirm-dialog :is(p,button,h2,summary,dt,dd,pre){font-size:200%!important;line-height:1.5!important}'}));
  await page.evaluate(url=>new Promise((resolve,reject)=>{const link=document.createElement('link');link.rel='stylesheet';link.href=url;link.onload=resolve;link.onerror=reject;document.head.append(link);}),base+'/__permission-text.css');
  for(const theme of ['light','dark'])for(const width of [1024,1440])for(const scale of [1,2]){
   await page.setViewportSize({width,height:1100});await page.evaluate(({theme,scale})=>{const select=document.querySelector('#appearance-select');select.value=theme;select.dispatchEvent(new Event('change',{bubbles:true}));document.documentElement.dataset.permissionScale=String(scale);},{theme,scale});
   const button=page.locator('[data-run-action-review]');await button.focus();await button.scrollIntoViewIfNeeded();
   const bounds=await button.evaluate(el=>{const d=el.closest('dialog'),r=el.getBoundingClientRect();return {scroll:d.scrollWidth,client:d.clientWidth,root:document.documentElement.scrollWidth,width:innerWidth,left:r.left,right:r.right,top:r.top,bottom:r.bottom,font:parseFloat(getComputedStyle(el).fontSize),focused:document.activeElement===el};});
   assert(bounds.root<=width+1&&bounds.scroll<=bounds.client+1);assert(bounds.left>=0&&bounds.right<=width+1&&bounds.top>=0&&bounds.bottom<=1101);assert(bounds.focused&&bounds.font>=14*scale);layouts.push({theme,width,scale,bounds});
   if(width===1440&&scale===1)await page.screenshot({path:path.join(out,'task-permission-'+theme+'.png'),animations:'disabled'});
  }
  await page.evaluate(()=>delete document.documentElement.dataset.permissionScale);
  pass('确认与核对入口在浅深主题、1024/1440 宽度及两倍文字下可聚焦并可到达');
  await page.locator('[data-run-action-review]').click();await page.locator('[data-run-action-prepare]').waitFor();assert.equal(posts.length,1);assert.equal(await page.evaluate(()=>runActionContext.payload.proof),original);
  await page.locator('[data-run-action-prepare]').click();assert.equal(await page.evaluate(()=>runActionContext.payload.proof),changed.permissions.grant_token);assert.equal(posts.length,1);
  await page.route(base+'/api/runs/'+id+'/grant',async route=>{const response=await route.fetch();assert.equal(response.status(),202);await route.abort('failed');});await submit();await page.getByText(/暂时无法确认操作结果/).waitFor();await page.unroute(base+'/api/runs/'+id+'/grant');
  await page.locator('[data-run-action-review]').click();await page.getByText(/授权已经保存，正在等待执行/).waitFor();assert.equal(posts.length,2);await close();
  await open('revoke');await submit();await page.locator('#confirm-dialog').waitFor({state:'hidden'});assert.equal((await detail(id)).grant.valid,false);assert.equal((await detail(id)).permissions.request,null);
  const oldAccepted=posts[1].data;await call('/api/runs/'+id+'/grant',oldAccepted);assert.equal((await detail(id)).grant.valid,false);assert.equal((await detail(id)).permissions.request,null);
  pass('重新审查才采用新提案；响应丢失后只读核对，撤销后旧回执不能重新授权');

  const b=await call('/__test/create-waiting',{}),bid=b.run.run_id;await nav(bid);await open('grant');await submit();await page.locator('#confirm-dialog').waitFor({state:'hidden'});assert.equal((await detail(bid)).permissions.request.state,'QUEUED');
  const seed=process.env.AUDIT_FIX_SEED,before=JSON.parse(fs.readFileSync(seed)).restarts;fs.writeFileSync(path.join(path.dirname(seed),'restart-request'),'restart');await waitFor(()=>JSON.parse(fs.readFileSync(seed)).restarts>before,'Service did not restart',{timeoutMs:20000});
  await page.reload();await ready();await page.evaluate(()=>window.__permissionPolls.forEach(clearInterval));await page.getByText('授权已保存，等待执行',{exact:true}).waitFor();assert.equal(posts.filter(p=>p.path==='/api/runs/'+bid+'/grant').length,1);
  await call('/__test/release-queue',{});await settle(bid);const finished=await detail(bid);assert.equal(finished.external.drafts.length,1);assert.equal(finished.external.calls['report.draft.create@1.0.0'],1);assert.equal(finished.permissions.request,null);
  pass('队列满时受理授权并保存继续请求；真实服务重启后无需重提，容量恢复只创建一份草稿');

  await call('/__test/fill-queue',{});const c=await call('/__test/create-waiting',{}),cid=c.run.run_id;await nav(cid);await open('grant');await submit();await page.locator('#confirm-dialog').waitFor({state:'hidden'});
  await call('/__test/fail-next-executor',{});await call('/__test/release-queue',{});await waitFor(async()=>(await detail(cid)).permissions.request?.state==='ERROR','Executor failure not retained');await page.evaluate(()=>refresh());
  await page.locator('[data-retry-permission]').waitFor();const grantCount=posts.filter(p=>p.path==='/api/runs/'+cid+'/grant').length;await page.locator('[data-retry-permission]').click();await settle(cid);assert.equal(posts.filter(p=>p.path==='/api/runs/'+cid+'/grant').length,grantCount);assert.equal((await detail(cid)).external.drafts.length,1);
  pass('执行器失败保留已接受授权和明确重试入口，继续执行不重新授权');

  await call('/__test/fill-queue',{});const d=await call('/__test/create-waiting',{}),e=await call('/__test/create-waiting',{}),did=d.run.run_id,eid=e.run.run_id;await nav(did);await open('grant');
  const accepted=defer(),late=defer();release=late.resolve;await page.route(base+'/api/runs/'+did+'/grant',async route=>{const response=await route.fetch();accepted.resolve();await late.promise;await route.fulfill({response});});
  await submit();await accepted.promise;await page.evaluate(()=>window.__olderPermissionAction=runActionContext);await close();await nav(eid);await open('cancel');late.resolve();await page.waitForFunction(()=>!window.__olderPermissionAction.busy&&runActionContext.action==='cancel'&&!runActionContext.busy);await page.unroute(base+'/api/runs/'+did+'/grant');release=null;
  assert(await page.locator('#confirm-dialog').isVisible());assert.equal(await page.locator('#confirm-title').textContent(),'取消当前运行');assert.equal(await page.evaluate(()=>state.selected),eid);assert(await page.locator('#confirm-submit').isEnabled());await close();await call('/api/runs/'+did+'/cancel',{});
  pass('较早授权回执晚到时，不关闭后来任务的取消窗口，也不覆盖当前任务');
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({checks,errors,layouts,posts,restarts:JSON.parse(fs.readFileSync(process.env.AUDIT_FIX_SEED)).restarts},null,2));
 }catch(error){await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});fs.writeFileSync(path.join(out,'failure.json'),JSON.stringify({checks,errors,error:error.stack,text:await page.locator('body').innerText()},null,2));throw error;}
 finally{release?.();await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
