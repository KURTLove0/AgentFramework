'use strict';
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path');
const h=require('../../tests/ui95_helpers.cjs');
const out=__dirname,base=process.env.AGENT_UI_BASE_URL||'http://127.0.0.1:8801',label=process.env.PM_AUDIT_LABEL||'initial';
(async()=>{
 fs.mkdirSync(path.join(out,'screenshots'),{recursive:true});
 const browser=await chromium.launch({channel:'chrome',headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),results=[];await page.emulateMedia({reducedMotion:'reduce'});
 try{
  const space=await h.workspace(page,'独立PM定向评审');
  const agent=await h.agent(page,'knowledge-answer@1.0.0','资料核对助理');
  await h.nav(page,'agents');
  await page.locator('.agent-col-actions a').click();
  await page.waitForFunction(()=>state.selected&&!state.busy&&state.connected);
  await page.locator('#agent-back-to-list').click();await page.waitForFunction(()=>!state.selected&&!state.busy);
  const arrowFocus=await page.evaluate(()=>document.activeElement.id||document.activeElement.tagName);
  results.push({id:'row-arrow-return-focus',expected:'原智能体详情链接或右侧箭头',actual:arrowFocus,pass:['agent-open-'+agent.id,'agent-inspect-'+agent.id].includes(arrowFocus)});
  await page.locator('#agent-open-'+agent.id).click();await page.waitForFunction(()=>state.selected&&!state.busy);
  await page.screenshot({path:path.join(out,'screenshots',label+'-detail.png'),fullPage:true,animations:'disabled'});
  let archived=false,archivePosts=0;
  await page.route('**/api/agents',async route=>{
   if(archived&&route.request().method()==='GET')await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'PM定向复验：归档成功后的列表读取失败'})});else await route.continue();
  });
  await page.route('**/api/agents/'+agent.id+'/archive',async route=>{archivePosts++;await new Promise(r=>setTimeout(r,700));await route.continue();});
  page.on('response',response=>{if(response.url().endsWith('/archive')&&response.request().method()==='POST'&&response.ok())archived=true;});
  await page.locator('[data-archive-agent]').click();
  await page.waitForFunction(()=>document.querySelector('[data-archive-agent]')?.disabled===true);
  await page.evaluate(()=>render());
  const pending=await page.locator('[data-archive-agent]').isDisabled();
  await page.locator('[data-archive-agent]').dispatchEvent('click');
  await page.waitForFunction(()=>document.querySelector('[data-archive-agent]')?.disabled===false);
  results.push({id:'archive-render-pending',pendingSurvivedRender:pending,posts:archivePosts,pass:pending&&archivePosts===1});
  const after=await page.evaluate(id=>({archived:state.agents.find(a=>a.id===id).archived,action:document.querySelector('[data-archive-agent]')?.innerText,startButtons:document.querySelectorAll('[data-agent-new-task],[data-agent-saved-use]').length,text:document.querySelector('.agent-detail-page')?.innerText}),agent.id);
  const stored=await page.evaluate(async id=>api('/api/agents/'+id),agent.id);
  results.push({id:'archive-authoritative-success',storedArchived:stored.archived,actual:after,pass:stored.archived&&after.archived&&after.startButtons===0&&after.action.includes('恢复')});
  await page.screenshot({path:path.join(out,'screenshots',label+'-archive-refresh-failure.png'),fullPage:true,animations:'disabled'});
  if(process.env.PM_AUDIT_LABEL){
   await page.locator('[data-archive-agent]').click();
   await page.waitForFunction(()=>document.querySelector('[data-archive-agent]')?.disabled===false);
   const restored=await page.evaluate(id=>({archived:state.agents.find(a=>a.id===id).archived,action:document.querySelector('[data-archive-agent]')?.innerText,startButtons:document.querySelectorAll('[data-agent-new-task],[data-agent-saved-use]').length,focus:document.activeElement.id}),agent.id);
   const restoredStored=await page.evaluate(async id=>api('/api/agents/'+id),agent.id);
   results.push({id:'restore-authoritative-success',storedArchived:restoredStored.archived,actual:restored,pass:!restoredStored.archived&&!restored.archived&&restored.startButtons===1&&restored.action.includes('归档')&&restored.focus==='agent-archive-'+agent.id});
   await page.unroute('**/api/agents/'+agent.id+'/archive');
   await page.route('**/api/agents/'+agent.id+'/archive',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'PM定向复验：归档提交失败，可重试'})}));
   await page.locator('[data-archive-agent]').click();await page.waitForFunction(()=>document.querySelector('[data-archive-agent]')?.disabled===false);
   const failed=await page.evaluate(id=>({archived:state.agents.find(a=>a.id===id).archived,action:document.querySelector('[data-archive-agent]')?.innerText,disabled:document.querySelector('[data-archive-agent]')?.disabled,feedback:document.querySelector('#toast')?.innerText}),agent.id);
   results.push({id:'archive-submit-failure',actual:failed,pass:!failed.archived&&!failed.disabled&&failed.action.includes('归档')&&failed.feedback.includes('归档提交失败')});
   await page.unroute('**/api/agents/'+agent.id+'/archive');await page.locator('[data-archive-agent]').click();await page.waitForFunction(()=>document.querySelector('[data-archive-agent]')?.disabled===false);
   const retried=await page.evaluate(id=>({archived:state.agents.find(a=>a.id===id).archived,startButtons:document.querySelectorAll('[data-agent-new-task],[data-agent-saved-use]').length}),agent.id);
   results.push({id:'archive-submit-retry',actual:retried,pass:retried.archived&&retried.startButtons===0});
  }
  await page.unroute('**/api/agents');
  if(process.env.PM_AUDIT_RACE==='1'){
   for(const direction of ['restore','archive']){
    await page.waitForFunction(()=>!state.busy);
    const staleList=await page.evaluate(()=>api('/api/agents'));
    let release,entered,seen=0;const gate=new Promise(r=>release=r),entry=new Promise(r=>entered=r);
    await page.route('**/api/agents',async route=>{if(seen++){await route.continue();return;}entered();await gate;await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(staleList)});});
    await page.evaluate(()=>{window.__pmRefresh=refresh();});await entry;
    await page.locator('[data-archive-agent]').click();
    await page.waitForFunction(()=>document.querySelector('[data-archive-agent]')?.disabled===false);
    const current=await page.evaluate(id=>state.agents.find(a=>a.id===id),agent.id);
    release();await page.evaluate(()=>window.__pmRefresh);await page.waitForFunction(()=>!state.busy);
    const afterStale=await page.evaluate(id=>({archived:state.agents.find(a=>a.id===id).archived,revision:state.agents.find(a=>a.id===id).revision,action:document.querySelector('[data-archive-agent]')?.innerText}),agent.id);
    results.push({id:'stale-list-cannot-revert-'+direction,mutation:{archived:current.archived,revision:current.revision},actual:afterStale,followupGets:seen-1,pass:afterStale.archived===current.archived&&afterStale.revision===current.revision});
    await page.screenshot({path:path.join(out,'screenshots',label+'-stale-list-'+direction+'.png'),fullPage:true,animations:'disabled'});
    await page.unroute('**/api/agents');
   }
  }
  fs.writeFileSync(path.join(out,label+'-audit-results.json'),JSON.stringify({space:space.id,agent:agent.id,results},null,2));
  console.log(JSON.stringify(results,null,2));
 } finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
