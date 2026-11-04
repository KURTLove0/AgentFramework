'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{chromium}=require('playwright');
const {waitFor}=require('./browser_poll.cjs');
const base=process.env.LEARNING_REQUEST_URL,out=process.env.LEARNING_REQUEST_OUTPUT;if(!base||!out)throw Error('Use the learning-requests browser suite.');fs.mkdirSync(out,{recursive:true});
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),checks=[],errors=[],posts=[],layouts=[];
 page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST'&&new URL(r.url()).pathname==='/api/learning-proposals')posts.push(r.postDataJSON());});
 const call=(url,data)=>page.evaluate(({url,data})=>api(url,data),{url,data});
 const ready=()=>page.waitForFunction(()=>state.connected&&!state.busy);
 const action=name=>page.locator('[data-learning-request="'+name+'"]');
 const close=async()=>{await page.locator('#learning-dialog .dialog-head [data-learning-close]').click();await page.locator('#learning-dialog').waitFor({state:'hidden'});};
 const open=async()=>{await page.locator('[data-new-ontology]').first().click();await page.locator('#learning-instruction').waitFor();};
 const shot=name=>page.screenshot({path:path.join(out,name+'.png'),animations:'disabled'});
 const pass=message=>{checks.push(message);console.log('PASS '+message);};
 try{
  await page.goto(base);await ready();const workspace=await call('/api/workspaces',{name:'生成请求恢复验收',business:'离线测试',scenario:'请求恢复',description:'临时数据',revision:0});
  await page.goto(base+'?workspace_id='+workspace.id+'#/library');await ready();
  const definition=(await call('/api/agent-definition-default?domain=general-assistant%401.0.0')).definition;
  const agent=await call('/api/agents',{name:'生成恢复助手',description:'离线验收',runtime:'mock',model:'builtin',options:{},prompt:'保留原始依据',skills:[],mcp_servers:[],definition,revision:0});
  const source=await call('/api/knowledge/assets',{title:'会议来源',content:{text:'会议纪要包含负责人、行动项和原始依据。'}});for(const op of ['review','publish'])await call('/api/knowledge/assets/'+encodeURIComponent(source.ref)+'/'+op,{});
  await page.reload();await ready();await page.locator('#hub-tab-ontology').click();await open();await page.locator('#learning-agent').selectOption(agent.id);await page.locator('[data-ontology-source]').check();await page.locator('#learning-operational').uncheck();await page.locator('#learning-instruction').fill('fixture-hold-learning');await page.locator('[data-learning-generate]').click();
  await waitFor(async()=>(await call('/__test/proposal-gates')).active===1,'Offline generation did not enter the gate');assert(await page.locator('#learning-dialog .dialog-head [data-learning-close]').isEnabled());assert(await page.locator('#learning-agent').isDisabled());assert(await page.locator('#learning-instruction').isEnabled());
  await page.locator('#learning-instruction').fill('后续要求：补充负责人，保留原结果');await close();await page.reload();await ready();await page.locator('[data-learning-resume="ontology"]').click();await page.locator('#learning-instruction').waitFor();assert.equal(await page.locator('#learning-instruction').inputValue(),'后续要求：补充负责人，保留原结果');
  await action('check').click();await page.waitForFunction(()=>learningRequestEditor.receipt?.status==='GENERATING');assert.equal((await call('/__test/proposal-gates')).calls.length,1);assert.equal(posts.length,1);assert(await page.locator('[data-learning-generate]').isDisabled());
  pass('模型仍在处理时可关闭并刷新，原请求与后续要求恢复；只读核对不增加生成调用');
  await call('/__test/proposal-gates',{release:'learning'});await waitFor(async()=> (await call('/api/learning-requests/'+posts[0].request_id)).status==='DRAFT','Original generation did not finish');await action('check').click();await action('result').waitFor();
  for(const theme of ['light','dark'])for(const width of [1024,1280,1440,1920]){
   await page.setViewportSize({width,height:1000});await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);await page.locator('#learning-request-recovery').scrollIntoViewIfNeeded();
   const bounds=await page.locator('#learning-dialog').evaluate(e=>{const b=e.querySelector('[data-learning-request=result]'),r=b.getBoundingClientRect();return {overflow:e.scrollWidth>e.clientWidth,actionVisible:r.top>=0&&r.bottom<innerHeight&&b.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))};});assert(!bounds.overflow);assert(bounds.actionVisible);layouts.push({theme,width,...bounds});if(width===1440)await shot('learning-request-'+theme);
  }
  await action('result').click();await page.locator('[data-ontology-field=name]').waitFor();assert.equal((await call('/__test/proposal-gates')).calls.length,1);assert.equal(await page.evaluate(()=>learningRequestEditor.record.phase),'draft');assert.equal((await call('/api/learning-proposals?purpose=ontology')).proposals.length,1);
  pass('原结果明确采用后进入审阅，后续要求保留；四种宽度和明暗主题的恢复操作均可见');
  await action('continue').click();await page.locator('#learning-instruction').waitFor();assert.equal(await page.locator('#learning-instruction').inputValue(),'后续要求：补充负责人，保留原结果');assert.equal(await page.locator('#learning-operational').isChecked(),false);assert.equal(await page.locator('#learning-consent').isChecked(),false);
  let missing=true;await page.route('**/api/learning-proposals',route=>{if(route.request().method()==='POST'&&missing){missing=false;return route.abort('failed');}return route.continue();});
  await page.locator('[data-learning-generate]').click();await page.waitForFunction(()=>learningRequestEditor.record?.phase==='pending'&&!learningRequestEditor.busy);await action('check').click();await action('retry').waitFor();await page.locator('#learning-instruction').fill('下一次再补充期限');await action('retry').click();await page.locator('[data-ontology-field=name]').waitFor();assert.deepEqual(posts[1],posts[2]);assert.equal((await call('/__test/proposal-gates')).calls.length,2);assert.equal((await call('/api/learning-proposals?purpose=ontology')).proposals.length,2);await page.unroute('**/api/learning-proposals');
  pass('未送达请求按原编号、内容与来源重试，后续编辑不混入请求，只产生一份新提案');
  await close();await page.goto(base+'?workspace_id=workspace-default#/library');await ready();assert.equal(await page.locator('[data-learning-resume]').count(),0);await page.goto(base+'?workspace_id='+workspace.id+'#/library');await ready();await page.locator('[data-learning-resume="ontology"]').click();await page.locator('#learning-instruction').waitFor();assert.equal(await page.locator('#learning-instruction').inputValue(),'下一次再补充期限');await close();
  pass('切换工作空间不显示其他空间的原请求；返回后保留未发送的后续要求');
  const task=await call('/api/tasks',{request_id:'learning-retro-task',goal:'整理离线会议纪要',agent_id:agent.id,agent_revision:1});await waitFor(async()=>(await call('/api/tasks/'+task.run.run_id)).run.status==='SUCCEEDED','Retrospective task did not finish');
  await page.evaluate(()=>navigate('runs'));await ready();await page.locator('[data-retrospective="'+task.run.run_id+'"]').click();await page.locator('#learning-agent').selectOption(agent.id);
  let release,committed=false;await page.route('**/api/learning-proposals',async route=>{if(route.request().method()!=='POST')return route.continue();const response=await route.fetch();committed=true;await new Promise(r=>release=r);await route.fulfill({response});});
  await page.locator('#learning-instruction').fill('复盘本轮实际结果');await page.locator('[data-learning-generate]').click();await waitFor(()=>committed,'Retrospective did not save before reply delay');await close();await page.locator('[data-learning-resume="retrospective"]').click();await page.locator('#learning-instruction').waitFor();release();await page.waitForTimeout(150);assert.equal(await page.evaluate(()=>learningUI.current),null);
  await action('check').click();await action('result').waitFor();await page.evaluate(()=>navigate('agents'));await page.locator('#learning-dialog').waitFor({state:'hidden'});await ready();await page.evaluate(()=>navigate('runs'));await ready();await page.locator('[data-learning-resume="retrospective"]').click();await action('check').click();await action('result').waitFor();await action('result').click();await page.locator('[data-review-summary]').waitFor();assert.equal((await call('/__test/proposal-gates')).calls.length,3);assert.equal((await call('/api/learning-proposals?purpose=retrospective&run_id='+task.run.run_id)).proposals.length,1);
  pass('复盘迟到回复不能覆盖重新打开的窗口；切换页面保留入口，核对后仅恢复同一份结果');
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({checks,errors,layouts,posts:posts.length,generators:await call('/__test/proposal-gates'),workspace:workspace.id},null,2));
 }catch(error){await shot('failure').catch(()=>{});fs.writeFileSync(path.join(out,'failure.json'),JSON.stringify({checks,errors,error:error.stack,text:await page.locator('body').innerText()},null,2));throw error;}
 finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
