'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{chromium}=require('playwright'),H=require('./ui95_helpers.cjs');
const base=process.env.TASK_RECEIPTS_URL,out=process.env.TASK_RECEIPTS_OUTPUT;if(!base||!out)throw Error('Use isolated fixture');fs.mkdirSync(out,{recursive:true});
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),checks=[],errors=[],posts=[],layouts=[];
 page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));page.on('dialog',dialog=>dialog.accept());page.on('request',r=>{if(r.method()==='POST'&&new URL(r.url()).pathname==='/api/tasks')posts.push(r.postDataJSON());});
 const call=(url,data)=>page.evaluate(({url,data})=>api(url,data),{url,data}),count=async()=>(await call('/api/runs')).counts.total,pass=t=>{checks.push(t);console.log('PASS '+t);};
 const error=page.locator('#create-error'),status=page.locator('#task-submission-status'),form=page.locator('#create-dialog'),review=page.locator('[data-task-submission-review]');
 const fill=async text=>{await page.locator('#task-goal').fill(text);await page.evaluate(()=>clearTimeout(taskJourney.draftTimer));},submit=()=>page.locator('#create-form button[type=submit]').click(),open=async id=>{await page.evaluate(id=>newTask({agentId:id}),id);await form.waitFor({state:'visible'});};
 const settled=()=>page.waitForFunction(()=>!taskJourney.saving&&!taskJourney.submissionReviewing);
 let accepted;
 try{
  await page.goto(base);await page.waitForFunction(()=>state.connected&&!state.busy);
  const definition=(await call('/api/agent-definition-default?domain=general-assistant@1.0.0')).definition,agent=await call('/api/agents',{name:'回执一致性验收助手',description:'隔离数据',runtime:'mock',model:'builtin',options:{},prompt:'按任务要求整理材料。',skills:[],mcp_servers:[],revision:0,definition});
  await open(agent.id);await fill('首次提交的原始目标');
  await page.route('**/api/tasks',async route=>{const response=await route.fetch();assert.equal(response.status(),202);accepted=await response.json();await route.fulfill({status:202,json:{run:{run_id:accepted.run.run_id}}});});
  await submit();await settled();await page.unroute('**/api/tasks');assert.match(await error.innerText(),/回执不完整/);assert(await form.isVisible());assert(await page.locator('#create-form button[type=submit]').isDisabled());assert.equal(await count(),1);const firstToken=posts[0].request_id;assert.equal(await page.evaluate(()=>taskJourney.submission.payload.request_id),firstToken);assert.equal(accepted.submission.request_id,firstToken);
  await fill('回执异常之后保留的后续修改');
  await page.route('**/api/task-submissions/*',async route=>{const response=await route.fetch(),packet=await response.json();packet.submission.request_id='other-request';await route.fulfill({json:packet});});await review.click();await settled();assert.match(await status.innerText(),/核对暂未完成/);assert.equal(await page.locator('[data-task-submission-open]').count(),0);assert.equal(posts.length,1);await page.unroute('**/api/task-submissions/*');
  await page.route('**/api/task-submissions/*',route=>route.fulfill({json:null}));await review.click();await settled();assert.match(await status.innerText(),/核对暂未完成/);assert.doesNotMatch(await status.innerText(),/暂未找到已受理任务/);await page.unroute('**/api/task-submissions/*');
  pass('服务端已受理但成功响应不完整时保留原编号；错误编号和空的核对响应均不会误认成功或未受理');
  await page.evaluate(()=>document.styleSheets[0].insertRule('html[data-receipt-scale="2"] #task-submission-status,html[data-receipt-scale="2"] #task-submission-status *{font-size:28px!important;line-height:1.5!important}',0));
  for(const theme of ['light','dark'])for(const width of [1024,1440])for(const scale of [1,2]){
   await page.setViewportSize({width,height:1000});await page.evaluate(({theme,scale})=>{document.documentElement.dataset.theme=theme;document.documentElement.dataset.receiptScale=scale;},{theme,scale});await review.scrollIntoViewIfNeeded();await review.focus();await H.settled(page);
   const bounds=await review.evaluate(b=>{const d=document.querySelector('#create-dialog'),r=b.getBoundingClientRect();return {width:innerWidth,root:document.documentElement.scrollWidth,left:r.left,right:r.right,top:r.top,bottom:r.bottom,scroll:d.scrollWidth,client:d.clientWidth,font:parseFloat(getComputedStyle(b).fontSize),focused:document.activeElement===b};});assert(bounds.root<=width+1&&bounds.scroll<=bounds.client+1&&bounds.left>=0&&bounds.right<=width+1&&bounds.top>=0&&bounds.bottom<=1000&&bounds.focused);if(scale===2)assert.equal(bounds.font,28);layouts.push({theme,width,scale,bounds});if(width===1440&&scale===1)await page.screenshot({path:path.join(out,'task-receipts-'+theme+'.png'),animations:'disabled'});
  }
  await page.evaluate(()=>document.documentElement.dataset.receiptScale=1);await review.click();await settled();assert.match(await status.innerText(),/原任务已受理/);assert.equal(await page.locator('#task-goal').inputValue(),'回执异常之后保留的后续修改');assert.equal(posts.length,1);await page.locator('[data-task-submission-open]').click();await form.waitFor({state:'hidden'});await page.waitForFunction(id=>state.selected===id,accepted.run.run_id);assert.equal(await count(),1);
  pass('合法只读回执找回已受理任务，后续输入保留，打开原任务不发送第二次创建请求');

  await open(agent.id);await fill('刷新后沿用编号的目标');await page.route('**/api/tasks',async route=>{const response=await route.fetch();assert.equal(response.status(),202);const packet=await response.json();packet.run.snapshot.agent_profile.revision+=1;await route.fulfill({status:202,json:packet});});await submit();await settled();await page.unroute('**/api/tasks');assert.match(await error.innerText(),/不匹配/);assert.equal(await count(),2);const secondToken=posts.at(-1).request_id;
  await page.reload();await page.waitForFunction(()=>state.connected&&!state.busy);await open(agent.id);assert.equal(await page.evaluate(()=>taskJourney.submission.payload.request_id),secondToken);assert.equal(await page.evaluate(()=>taskJourney.submission.payload.goal),'刷新后沿用编号的目标');assert.equal(await page.locator('#task-goal').inputValue(),'刷新后沿用编号的目标');await fill('刷新后沿用编号的目标');await H.settled(page);await page.locator('[data-task-submission-retry]').click();await form.waitFor({state:'hidden'});assert.equal(posts.at(-1).request_id,secondToken);assert.equal(await count(),2);
  pass('智能体版本不匹配的成功响应保留恢复记录，刷新后沿用同一编号重试且不重复创建');

  await open(agent.id);await fill('核对当前智能体配置');await page.route('**/api/tasks',route=>route.fulfill({status:503,json:{error:'合成提交失败'}}));await submit();await settled();await page.unroute('**/api/tasks');const thirdToken=posts.at(-1).request_id;
  const agentPattern='**/api/agents/'+agent.id;await page.route(agentPattern,async route=>{const response=await route.fetch(),packet=await response.json();packet.id='unrelated-agent';await route.fulfill({json:packet});});await review.click();await settled();assert.match(await status.innerText(),/智能体配置不匹配/);assert.equal(await page.locator('[data-task-submission-use]').count(),0);assert.equal(await count(),2);await page.unroute(agentPattern);
  await review.click();await settled();await page.locator('[data-task-submission-use]').click();await submit();await form.waitFor({state:'hidden'});assert.equal(posts.at(-1).request_id,thirdToken);assert.equal(await count(),3);
  pass('未找到任务时也核对返回的智能体身份，明确采用合法配置后仍沿用原编号提交');
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({checks,errors,layouts,posts:posts.map(p=>({request_id:p.request_id,agent_revision:p.agent_revision})),tasks:await count(),realModelCalls:0},null,2));
 }catch(e){await page.screenshot({path:path.join(out,'failure.png')}).catch(()=>{});fs.writeFileSync(path.join(out,'failure.json'),JSON.stringify({checks,errors,error:e.stack,text:await page.locator('body').innerText()},null,2));throw e;}finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
