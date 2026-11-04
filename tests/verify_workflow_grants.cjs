'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{chromium}=require('playwright');
const {waitFor}=require('./browser_poll.cjs');
const base=process.env.WORKFLOW_GRANT_URL,output=process.env.WORKFLOW_GRANT_OUTPUT||'/private/tmp/workflow-grants';
if(!base)throw Error('Set WORKFLOW_GRANT_URL to the isolated fixture.');fs.mkdirSync(output,{recursive:true});
const defer=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
 const checks=[],errors=[],layouts=[],posts=[];let release;
 const pass=message=>{checks.push(message);console.log('PASS '+message);};
 page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST'&&r.url().endsWith('/grant'))posts.push(r.postDataJSON());});
 await page.addInitScript(()=>{const interval=setInterval;window.__grantPolls=[];window.setInterval=(fn,delay,...args)=>{const id=interval(fn,delay,...args);if(delay===1500)window.__grantPolls.push(id);return id;};});
 const call=(url,data)=>page.evaluate(({url,data})=>api(url,data),{url,data});
 const get=async id=>call('/api/workflow-runs/'+id);
 try{
  await page.goto(base+'#/workflows');await page.waitForFunction(()=>state.connected&&!state.busy);await page.evaluate(()=>window.__grantPolls.forEach(clearInterval));
  const agent=(await call('/api/agents')).agents[0];
  const w=await call('/api/workflows',{name:'提案授权核对',description:'仅隔离合成数据',revision:0,nodes:[{id:'review',name:'审查写入提案',agent_id:agent.id,agent_revision:agent.revision,goal:'评估模拟变更并准备草稿',depends_on:[]}]});
  const started=await call('/api/workflows/'+w.id+'/start',{revision:w.revision,request_id:'grant-review-run',change_id:'change-grant-review',grant:false,consent:false,mcp_consent:false}),id=started.run.id;
  await call('/__test/release-queue',{});await waitFor(async()=>{const d=await get(id);return d.run.status==='WAITING_AUTH'&&!d.job?.active;},'Workflow did not wait for approval');await call('/__test/fill-queue',{});
  await page.evaluate(id=>navigate('workflows',id),id);await page.waitForFunction(id=>!state.busy&&state.flowDetail?.run?.id===id,id);
  const original=await get(id),oldToken=original.children.review.proposal_token;assert.equal(await page.locator('[data-grant-flow]').getAttribute('data-proposal-token'),oldToken);
  const seen=defer(),gate=defer();release=gate.resolve;
  await page.route('**/api/workflow-runs/'+id+'/grant',async route=>{seen.resolve();await gate.promise;await route.continue();});
  await page.locator('[data-grant-flow]').click();await seen.promise;
  assert(await page.locator('[data-grant-flow]').isDisabled());
  const changed=await call('/__test/replace-proposal',{run_id:id,node_id:'review'});assert.notEqual(changed.children.review.proposal_token,oldToken);
  gate.resolve();await page.getByText(/写入提案或授权状态已变化/).waitFor();await page.unroute('**/api/workflow-runs/'+id+'/grant');release=null;
  const rejected=await get(id);assert.equal(rejected.queue,null);assert.equal(rejected.children.review.draft_count,0);assert(!rejected.events.some(e=>e.kind==='workflow.granted'));assert.equal(posts.length,1);assert.equal(posts[0].proposal_token,oldToken);
  pass('点击时冻结原提案，提交前提案变化会拒绝授权，不创建草稿或派发');

  let scale=1;
  // Reload the same-origin sheet so the scaling rules obey the real CSP.
  await page.route('**/hig.css*',async route=>{const response=await route.fetch();await route.fulfill({response,body:(await response.text())+'\nhtml[data-grant-scale="2"] #flow-run-detail :is(p,button,h3,summary,pre){font-size:200%!important}'});});
  await page.evaluate(()=>document.querySelector('link[href^="/hig.css"]').href='/hig.css?grant-layout=2');
  await page.waitForFunction(()=>[...document.styleSheets].some(sheet=>{try{return [...sheet.cssRules].some(rule=>rule.cssText.includes('data-grant-scale'));}catch{return false;}}));
  for(const theme of ['light','dark'])for(const width of [1024,1440])for(scale of [1,2]){
   await page.setViewportSize({width,height:1000});await page.evaluate(({theme,scale})=>{const select=document.querySelector('#appearance-select');select.value=theme;select.dispatchEvent(new Event('change',{bubbles:true}));document.documentElement.dataset.grantScale=String(scale);},{theme,scale});
   const review=page.locator('[data-review-flow-grant]');await review.focus();await review.scrollIntoViewIfNeeded();
   const bounds=await review.evaluate(el=>{const r=el.getBoundingClientRect(),panel=el.closest('.flow-auth');return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,font:parseFloat(getComputedStyle(el).fontSize),focused:document.activeElement===el,scroll:panel.scrollWidth,client:panel.clientWidth,root:document.documentElement.scrollWidth,width:innerWidth};});
   assert(bounds.focused);assert(bounds.root<=width+1);assert(bounds.scroll<=bounds.client+1);assert(bounds.left>=0&&bounds.right<=width+1&&bounds.top>=0&&bounds.bottom<=1001);assert(bounds.font>=14*scale);
   layouts.push({theme,width,scale,bounds});if(width===1440&&scale===1){await page.evaluate(async()=>{window.scrollTo({top:0,behavior:'instant'});await document.fonts.ready;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});await page.screenshot({path:path.join(output,'workflow-grant-'+theme+'.png'),fullPage:true,animations:'disabled'});}
  }
  await page.evaluate(()=>{delete document.documentElement.dataset.grantScale;const select=document.querySelector('#appearance-select');select.value='light';select.dispatchEvent(new Event('change',{bubbles:true}));});
  pass('授权失败的核对入口在浅深主题、1024/1440 宽度与两倍文字下可聚焦且无横向溢出');

  await page.locator('[data-review-flow-grant]').click();await page.getByText(/已核对当前状态/).waitFor();assert.equal(posts.length,1);
  assert.equal(await page.locator('[data-grant-flow]').getAttribute('data-proposal-token'),changed.children.review.proposal_token);assert(await page.locator('[data-grant-flow]').isEnabled());
  await page.locator('.flow-auth details').evaluate(el=>el.open=true);await page.locator('.flow-auth pre').filter({hasText:'更新后的写入提案'}).waitFor();
  pass('明确核对只读取并显示新提案，用户重新审查前不自动授权');

  await page.route('**/api/workflow-runs/'+id+'/grant',async route=>{const response=await route.fetch();assert.equal(response.status(),202);await route.abort('failed');});
  await page.locator('[data-grant-flow]').click();await page.getByText(/暂时无法确认授权结果/).waitFor();await page.unroute('**/api/workflow-runs/'+id+'/grant');
  const accepted=await get(id);assert.equal(accepted.queue.reason,'grant');assert.equal(accepted.events.filter(e=>e.kind==='workflow.granted').length,1);assert.equal(posts.length,2);
  await page.locator('[data-review-flow-grant]').click();await page.getByText(/已核对当前状态/).waitFor();assert.equal(posts.length,2);assert(await page.locator('[data-grant-flow]').isDisabled());assert.equal(await page.locator('[data-grant-flow]').textContent(),'授权已保存');
  pass('授权已受理但响应丢失后，只读核对找回排队状态，不重复提交');

  const originalAccepted=posts[1],beforeRetry=await get(id);await call('/api/workflow-runs/'+id+'/grant',originalAccepted);const replayed=await get(id);assert.deepEqual(replayed.events,beforeRetry.events);
  await call('/api/workflow-runs/'+id+'/cancel',{});const cancelled=await get(id);await call('/api/workflow-runs/'+id+'/grant',originalAccepted);const replayAfterCancel=await get(id);assert.deepEqual(replayAfterCancel.events,cancelled.events);assert.equal(replayAfterCancel.queue.reason,'cancel');assert.equal(replayAfterCancel.children.review.draft_count,0);
  pass('重放已接受的提案回执不增加授权事件，取消后也不会覆盖取消派发');
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({checks,errors,layouts,posts,run:id},null,2));
 }catch(error){await page.screenshot({path:path.join(output,'failure.png'),fullPage:true}).catch(()=>{});fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({checks,errors,error:error.message,text:await page.locator('body').innerText()},null,2));throw error;}
 finally{release?.();await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
