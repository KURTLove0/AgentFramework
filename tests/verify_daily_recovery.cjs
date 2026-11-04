'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright');
const base=process.env.DAILY_RECOVERY_URL;if(!base)throw Error('Set DAILY_RECOVERY_URL.');
const output=process.env.DAILY_RECOVERY_OUTPUT||'/private/tmp/daily-recovery';fs.mkdirSync(output,{recursive:true});
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),checks=[],errors=[],layouts=[];
 page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));
 const call=(url,data)=>page.evaluate(({url,data})=>api(url,data),{url,data});
 const pass=message=>{checks.push(message);console.log('PASS '+message);};
 const shot=name=>page.screenshot({path:path.join(output,name+'.png'),animations:'disabled'});
 const post=url=>page.waitForResponse(response=>response.request().method()==='POST'&&response.url().endsWith(url));
 try{
  await page.goto(base+'#/daily');await page.waitForFunction(()=>state.connected&&!state.busy&&state.dailyOperations);
  const agent=(await call('/api/agents')).agents[0];
  const task=goal=>({agent_id:agent.id,agent_revision:agent.revision,goal,change_id:'change-daily-browser',grant:true,consent:false,mcp_consent:false});
  const config={revision:0,enabled:false,timezone:'Asia/Shanghai',daily_time:'00:00',auto_start:true,tasks:[task('核对原目标一'),task('核对原目标二')]};
  await call('/api/workspace-schedule',config);const plan=await call('/api/daily-plans/generate',{}),url='/api/daily-plans/'+plan.id+'/dispatch';
  await page.evaluate(()=>refresh());await call('/__test/fail-next-start',{});
  let response=post(url);await page.locator('[data-dispatch-plan="'+plan.id+'"]').click();assert.equal((await response).status(),500);
  await page.evaluate(()=>refresh());await page.getByText('派发中断',{exact:true}).waitFor();await page.getByRole('button',{name:'重试原计划',exact:true}).waitFor();
  let overview=await call('/api/workspace-schedule'),original=overview.plans[0];assert.equal(original.dispatch.state,'FAILED');assert.equal((await call('/api/runs')).counts.total,1);
  const first=original.items[0].run_id,grantBefore=(await call('/api/runs/'+first)).grant.expires_at;
  await shot('failed-original-plan');pass('执行器拒绝后保存中断原因，提供显式重试且不重复创建首项任务');
  await page.evaluate(()=>navigate('workbench'));await page.getByText('每日计划派发中断，等待重试',{exact:true}).waitFor();
  await page.locator('.attention-item').filter({hasText:'每日计划派发中断，等待重试'}).getByRole('link',{name:'查看诊断'}).click();await page.waitForFunction(()=>state.view==='daily'&&!state.busy);pass('工作台待办显示真实派发中断原因并可返回原计划处理');

  await call('/api/workspace-schedule',{...config,revision:1,tasks:[task('后续新目标')]});
  const regenerated=await call('/api/daily-plans/generate',{});assert.equal(regenerated.schedule_revision,1);assert.equal(regenerated.items.length,2);
  await page.evaluate(()=>refresh());await page.getByText('已接受的计划保留原目标与版本，新设置用于后续计划。',{exact:true}).waitFor();
  response=post(url);await page.getByRole('button',{name:'重试原计划',exact:true}).click();assert.equal((await response).status(),200);
  await page.getByText('自动启动请求已保存，正在排队。服务运行时会继续原任务，无需重复派发。',{exact:true}).waitFor();
  assert.equal(await page.locator('[data-dispatch-plan="'+plan.id+'"]').count(),0);
  overview=await call('/api/workspace-schedule');original=overview.plans.find(p=>p.id===plan.id);assert.equal(original.status,'QUEUED');assert.equal(original.dispatch.state,'PENDING');assert.equal(original.items[0].run_id,first);
  const ids=original.items.map(item=>item.run_id);assert(ids.every(Boolean));assert.equal((await call('/api/runs')).counts.total,2);pass('修改模板后重试保留原目标和版本，容量不足时完整保存两项任务及自动启动请求');

  await page.reload();await page.waitForFunction(()=>state.connected&&!state.busy&&state.dailyOperations?.plans.some(p=>p.status==='QUEUED'));
  for(const theme of ['light','dark'])for(const width of [1440,1024]){
   await page.setViewportSize({width,height:1000});await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
   const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);assert(!overflow);layouts.push({theme,width,overflow});await shot('queued-'+theme+'-'+width);
  }
  assert.equal((await call('/api/runs/'+first)).grant.expires_at,grantBefore);pass('刷新和桌面深浅色布局保留排队状态，重试不延长原任务授权');

  await call('/__test/release-queue',{});let complete=false;
  for(let i=0;i<300;i++){
   const results=await Promise.all(ids.map(id=>call('/api/runs/'+id)));
   if(results.every(result=>result.run.status==='SUCCEEDED'&&!result.job?.active)){complete=true;break;}
   await new Promise(resolve=>setTimeout(resolve,100));
  }
  assert(complete,'saved starts did not resume in the background');
  for(const id of ids){const detail=await call('/api/runs/'+id);assert.equal(detail.external.drafts.length,1);assert.equal(detail.external.calls['report.draft.create@1.0.0'],1);}
  assert.equal((await call('/api/runs')).counts.total,2);await page.evaluate(()=>refresh());await shot('recovered-original-tasks');pass('关闭定时期间容量恢复仍自动执行原任务，每项只创建一次草稿');
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({checks,errors,layouts,plan:plan.id,runs:ids},null,2));
 }catch(error){await shot('failure').catch(()=>{});fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({checks,errors,error:error.message,text:await page.locator('body').innerText()},null,2));throw error;}finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
