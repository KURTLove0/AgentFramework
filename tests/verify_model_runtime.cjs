'use strict';
// Only run against serve_model_execution_fixture.py; never against daily data.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright');
const base=process.env.MODEL_RUNTIME_TEST_URL;if(!base)throw Error('Set MODEL_RUNTIME_TEST_URL to a disposable fixture service.');
const output=process.env.MODEL_RUNTIME_OUTPUT||'/private/tmp/model-runtime-results';fs.mkdirSync(output,{recursive:true});
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000}}),checks=[],errors=[];
 page.on('pageerror',e=>errors.push(e.message));const pass=text=>{checks.push(text);console.log('PASS '+text);};
 const call=(url,data)=>page.evaluate(({url,data})=>api(url,data),{url,data});
 const start=async(agent,goal)=>{await page.evaluate(id=>newTask({agentId:id}),agent.id);await page.locator('#create-dialog[open]').waitFor();await page.locator('#task-goal').fill(goal);const response=page.waitForResponse(r=>r.url().endsWith('/api/tasks')&&r.request().method()==='POST');await page.locator('#create-form button[type=submit]').click();const result=await response;assert.equal(result.status(),202,await result.text());await page.locator('#create-dialog').waitFor({state:'hidden'});return(await result.json()).run.run_id;};
 const waitStatus=async(id,status)=>{await page.waitForFunction(async({id,status})=>(await api('/api/runs/'+id)).run.status===status,{id,status});await page.waitForFunction(({id,status})=>state.detail?.run.run_id===id&&state.detail.run.status===status,{id,status});};
 try{
  await page.goto(base);await page.waitForFunction(()=>state.meta);
  const domain=(await call('/api/agent-definition-default?domain=knowledge-answer%401.0.0')).definition;
  const agent=await call('/api/agents',{name:'运行展示验收助手',description:'按任务目标整理内容',runtime:'codex',model:'visible-fixture',options:{timeout:10,max_attempts:2,reasoning_effort:'low'},prompt:'直接交付用户请求的结果，不限定处理步骤。',skills:[],mcp_servers:[],definition:domain,revision:0});
  const id=await start(agent,'请撰写一封客户回访邮件。');
  await page.locator('.chat-process-body .is-summary').waitFor();assert.equal((await call('/api/runs/'+id)).run.status,'RUNNING');assert.equal(await page.locator('.phase-bar').count(),0);assert(await page.locator('.task-thread-main').isVisible());assert(await page.locator('.chat-process-mark.is-live').isVisible());
  assert((await page.locator('.task-turn-progress').innerText()).includes('正在整理可直接使用的内容'));assert.doesNotMatch(await page.locator('.task-thread-panel').innerText(),/生成计划|检索回读|引用回答|独立验收|PRIVATE_RUNTIME/);
  await page.screenshot({path:path.join(output,'running-light-desktop.png'),animations:'disabled'});pass('运行中即可看到真实动态和公开摘要，主界面没有固定阶段链路');
  await waitStatus(id,'SUCCEEDED');await page.locator('.task-chat-answer').waitFor();assert((await page.locator('.task-chat-answer').innerText()).includes('客户回访邮件'));assert.equal(await page.locator('.task-chat-answer img').count(),0);assert.equal(await page.evaluate(()=>window.__runtimeXss),undefined);
  const detail=await call('/api/runs/'+id);assert.equal(detail.run.model_calls,1);assert.deepEqual(detail.run.plan,[]);assert.equal(detail.run.task.execution_mode,'conversation');assert.deepEqual([...new Set(detail.events.filter(e=>e.kind==='model.requested').map(e=>e.data.phase))],['execute']);assert.doesNotMatch(JSON.stringify(detail.events),/PRIVATE_RUNTIME/);assert.equal(detail.external.drafts.length,0);pass('普通任务只有一次直接执行调用，结束后展示完整结果，输出被安全展示');
  await page.locator('.task-turn-progress>summary').click();assert((await page.locator('.task-turn-progress').innerText()).includes('已按任务要求完成交付'));await page.reload();await page.locator('.task-chat-answer').waitFor();await page.locator('.task-turn-progress>summary').click();assert((await page.locator('.task-turn-progress').innerText()).includes('正在整理可直接使用的内容'));
  await page.locator('.task-thread-properties [data-chat-inspect-run]').click();await page.locator('#task-chat-run-dialog[open]').waitFor();assert(await page.locator('.runtime-audit').isVisible());assert.equal(await page.locator('.runtime-audit').getAttribute('open'),null);await page.locator('#task-chat-run-dialog .dialog-foot [data-close]').click();pass('刷新后可回看同一次运行，完整记录折叠保存，过程摘要没有丢失');
  await page.locator('.task-turn-progress>summary').focus();await page.keyboard.press('Enter');assert.equal(await page.locator('.task-turn-progress').evaluate(e=>e.open),false);await page.keyboard.press('Enter');assert(await page.locator('.task-turn-progress').evaluate(e=>e.open));pass('运行过程支持键盘展开与收起');
  const layouts=[];
  for(const theme of ['light','dark'])for(const viewport of [{width:1440,height:1000},{width:768,height:1024},{width:375,height:812},{width:812,height:375}]){
   await page.setViewportSize(viewport);await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:path.join(output,'process-'+theme+'-'+viewport.width+'.png'),animations:'disabled'});layouts.push({theme,...viewport});
  }
  await page.emulateMedia({reducedMotion:'reduce'});await page.setViewportSize({width:375,height:812});await page.screenshot({path:path.join(output,'result-dark-mobile.png'),animations:'disabled'});pass('浅深色、桌面、平板、手机与横屏布局无溢出，支持减少动态效果');
  await page.setViewportSize({width:1440,height:1000});await page.evaluate(()=>document.documentElement.dataset.theme='light');
  const missing=await start(agent,'信息缺口验证，请拟一封邮件。');await waitStatus(missing,'WAITING_INPUT');assert((await page.locator('.chat-question').innerText()).includes('客户的问题'));assert(await page.locator('#task-chat-input').isEnabled());assert.equal(await page.locator('.phase-bar').count(),0);pass('缺少信息时展示模型的具体追问，不进入预设检索或验收步骤');
  const failed=await start(agent,'超时验证');await waitStatus(failed,'FAILED');assert((await page.locator('.chat-turn-error').innerText()).includes('模型调用超时'));assert.equal(await page.locator('.chat-process-mark.is-live').count(),0);pass('失败时保留已收到的动态，明确展示失败原因并停止运行指示');
  const cancelled=await start(agent,'取消验证，运行期间手动停止。');await page.locator('.chat-process-mark.is-live').waitFor();await page.locator('[data-chat-stop]').click();await waitStatus(cancelled,'CANCELLED');assert((await page.locator('.task-chat-turn').innerText()).includes('本轮已停止'));assert.equal(await page.locator('.chat-process-mark.is-live').count(),0);pass('取消会停止模型调用，保留已有过程记录，不伪装成成功');
  // Old workflow data remains readable without the old four-stage progress bar.
  const oldAgent=await call('/api/agents',{name:'历史知识岗位',description:'旧流程兼容',runtime:'mock',model:'builtin',options:{},prompt:'根据原文回答。',skills:[],mcp_servers:[],definition:domain,revision:0});
  const old=await call('/api/runs',{agent_id:oldAgent.id,agent_revision:1,goal:'变更评估的风险规则是什么？',start:true,grant:false});
  await page.evaluate(id=>navigate('workbench',id),old.run.run_id);await waitStatus(old.run.run_id,'SUCCEEDED');assert.equal(await page.locator('.phase-bar').count(),0);await page.locator('.task-thread-properties [data-chat-inspect-run]').click();await page.locator('#task-chat-run-dialog[open]').waitFor();assert(await page.locator('.runtime-feed').isVisible());await page.locator('#task-chat-run-dialog .dialog-foot [data-close]').click();pass('历史任务继续保留原执行记录，展示也不再套固定阶段条');
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({checks,errors,layouts},null,2));
 }catch(error){await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({checks,errors,error:error.message},null,2));throw error;}finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1});
