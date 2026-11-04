'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{chromium}=require('playwright');
const {waitFor}=require('./browser_poll.cjs');
const base=process.env.FLOW_HISTORY_SYNC_URL,out=process.env.FLOW_HISTORY_SYNC_OUTPUT;
if(!base||!out)throw Error('Run workflow-history-consistency suite.');fs.mkdirSync(out,{recursive:true});
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),checks=[],errors=[],posts=[],layouts=[];
 const pass=text=>{checks.push(text);console.log('PASS '+text);};page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST'&&/\/api\/workflow-runs\/.*\/(cancel|resume|grant)$/.test(new URL(r.url()).pathname))posts.push(new URL(r.url()).pathname);});
 await page.addInitScript(()=>{const interval=setInterval;window.__historyPolls=[];window.setInterval=(fn,delay,...args)=>{const id=interval(fn,delay,...args);if(delay===1500)window.__historyPolls.push(id);return id;};});
 const call=(url,data)=>page.evaluate(({url,data})=>api(url,data),{url,data}),get=id=>call('/api/workflow-runs/'+id);
 const open=async id=>{await page.locator('[data-select-flow-run="'+id+'"]').click();await page.waitForFunction(id=>!state.busy&&state.flowDetail?.run.id===id,id);};
 const back=async()=>{await page.getByRole('link',{name:'返回工作流运行记录'}).click();await page.waitForFunction(()=>!state.busy&&!state.selected&&state.view==='workflows');};
 const failHistory=route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'历史列表暂不可用，请稍后重试'})});
 try{
  await page.goto(base+'#/workflows');await page.waitForFunction(()=>state.connected&&!state.busy);await page.evaluate(()=>window.__historyPolls.forEach(clearInterval));
  const agent=(await call('/api/agents')).agents[0],w=await call('/api/workflows',{name:'状态核对与历史一致性',description:'隔离模拟验收',revision:0,nodes:[{id:'review',name:'核对提案',agent_id:agent.id,agent_revision:agent.revision,goal:'评估模拟变更并准备草稿',depends_on:[]}]});
  const ids=[];for(let i=0;i<2;i++)ids.push((await call('/api/workflows/'+w.id+'/start',{revision:1,request_id:'history-sync-'+i,grant:false,change_id:'history-sync-'+i})).run.id);
  await call('/__test/release-queue',{});for(const id of ids)await waitFor(async()=>{const d=await get(id);return d.run.status==='WAITING_AUTH'&&!d.job?.active;},'not waiting');await call('/__test/fill-queue',{});
  await page.evaluate(async()=>{state.flowSection='runs';await loadFlows();render();});await page.locator('#flow-history-status').selectOption('WAITING_AUTH');await page.waitForFunction(()=>state.flowHistory?.data?.status==='WAITING_AUTH'&&!state.flowHistory.pending);
  await page.locator('#flow-history-search').fill('状态核对');await page.waitForFunction(()=>state.flowHistory?.data?.search==='状态核对'&&!state.flowHistory.pending);assert.equal(await page.locator('[data-select-flow-run]').count(),2);
  const cursor=await page.evaluate(()=>state.flowHistory.cursor),[cancelled,granted]=ids;await open(cancelled);
  await page.route('**/api/workflow-runs/'+cancelled+'/cancel',async route=>{const response=await route.fetch();assert.equal(response.status(),202);await route.abort('failed');});
  await page.locator('[data-cancel-flow]').click();await page.locator('[data-review-flow-control]').waitFor();await page.unroute('**/api/workflow-runs/'+cancelled+'/cancel');await page.locator('[data-review-flow-control]').click();await page.locator('#flow-control-feedback').filter({hasText:'已核对当前运行状态'}).waitFor();assert.equal(await page.evaluate(()=>state.flowDetail.run.cancel_requested),true);assert.equal(posts.length,1);
  await page.route('**/api/workflow-runs?*',failHistory);await back();await page.locator('.flow-history-error').waitFor();
  assert.equal(await page.locator('[data-select-flow-run="'+cancelled+'"]').count(),0,'Reviewed cancellation must not reappear as waiting for approval after history read failure');
  assert.equal(await page.locator('[data-select-flow-run]').count(),0);assert(!/共 0 次运行|显示 .*2 条匹配/.test(await page.locator('.flow-history-status').innerText()));assert.equal(await page.locator('#flow-history-status').inputValue(),'WAITING_AUTH');assert.equal(await page.locator('#flow-history-search').inputValue(),'状态核对');assert.equal(await page.evaluate(()=>state.flowHistory.cursor),cursor);assert(await page.locator('#flow-history-retry').isEnabled());
  pass('取消核对后返回失败的历史页，不显示已知过期的等待授权记录或数量，保留筛选与页位置并允许重试');

  await page.route('**/hig.css*',async route=>{const response=await route.fetch();await route.fulfill({response,body:(await response.text())+'\nhtml[data-history-sync-scale="2"] #content :is(p,button,label,input,select,.flow-history-status){font-size:28px!important}'});});
  await page.evaluate(()=>document.querySelector('link[href^="/hig.css"]').href='/hig.css?history-sync=2');await page.waitForFunction(()=>[...document.styleSheets].some(sheet=>{try{return [...sheet.cssRules].some(rule=>rule.cssText.includes('data-history-sync-scale'));}catch{return false;}}));
  for(const theme of ['light','dark'])for(const width of [1024,1440])for(const scale of [1,2]){
   await page.setViewportSize({width,height:1100});await page.evaluate(({theme,scale})=>{const select=document.querySelector('#appearance-select');select.value=theme;select.dispatchEvent(new Event('change',{bubbles:true}));document.documentElement.dataset.historySyncScale=String(scale);},{theme,scale});
   await page.locator('#flow-history-retry').focus();await page.locator('#flow-history-retry').scrollIntoViewIfNeeded();const bounds=await page.locator('#flow-history-retry').evaluate(el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,font:parseFloat(getComputedStyle(el).fontSize),focused:el===document.activeElement,root:document.documentElement.scrollWidth};});assert(bounds.focused&&bounds.left>=0&&bounds.right<=width+1&&bounds.top>=0&&bounds.bottom<=1101&&bounds.root<=width+1&&bounds.font>=14*scale);layouts.push({theme,width,scale,bounds});if(width===1024&&scale===2)await page.screenshot({path:path.join(out,'workflow-history-consistency-'+theme+'.png'),animations:'disabled'});
  }
  await page.evaluate(()=>{delete document.documentElement.dataset.historySyncScale;});await page.unroute('**/api/workflow-runs?*');await page.locator('#flow-history-retry').focus();await page.keyboard.press('Enter');await page.waitForFunction(()=>state.flowHistory?.data?.filtered_total===1&&!state.flowHistory.pending);assert.equal(await page.locator('[data-select-flow-run]').count(),1);assert.equal(await page.locator('[data-select-flow-run]').getAttribute('data-select-flow-run'),granted);assert.equal(posts.length,1);
  pass('八组桌面主题与文字大小下重试可达，键盘重试取回一条真实匹配，不重发取消');

  await open(granted);await page.route('**/api/workflow-runs/'+granted+'/grant',async route=>{const response=await route.fetch();assert.equal(response.status(),202);await route.abort('failed');});await page.locator('[data-grant-flow]').click();await page.locator('[data-review-flow-grant]').waitFor();await page.unroute('**/api/workflow-runs/'+granted+'/grant');await page.locator('[data-review-flow-grant]').click();await page.locator('.flow-grant-feedback').filter({hasText:'已核对当前状态'}).waitFor();assert.equal(await page.evaluate(()=>state.flowDetail.queue.reason),'grant');
  await page.route('**/api/workflow-runs?*',failHistory);await back();await page.locator('.flow-history-error').waitFor();assert.equal(await page.locator('[data-select-flow-run]').count(),0);assert.equal(posts.length,2);await page.unroute('**/api/workflow-runs?*');await page.locator('#flow-history-retry').click();await page.waitForFunction(()=>state.flowHistory?.data?.filtered_total===0&&!state.flowHistory.pending);assert(await page.getByText('没有匹配的运行',{exact:true}).count());assert.equal(posts.length,2);
  pass('授权核对同样清除过期历史；重读后才显示真实零匹配，未重复授权');

  await page.locator('#flow-history-status').selectOption('all');await page.waitForFunction(()=>state.flowHistory?.data?.status==='all'&&!state.flowHistory.pending);assert.equal(await page.locator('[data-select-flow-run]').count(),2);const before=await page.locator('[data-select-flow-run]').allTextContents();await page.route('**/api/workflow-runs?*',failHistory);await page.locator('[data-flow-history-refresh]').click();await page.locator('.flow-history-error').waitFor();assert.deepEqual(await page.locator('[data-select-flow-run]').allTextContents(),before);assert((await page.locator('.flow-history-status').innerText()).includes('以下为上次读取的结果'));await page.unroute('**/api/workflow-runs?*');
  assert.equal(posts.length,2);pass('没有已知状态变化的普通刷新失败仍保留成功列表，并明确标注旧结果');
  await open(cancelled);await call('/api/workflow-runs/'+granted+'/cancel',{});await call('/__test/release-queue',{});
  for(const id of ids)await waitFor(async()=>{const d=await get(id);return d.run.status==='CANCELLED'&&!d.job?.active;},'cancellation did not finish');
  await page.route('**/api/workflow-runs?*',failHistory);await page.evaluate(async()=>{await loadFlows();render();});assert.equal(await page.evaluate(()=>state.flowDetail.run.status),'CANCELLED');await back();await page.locator('.flow-history-error').waitFor();assert.equal(await page.locator('[data-select-flow-run]').count(),0);assert(await page.locator('#flow-history-retry').isEnabled());await page.unroute('**/api/workflow-runs?*');
  await page.locator('#flow-history-retry').click();await page.waitForFunction(()=>state.flowHistory?.data&&!state.flowHistory.pending&&!state.flowHistory.error);assert.equal(await page.locator('[data-select-flow-run]').count(),2);for(const text of await page.locator('[data-select-flow-run]').allTextContents())assert(text.includes('已取消'));
  for(const id of ids)assert.equal((await get(id)).children.review.draft_count,0);assert.deepEqual(errors,[]);assert.equal(posts.length,3);
  pass('正常详情刷新发现最终取消后也清除过期历史，重试恢复两条已取消记录；全程没有创建草稿');
  fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({checks,errors,posts,layouts,runs:ids,originalCursor:cursor},null,2));
 }catch(error){await page.screenshot({path:path.join(out,'failure.png'),fullPage:true}).catch(()=>{});fs.writeFileSync(path.join(out,'failure.json'),JSON.stringify({checks,errors,error:error.stack,text:await page.locator('body').innerText()},null,2));throw error;}
 finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
