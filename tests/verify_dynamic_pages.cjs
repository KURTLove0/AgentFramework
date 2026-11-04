'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{chromium}=require('playwright');
const base=process.env.DYNAMIC_PAGES_URL,out=process.env.DYNAMIC_PAGES_OUTPUT;
if(!base||!out)throw Error('Run dynamic-pages browser suite');fs.mkdirSync(out,{recursive:true});
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1100},reducedMotion:'reduce'}),checks=[],errors=[],layouts=[],posts=[];
 page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST')posts.push(new URL(r.url()).pathname);});
 const pass=text=>{checks.push(text);console.log('PASS '+text);},call=(url,data)=>page.evaluate(({url,data})=>api(url,data),{url,data});
 await page.addInitScript(()=>{const interval=setInterval;window.__dynamicPolls=[];window.setInterval=(fn,delay,...args)=>{const id=interval(fn,delay,...args);if(delay===1500)window.__dynamicPolls.push(id);return id;};});
 await page.route('**/hig.css*',async route=>{const response=await route.fetch();await route.fulfill({response,body:(await response.text())+'\nhtml[data-dynamic-scale="2"] #content :is(p,button,label,input,select,.flow-history-status,.evaluation-history-status){font-size:28px!important}'});});
 async function open(route){await page.goto(base+'#/'+route);await page.waitForFunction(()=>state.connected&&!state.busy);await page.evaluate(()=>window.__dynamicPolls.forEach(clearInterval));}
 async function layout(name,button){
  for(const theme of ['light','dark'])for(const width of [1024,1440])for(const scale of [1,2]){
   await page.setViewportSize({width,height:1100});await page.evaluate(({theme,scale})=>{const select=document.querySelector('#appearance-select');select.value=theme;select.dispatchEvent(new Event('change',{bubbles:true}));document.documentElement.dataset.dynamicScale=String(scale);},{theme,scale});
   await button.focus();await button.scrollIntoViewIfNeeded();const bounds=await button.evaluate(el=>{const r=el.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,font:parseFloat(getComputedStyle(el).fontSize),focused:document.activeElement===el,root:document.documentElement.scrollWidth};});
   assert(bounds.focused&&bounds.left>=0&&bounds.right<=width+1&&bounds.top>=0&&bounds.bottom<=1101&&bounds.root<=width+1&&bounds.font>=14*scale);layouts.push({name,theme,width,scale,bounds});
   if(width===1024&&scale===2)await page.screenshot({path:path.join(out,name+'-'+theme+'.png'),animations:'disabled'});
  }
  await page.evaluate(()=>{delete document.documentElement.dataset.dynamicScale;});
 }
 try{
  await open('workflows');await page.getByRole('tab',{name:/运行记录/}).click();await page.locator('#flow-history-status').selectOption('WAITING_INPUT');await page.waitForFunction(()=>state.flowHistory?.data?.filtered_total===51&&!state.flowHistory.pending);
  await page.locator('[data-flow-history-page="next"]').click();await page.waitForFunction(()=>state.flowHistory?.data?.offset===50&&!state.flowHistory.pending);assert.equal(await page.locator('[data-select-flow-run]').count(),1);
  await call('/__test/advance-workflow',{});await page.locator('[data-flow-history-refresh]').click();await page.getByRole('heading',{name:'当前页没有记录',exact:true}).waitFor();assert.equal(await page.locator('[data-select-flow-run]').count(),0);assert.equal(await page.evaluate(()=>state.flowHistory.data.filtered_total),50);assert(!/0–50|没有匹配的运行/.test(await page.locator('#content').innerText()));
  const firstFlow=page.getByRole('button',{name:'返回第一页',exact:true});await layout('workflow-empty',firstFlow);await firstFlow.focus();await page.keyboard.press('Enter');await page.waitForFunction(()=>state.flowHistory?.data?.runs.length===50&&!state.flowHistory.pending);assert.equal(await page.locator('#flow-history-status').inputValue(),'WAITING_INPUT');assert.equal(await page.evaluate(()=>document.activeElement.id),'flow-runs-heading');
  pass('工作流第二页最后一条状态变化后正确显示当前页空白；键盘返回第一页保留筛选并恢复 50 条记录');
  await page.locator('#flow-history-search').fill('不存在的运行');await page.getByRole('heading',{name:'没有匹配的运行',exact:true}).waitFor();assert.equal(await page.getByRole('heading',{name:'当前页没有记录',exact:true}).count(),0);
  pass('工作流真正零匹配使用独立文案，不将所有空页当成分页失效');

  await open('evaluations');await page.locator('#evaluation-history-verdict').selectOption('PASS');await page.waitForFunction(()=>state.evaluationHistory?.data?.filtered_total===51&&!state.evaluationHistory.pending);
  await page.locator('#evaluation-history-next').click();await page.waitForFunction(()=>state.evaluationHistory?.data?.offset===50&&!state.evaluationHistory.pending);await call('/__test/advance-evaluation',{});await page.locator('#evaluation-history-refresh').click();await page.getByRole('heading',{name:'当前页没有记录',exact:true}).waitFor();assert.equal(await page.evaluate(()=>state.evaluationHistory.data.filtered_total),50);assert(!/0–50|没有符合条件的评测/.test(await page.locator('#evaluation-history-panel').innerText()));
  const firstEvaluation=page.getByRole('button',{name:'返回第一页',exact:true});await layout('evaluation-empty',firstEvaluation);await firstEvaluation.focus();await page.keyboard.press('Enter');await page.waitForFunction(()=>state.evaluationHistory?.data?.reports.length===50&&!state.evaluationHistory.pending);assert.equal(await page.locator('#evaluation-history-verdict').inputValue(),'PASS');assert.equal(await page.evaluate(()=>document.activeElement.id),'evaluation-history-title');
  pass('评测第二页最后一条结论变化后显示当前页空白，返回第一页保留结论与范围，计数没有虚假区间');
  await page.locator('#evaluation-history-search').fill('不存在的评测');await page.getByRole('heading',{name:'没有符合条件的评测',exact:true}).waitFor();pass('评测真正零匹配仍提供调整筛选的说明');

  await open('runs');await page.locator('#status-filter').selectOption('SUCCEEDED');await page.waitForFunction(()=>state.runPage?.filtered_total===51&&!state.runHistory.pending);await page.locator('[data-run-page="next"]').click();await page.waitForFunction(()=>state.runCursorStack.length===1&&state.runs.length===1&&!state.runHistory.pending);
  const id=await page.evaluate(()=>state.runs[0].run_id),detail=await call('/api/tasks/'+id);await call('/api/tasks/'+id+'/archive',{archived:true,revision:detail.conversation.archive.revision});await page.locator('#run-history-refresh').click();await page.getByRole('heading',{name:'当前页没有记录',exact:true}).waitFor();assert.equal(await page.evaluate(()=>state.runPage.filtered_total),50);
  const firstRun=page.getByRole('button',{name:'返回第一页',exact:true});await layout('task-empty',firstRun);await firstRun.focus();await page.keyboard.press('Enter');await page.waitForFunction(()=>state.runs.length===50&&!state.runHistory.pending);assert.equal(await page.locator('#status-filter').inputValue(),'SUCCEEDED');assert.equal(await page.evaluate(()=>document.activeElement.id),'runs-heading');
  pass('任务第二页最后一条归档后显示当前页空白；返回第一页保留状态及归档范围');
  await page.locator('#run-search').fill('不存在的任务');await page.getByRole('heading',{name:'没有匹配的运行',exact:true}).waitFor();pass('任务真正零匹配显示清除筛选入口');
  assert.deepEqual(errors,[]);assert.equal(posts.length,3);pass('三类历史共 24 组桌面主题、宽度及放大文字检查通过，返回第一页仅发 GET');
  fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({checks,errors,layouts,posts},null,2));
 }catch(error){await page.screenshot({path:path.join(out,'failure.png'),fullPage:true}).catch(()=>{});fs.writeFileSync(path.join(out,'failure.json'),JSON.stringify({checks,errors,error:error.stack,text:await page.locator('body').innerText()},null,2));throw error;}
 finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
