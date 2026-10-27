'use strict';
// Explicit disposable preview URL is required: never writes to the daily workspace.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright');
const base=process.env.SIMPLE_TASK_BASE_URL;if(!base)throw Error('Set SIMPLE_TASK_BASE_URL to an isolated preview.');
const output=process.env.SIMPLE_TASK_OUTPUT||'/private/tmp/agent-framework-simple-tasks/results';fs.mkdirSync(output,{recursive:true});
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1360,height:960}}),errors=[],checks=[];
 page.on('pageerror',e=>errors.push(e.message));const pass=s=>{checks.push(s);console.log('PASS '+s);};
 const call=(url,data)=>page.evaluate(({url,data})=>api(url,data),{url,data});
 const open=async()=>{await page.evaluate(()=>newTask());await page.locator('#create-dialog[open]').waitFor();};
 const next=()=>page.locator('[data-agent-config-direction="1"]').click();
 const save=async id=>{await next();const response=page.waitForResponse(r=>r.url().endsWith('/api/agents'+(id?'/'+id:''))&&r.request().method()==='POST');await page.locator('#agent-save').click();const result=await response;assert(result.ok(),await result.text());await page.locator('#agent-dialog').waitFor({state:'hidden'});return result.json();};
 try{
  await page.goto(base+'/#/agents');await page.waitForFunction(()=>state.meta);const initialTotal=(await call('/api/runs')).counts.total;await page.locator('[data-action="new-agent"]').first().waitFor();
  await page.locator('[data-action="new-agent"]').first().click();await page.locator('#agent-dialog[open]').waitFor();
  assert.equal(await page.locator('#agent-execution-template').count(),0);assert.equal(await page.evaluate(()=>state.roleDefinition.domain_pack_ref),'general-assistant@1.0.0');
  await page.locator('#agent-name').fill('客户回访助手');await next();await page.locator('#agent-runtime').selectOption('mock');await page.waitForFunction(()=>!state.agentModelsLoading);
  const prompt='你是一名客户支持专员。先识别问题，再输出两段回访邮件。语气自然，不添加未提供的事实。';await page.locator('#agent-prompt').fill(prompt);
  await page.screenshot({path:path.join(output,'custom-execution.png'),animations:'disabled'});let agent=await save();assert.equal(agent.prompt,prompt);assert.equal(agent.definition.domain_pack_ref,'general-assistant@1.0.0');pass('新智能体自由填写执行指令，未出现固定模板选择，配置完整保存');
  await open();assert.equal(await page.locator('#create-dialog :is(input,select,textarea):visible').count(),2);assert.equal(await page.locator('#task-goal').inputValue(),'');assert.equal(await page.locator('#create-dialog [data-task-section],#task-review,#task-permissions,#task-next').count(),0);assert.doesNotMatch(await page.locator('#create-dialog').innerText(),/审查|许可|下一步|测试|TEST/);
  await page.locator('#create-dialog button[type="submit"]').click();assert(await page.locator('#create-error').isVisible());assert.equal(await call('/api/runs').then(d=>d.counts.total),initialTotal);pass('新建任务只有目标和执行智能体，缺少目标时原地提示，不创建任务');
  await page.locator('#task-goal').fill('为客户整理一份处理计划，列出时间安排。');await page.locator('#task-agent').selectOption('');await page.locator('#create-dialog button[type="submit"]').click();assert(await page.locator('#create-error').isVisible());assert.equal(await call('/api/runs').then(d=>d.counts.total),initialTotal);
  await page.locator('#task-agent').selectOption(agent.id);
  // Simulate a recoverable request failure without changing persisted task state.
  await page.route('**/api/tasks',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'暂时无法提交，请重试'})}),{times:1});
  await page.locator('#create-dialog button[type="submit"]').click();await page.waitForFunction(()=>!taskJourney.saving);assert.equal(await page.locator('#task-goal').inputValue(),'为客户整理一份处理计划，列出时间安排。');assert.equal(await page.locator('#task-agent').inputValue(),agent.id);assert(await page.locator('#create-error').isVisible());pass('缺少智能体会提示，提交失败保留目标与选择，可直接重试');
  let sent;const posted=page.waitForResponse(r=>r.url().endsWith('/api/tasks')&&r.request().method()==='POST');
  page.on('request',r=>{if(r.url().endsWith('/api/tasks')&&r.method()==='POST')sent=r.postDataJSON();});
  await page.locator('#create-dialog button[type="submit"]').click();const response=await posted;assert.equal(response.status(),202,await response.text());const created=await response.json();await page.locator('#create-dialog').waitFor({state:'hidden'});
  assert.deepEqual(Object.keys(sent).sort(),['agent_id','agent_revision','clear_draft','goal','request_id'].sort());assert.equal(created.grant.valid,false);
  await page.waitForFunction(async id=>(await api('/api/runs/'+id)).run.status==='SUCCEEDED',created.run.run_id);await page.waitForFunction(id=>state.detail?.run.run_id===id&&state.detail.run.status==='SUCCEEDED',created.run.run_id);
  assert((await page.locator('.task-chat-answer').innerText()).includes('处理计划'));assert.equal(await page.locator('.phase-bar').count(),0);pass('一次提交直接开始执行，结果按任务内容显示，未预授予写入权限');
  const duplicate=await call('/api/tasks',sent);assert.equal(duplicate.run.run_id,created.run.run_id);assert.equal((await call('/api/runs')).counts.total,initialTotal+1);pass('重试同一次提交返回同一任务，避免重复创建');
  // Return from agent configuration must preserve the goal.
  await open();await page.locator('#task-goal').fill('返回后仍保留的任务目标');await page.locator('#task-agent').selectOption(agent.id);await page.locator('[data-action="task-configure-agent"]').click();await page.locator('#agent-dialog[open]').waitFor();await page.locator('#agent-dialog [data-close]').first().click();await page.locator('#agent-dialog').waitFor({state:'hidden'});await page.locator('[data-action="return-task-draft"]').first().click();await page.locator('#create-dialog[open]').waitFor();assert.equal(await page.locator('#task-goal').inputValue(),'返回后仍保留的任务目标');assert.doesNotMatch(await page.locator('#create-dialog').innerText(),/审查|许可/);pass('调整智能体后返回，任务目标保留，无新增审查步骤');
  const layouts=[];
  for(const theme of ['light','dark'])for(const width of [1360,768,375]){await page.setViewportSize({width,height:width===375?812:960});await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);const box=await page.locator('#create-dialog button[type="submit"]').boundingBox();assert(box&&box.y>=0&&box.y+box.height<=(width===375?812:960));assert(box.height>=44);const frame=await page.locator('#create-dialog').boundingBox();assert(box.y+box.height<=frame.y+frame.height);assert(await page.locator('#create-form button[type=submit]').evaluate(e=>{const r=e.getBoundingClientRect();return e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))}));assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));const dialog=await page.locator('#create-dialog').evaluate(e=>({width:e.clientWidth,scroll:e.scrollWidth}));assert(dialog.scroll<=dialog.width);await page.screenshot({path:path.join(output,'simple-task-'+theme+'-'+width+'.png'),animations:'disabled'});layouts.push({theme,width});}pass('浅深色与桌面、平板、手机布局无溢出，开始按钮始终可见');
  await page.locator('#create-dialog [data-close]').first().click();if(await page.locator('#confirm-dialog').isVisible())await page.locator('#confirm-submit').click();await page.locator('#create-dialog').waitFor({state:'hidden'});
  // Old configurations offer an explicit migration, without changing their business domain or authored prompt.
  const def=(await call('/api/agent-definition-default?domain=knowledge-answer%401.0.0')).definition;
  const legacy=await call('/api/agents',{name:'历史知识助手',description:'历史来源核对',runtime:'mock',model:'builtin',options:{},prompt:'保留这段手工工作指令',skills:[],mcp_servers:[],definition:def,revision:0});
  await page.evaluate(id=>openAgent(id),legacy.id);await page.locator('#agent-dialog[open]').waitFor();await next();assert(await page.locator('[data-agent-general-execution]').isVisible());await page.locator('[data-agent-general-execution]').click();await page.waitForFunction(()=>!state.agentRoleLoading&&state.roleDefinition.domain_pack_ref==='general-assistant@1.0.0');assert.equal(await page.locator('#agent-prompt').inputValue(),'保留这段手工工作指令');const migrated=await save(legacy.id);assert.equal(migrated.definition.domain_pack_ref,'general-assistant@1.0.0');assert.equal(migrated.prompt,legacy.prompt);pass('历史智能体可主动切换为通用执行，保留手工指令');
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({checks,errors,layouts},null,2));
 }catch(error){await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({checks,errors,error:error.message},null,2));throw error;}finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
