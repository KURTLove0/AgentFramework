'use strict';
// Exercises the real application against a disposable fixture with no model service.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright');
const base=process.env.WORKFLOW_QUEUE_URL;if(!base)throw Error('Set WORKFLOW_QUEUE_URL to the isolated fixture.');
const output=process.env.WORKFLOW_QUEUE_OUTPUT||'/private/tmp/workflow-queue';fs.mkdirSync(output,{recursive:true});
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),checks=[],errors=[];
 page.setDefaultTimeout(12000);page.on('pageerror',error=>errors.push(error.message));
 const call=(url,data)=>page.evaluate(({url,data})=>api(url,data),{url,data});
 const pass=message=>{checks.push(message);console.log('PASS '+message);};
 const shot=async name=>{
  await page.waitForFunction(()=>document.getAnimations().every(animation=>animation.playState!=='running'||animation.effect?.getTiming().iterations===Infinity));
  return page.screenshot({path:path.join(output,name+'.png'),animations:'disabled'});
 };
 const waitRun=async(id,status)=>{
  for(let i=0;i<120;i++){
   const detail=await call('/api/workflow-runs/'+id);
   if(detail.run.status===status&&!detail.job?.active)return detail;
   await new Promise(resolve=>setTimeout(resolve,100));
  }
  throw Error('Workflow did not reach '+status);
 };
 const open=async id=>{
  await page.goto(base+'#/workflows/'+id);
  await page.waitForFunction(id=>state.connected&&!state.busy&&state.flowDetail?.run?.id===id,id);
 };
 const start=async workflow=>{
  await page.goto(base+'#/workflows');await page.waitForFunction(()=>state.connected&&!state.busy&&state.view==='workflows');
  await page.locator('[data-start-flow="'+workflow.id+'"]').click();
  await page.locator('#flow-change').fill('change-queue-browser');
  const response=page.waitForResponse(r=>r.url().endsWith('/api/workflows/'+workflow.id+'/start')&&r.request().method()==='POST');
  await page.locator('#flow-start-form [type=submit]').click();
  const receipt=await response;assert.equal(receipt.status(),202);
  const detail=await receipt.json();await page.locator('#flow-start-dialog').waitFor({state:'hidden'});
  await page.waitForFunction(id=>state.flowDetail?.run?.id===id,detail.run.id);
  return detail;
 };
 try{
  await page.goto(base);await page.waitForFunction(()=>state.connected);
  const agent=(await call('/api/agents')).agents[0];
  const workflow=await call('/api/workflows',{name:'队列可靠性验收',description:'隔离临时数据',revision:0,nodes:[{
   id:'review',name:'审核',agent_id:agent.id,agent_revision:agent.revision,goal:'评估模拟变更并创建草稿',depends_on:[]}]});
  let detail=await start(workflow);const cancelled=detail.run.id;
  assert.equal(detail.queue.state,'QUEUED');
  await page.getByText('执行请求已保存，正在排队。可离开页面，服务运行时会自动继续。',{exact:true}).waitFor();
  assert(await page.locator('[data-resume-flow]').isDisabled());assert(await page.locator('[data-cancel-flow]').isEnabled());
  await shot('queued-start-light');await open(cancelled);
  await page.getByText('排队中',{exact:true}).waitFor();
  assert.equal((await call('/api/workflows')).runs[0].queue.state,'QUEUED');
  pass('拥堵时启动返回已接受，关闭表单并显示排队，刷新保留同一运行');

  await page.locator('[data-cancel-flow]').click();
  await page.getByText('取消请求已保存，正在停止流程。已有结果与证据会保留。',{exact:true}).waitFor();
  assert(await page.locator('[data-cancel-flow]').isDisabled());
  await call('/__test/release-queue',{});detail=await waitRun(cancelled,'CANCELLED');
  assert.equal(detail.run.nodes.review.run_id,null);assert.equal(detail.queue,null);
  pass('排队中取消请求被保留，容量恢复后结束，未启动业务节点');

  await call('/__test/fill-queue',{});detail=await start(workflow);const granted=detail.run.id;
  await call('/__test/release-queue',{});detail=await waitRun(granted,'WAITING_AUTH');
  const child=detail.run.nodes.review.run_id;assert.equal(detail.children.review.draft_count,0);
  await open(granted);await page.locator('[data-grant-flow]').waitFor();
  await call('/__test/fill-queue',{});
  const grantResponse=page.waitForResponse(r=>r.url().endsWith('/api/workflow-runs/'+granted+'/grant')&&r.request().method()==='POST');
  await page.locator('[data-grant-flow]').click();assert.equal((await grantResponse).status(),202);
  await page.getByText('授权已保存，正在排队继续流程，无需重复授权。',{exact:true}).waitFor();
  assert(await page.locator('[data-grant-flow]').isDisabled());assert(await page.locator('[data-resume-flow]').isDisabled());
  await open(granted);await page.getByText('授权已保存，正在排队继续流程，无需重复授权。',{exact:true}).waitFor();
  assert.equal((await call('/api/workflow-runs/'+granted)).children.review.draft_count,0);
  for(const theme of ['light','dark'])for(const width of [1024,1440]){
   await page.setViewportSize({width,height:900});await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
   assert(await page.locator('.flow-run-progress [role=status]').getAttribute('aria-atomic')==='true');
   if(width===1440)await shot('queued-grant-'+theme);
  }
  pass('拥堵时授权和续跑一起保存，刷新保留授权，深浅主题与桌面窗口显示正常');
  await call('/__test/release-queue',{});detail=await waitRun(granted,'SUCCEEDED');
  const result=await call('/api/tasks/'+child);
  assert.equal(detail.children.review.draft_count,1);assert.equal(result.external.calls['report.draft.create@1.0.0'],1);
  assert.equal(detail.queue,null);assert.deepEqual(errors,[]);
  pass('容量恢复后自动继续原节点，草稿创建一次，排队状态清除');
  fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({checks,errors,cancelled,granted},null,2));
 }catch(error){await shot('failure').catch(()=>{});fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({checks,errors,error:error.message,text:await page.locator('body').innerText()},null,2));throw error;}
 finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
