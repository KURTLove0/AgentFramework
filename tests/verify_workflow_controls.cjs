'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{chromium}=require('playwright');
const {waitFor}=require('./browser_poll.cjs');
const base=process.env.WORKFLOW_CONTROL_URL,output=process.env.WORKFLOW_CONTROL_OUTPUT||'/private/tmp/workflow-controls';
if(!base)throw Error('Set WORKFLOW_CONTROL_URL to the isolated fixture.');fs.mkdirSync(output,{recursive:true});
const defer=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
 const checks=[],errors=[],layouts=[],posts=[];let release;
 const pass=message=>{checks.push(message);console.log('PASS '+message);};
 page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST'&&/\/api\/workflow-runs\/[^/]+\/(resume|cancel|grant)$/.test(new URL(r.url()).pathname))posts.push({url:new URL(r.url()).pathname,body:r.postDataJSON()});});
 await page.addInitScript(()=>{const interval=setInterval;window.__controlPolls=[];window.setInterval=(fn,delay,...args)=>{const id=interval(fn,delay,...args);if(delay===1500)window.__controlPolls.push(id);return id;};});
 const call=(url,data)=>page.evaluate(({url,data})=>api(url,data),{url,data}),get=id=>call('/api/workflow-runs/'+id);
 const open=async id=>{await page.evaluate(id=>navigate('workflows',id),id);await page.waitForFunction(id=>!state.busy&&state.flowDetail?.run?.id===id,id);};
 try{
  await page.goto(base+'#/workflows');await page.waitForFunction(()=>state.connected&&!state.busy);await page.evaluate(()=>window.__controlPolls.forEach(clearInterval));
  const agent=(await call('/api/agents')).agents[0];
  const w=await call('/api/workflows',{name:'工作流操作结果核对',description:'隔离合成数据',revision:0,nodes:[{id:'review',name:'审查模拟提案',agent_id:agent.id,agent_revision:agent.revision,goal:'评估模拟变更并准备草稿',depends_on:[]}]});
  const ids=[];for(let i=0;i<3;i++)ids.push((await call('/api/workflows/'+w.id+'/start',{revision:w.revision,request_id:'control-run-'+i,change_id:'change-control-'+i,grant:false,consent:false,mcp_consent:false})).run.id);
  await call('/__test/release-queue',{});for(const id of ids)await waitFor(async()=>{const d=await get(id);return d.run.status==='WAITING_AUTH'&&!d.job?.active;},'Workflow did not wait for approval');await call('/__test/fill-queue',{});
  const [a,b,c]=ids;await open(a);const before=await get(a),child=before.run.nodes.review.run_id;
  const seen=defer(),gate=defer();release=gate.resolve;
  await page.route('**/api/workflow-runs/'+a+'/resume',async route=>{seen.resolve();await gate.promise;const response=await route.fetch();assert.equal(response.status(),202);await route.abort('failed');});
  await page.locator('[data-resume-flow]').focus();await page.keyboard.press('Enter');await seen.promise;
  await page.evaluate(()=>{state.fingerprint='';render();});
  assert(await page.locator('[data-resume-flow]').isDisabled(),'A rerender must keep the pending resume disabled');
  assert(await page.locator('[data-cancel-flow]').isEnabled(),'Stop must remain available during resume');
  await page.locator('[data-resume-flow]').evaluate(el=>el.dispatchEvent(new MouseEvent('click',{bubbles:true})));assert.equal(posts.length,1);
  gate.resolve();await page.locator('#flow-control-feedback').filter({hasText:'暂时无法确认恢复结果'}).waitFor();await page.unroute('**/api/workflow-runs/'+a+'/resume');release=null;
  assert(await page.locator('[data-resume-flow]').isDisabled());assert(await page.locator('[data-grant-flow]').isDisabled());assert(await page.locator('[data-cancel-flow]').isEnabled());
  const accepted=await get(a);assert.equal(accepted.queue.reason,'resume');assert.equal(accepted.run.nodes.review.run_id,child);assert.equal(accepted.children.review.draft_count,0);
  pass('恢复请求处理中重绘及合成重复点击均不重复提交，响应丢失后保留核对入口且仍可取消');

  await page.locator('[data-review-flow-control]').focus();await page.keyboard.press('Enter');await page.locator('#flow-control-feedback').filter({hasText:'已核对当前运行状态'}).waitFor();
  assert.equal(posts.length,1);assert.equal(await page.evaluate(()=>state.flowDetail.queue.reason),'resume');assert(await page.locator('[data-resume-flow]').isDisabled());
  pass('只读核对找回已经保存的恢复派发，复用原节点且不新增授权或写入');

  await page.route('**/api/workflow-runs/'+a+'/cancel',async route=>{const response=await route.fetch();assert.equal(response.status(),202);await route.abort('failed');});
  await page.locator('[data-cancel-flow]').click();await page.locator('#flow-control-feedback').filter({hasText:'暂时无法确认取消结果'}).waitFor();await page.unroute('**/api/workflow-runs/'+a+'/cancel');
  assert.equal(posts.length,2);assert((await get(a)).run.cancel_requested);assert(await page.locator('[data-cancel-flow]').isDisabled());assert(await page.locator('[data-grant-flow]').isDisabled());
  await page.route('**/api/workflow-runs/'+a,route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'核对服务暂不可用'})}));
  await page.locator('[data-review-flow-control]').click();await page.locator('#flow-control-feedback').filter({hasText:'核对未完成'}).waitFor();assert.equal(posts.length,2);assert(await page.locator('[data-cancel-flow]').isDisabled());await page.unroute('**/api/workflow-runs/'+a);
  pass('取消响应丢失及核对失败保留停止意图提示，不重复取消，也不能趁未知状态新增授权');

  await page.route('**/hig.css*',async route=>{const response=await route.fetch();await route.fulfill({response,body:(await response.text())+'\nhtml[data-control-scale="2"] #flow-run-detail :is(p,button,h3,summary,pre){font-size:200%!important}'});});
  await page.evaluate(()=>document.querySelector('link[href^="/hig.css"]').href='/hig.css?control-layout=2');
  await page.waitForFunction(()=>[...document.styleSheets].some(sheet=>{try{return [...sheet.cssRules].some(rule=>rule.cssText.includes('data-control-scale'));}catch{return false;}}));
  for(const theme of ['light','dark'])for(const width of [1024,1440])for(const scale of [1,2]){
   await page.setViewportSize({width,height:1100});await page.evaluate(({theme,scale})=>{const select=document.querySelector('#appearance-select');select.value=theme;select.dispatchEvent(new Event('change',{bubbles:true}));document.documentElement.dataset.controlScale=String(scale);},{theme,scale});
   const review=page.locator('[data-review-flow-control]');await review.focus();await review.scrollIntoViewIfNeeded();
   const bounds=await review.evaluate(el=>{const r=el.getBoundingClientRect(),panel=el.closest('#flow-control-feedback');return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,font:parseFloat(getComputedStyle(el).fontSize),focused:document.activeElement===el,scroll:panel.scrollWidth,client:panel.clientWidth,root:document.documentElement.scrollWidth,width:innerWidth};});
   assert(bounds.focused);assert(bounds.root<=width+1);assert(bounds.scroll<=bounds.client+1);assert(bounds.left>=0&&bounds.right<=width+1&&bounds.top>=0&&bounds.bottom<=1101);assert(bounds.font>=14*scale);layouts.push({theme,width,scale,bounds});
   if(width===1024&&scale===2)await page.screenshot({path:path.join(output,'workflow-controls-'+theme+'.png'),animations:'disabled'});
  }
  await page.evaluate(()=>{delete document.documentElement.dataset.controlScale;});
  await page.locator('[data-review-flow-control]').click();await page.locator('#flow-control-feedback').filter({hasText:'已核对当前运行状态'}).waitFor();assert.equal(posts.length,2);assert.equal(await page.evaluate(()=>state.flowDetail.run.cancel_requested),true);
  pass('核对入口支持键盘、浅深主题、1024/1440 窗口及两倍文字，读取成功后显示已保存的取消');

  await open(b);const late=defer(),receipt=defer();release=late.resolve;
  await page.route('**/api/workflow-runs/'+b+'/resume',async route=>{const response=await route.fetch();receipt.resolve();await late.promise;await route.fulfill({response});});
  await page.locator('[data-resume-flow]').click();await receipt.promise;await open(c);await page.locator('[data-cancel-flow]').focus();const current=await page.evaluate(()=>JSON.stringify(state.flowDetail));
  late.resolve();await page.waitForFunction(id=>flowControlStates.get(flowControlKey(id))?.status==='accepted',b);await page.unroute('**/api/workflow-runs/'+b+'/resume');release=null;
  assert.equal(await page.evaluate(()=>JSON.stringify(state.flowDetail)),current);assert.equal(await page.locator('#flow-control-feedback').count(),0);assert(await page.locator('[data-cancel-flow]').evaluate(el=>el===document.activeElement));
  pass('离开运行后返回的旧恢复回执不替换另一条记录、不显示错误提示、不抢走焦点');

  await page.route('**/api/workflow-runs/'+c+'/cancel',async route=>route.fulfill({status:202,contentType:'application/json',body:JSON.stringify(await get(b))}));
  await page.locator('[data-cancel-flow]').click();await page.locator('#flow-control-feedback').filter({hasText:'返回的运行记录不匹配'}).waitFor();await page.unroute('**/api/workflow-runs/'+c+'/cancel');
  assert.equal(await page.evaluate(()=>state.flowDetail.run.id),c);assert(await page.locator('[data-grant-flow]').isDisabled());const postCount=posts.length;
  await page.locator('[data-review-flow-control]').click();await page.locator('#flow-control-feedback').filter({hasText:'已核对当前运行状态'}).waitFor();assert.equal(posts.length,postCount);assert(await page.locator('[data-cancel-flow]').isEnabled());assert(await page.locator('[data-grant-flow]').isEnabled());
  await call('/__test/release-queue',{});await waitFor(async()=>{const d=await get(a);return d.run.status==='CANCELLED'&&!d.job?.active;},'Cancellation did not finish');
  const final=await get(a);assert.equal(final.children.review.draft_count,0);assert.equal(final.run.nodes.review.run_id,child);
  pass('错配回执被拒绝，明确读取后恢复操作入口；原取消最终完成且没有创建草稿');
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({checks,errors,layouts,posts,runs:ids},null,2));
 }catch(error){await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({checks,errors,error:error.message,text:await page.locator('body').innerText()},null,2));throw error;}
 finally{release?.();await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
