'use strict';
// Runs exclusively against the runner's disposable service and synthetic models.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright');
const base=process.env.PROJECT_REVIEW_URL;if(!base)throw Error('Set PROJECT_REVIEW_URL to the isolated fixture.');
const output=process.env.PROJECT_REVIEW_OUTPUT||'/private/tmp/workflow-agents';fs.mkdirSync(output,{recursive:true});
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000}});
 const checks=[],errors=[],requests=[];page.setDefaultTimeout(12000);page.on('pageerror',e=>errors.push(e.message));
 const pass=text=>{checks.push(text);console.log('PASS '+text);};
 const call=(url,data)=>page.evaluate(({url,data})=>api(url,data),{url,data});
 const nav=async()=>{await page.evaluate(()=>navigate('workflows'));await page.waitForFunction(()=>state.view==='workflows'&&!state.busy&&state.connected);};
 const post=url=>page.waitForResponse(r=>r.url().endsWith(url)&&r.request().method()==='POST');
 const shot=name=>page.screenshot({path:path.join(output,name+'.png'),animations:'disabled'});
 const configure=async()=>{
  await page.locator('[data-flow-new]').first().click();await page.locator('#flow-name').fill('直接创建流程智能体');
  await page.locator('[data-flow-create-agent]').click();await page.locator('[data-flow-agent-field=name]').fill('会议整理员');
  await page.locator('[data-flow-agent-field=description]').fill('从会议材料提取决议和待办');
  await page.locator('[data-flow-agent-field=prompt]').fill('整理输入材料，列出决议、负责人和待办。信息不足时明确说明。');
  await page.locator('[data-design-field=goal]').fill('整理本次会议的决议和待办');
 };
 const start=async(id,live=false)=>{
  await page.locator('[data-start-flow="'+id+'"]').click();await page.waitForFunction(()=>flowStartEditor?.ready&&!flowStartEditor.opening&&!flowStartEditor.busy);
  if(live){if(await page.locator('#flow-consent').isVisible())await page.locator('#flow-consent').check();else assert(await page.locator('#flow-consent').isChecked());}
  const response=post('/api/workflows/'+id+'/start');await page.locator('#flow-start-form [type=submit]').click();const value=await (await response).json();
  for(let i=0;i<120;i++){const detail=await call('/api/workflow-runs/'+value.run.id);if(detail.run.status==='SUCCEEDED'&&!detail.job?.active)return detail;await new Promise(r=>setTimeout(r,100));}
  throw Error('Created specialists did not complete their workflow');
 };
 try{
  await page.goto(base);await page.waitForFunction(()=>state.connected);
  const space=await call('/api/workspaces',{name:'工作流智能体验收',business:'隔离测试',scenario:'流程智能体',description:'临时服务',revision:0});
  await page.goto(base+'?workspace_id='+space.id+'#/workflows');await page.waitForFunction(()=>state.connected&&state.view==='workflows'&&!state.busy);
  assert.equal((await call('/api/agents')).agents.length,0);await configure();
  await page.locator('#flow-editor-dialog .dialog-foot [data-close]').click();await page.locator('#confirm-submit').click();
  assert.equal((await call('/api/agents')).agents.length,0);assert.equal((await call('/api/workflows')).workflows.length,0);
  pass('空空间可直接配置执行智能体；放弃编辑不产生智能体或工作流记录');
  await configure();await shot('manual-specialist-draft');
  let lost=true;
  await page.route('**/api/workflows',async route=>{if(route.request().method()!=='POST')return route.continue();requests.push(route.request().postDataJSON());if(lost){lost=false;await route.fetch();await route.abort('failed');}else await route.continue();});
  await page.locator('#flow-editor-form [type=submit]').click();await page.locator('#flow-editor-error').waitFor({state:'visible'});
  assert.equal((await call('/api/agents')).agents.length,1);assert.equal((await call('/api/workflows')).workflows.length,1);
  await page.locator('#flow-editor-form [type=submit]').click();await page.locator('#flow-editor-dialog').waitFor({state:'hidden'});
  assert.equal(requests.length,2);assert.deepEqual(requests[0],requests[1]);
  const directory=await call('/api/workflows'),manual=directory.workflows[0];
  assert.equal(directory.workflows.length,1);assert.equal((await call('/api/agents')).agents.length,1);
  const profile=(await call('/api/agents')).agents[0];assert.equal(profile.id,manual.nodes[0].agent_id);assert.equal(profile.revision,1);assert.equal(profile.name,'会议整理员');
  pass('丢失保存响应后保留草案，重试恢复同一流程与智能体，未重复创建');
  const manualRun=await start(manual.id);assert.equal(manualRun.run.nodes[manual.nodes[0].id].status,'SUCCEEDED');
  pass('画布创建的智能体已作为真实节点执行完成');
  const definition=(await call('/api/agent-definition-default?domain=general-assistant%401.0.0')).definition;
  const designer=await call('/api/agents',{name:'流程设计师',description:'设计专用执行者',runtime:'codex',model:'review-model',options:{timeout:15,max_attempts:1,reasoning_effort:'low'},prompt:'根据流程目标选择或设计执行智能体。',skills:[],mcp_servers:[],definition,revision:0});
  await nav();await page.locator('[data-flow-chat]').first().click();await page.locator('#flow-chat-agent').selectOption(designer.id);
  await page.locator('#flow-chat-message').fill('请自主创建分析和报告智能体，先分析输入再形成报告。');await page.locator('#flow-chat-consent').check();
  let response=post('/api/workflow-chat');await page.locator('#flow-chat-send').click();assert((await response).ok());await page.locator('[data-adopt-flow]').waitFor();
  const proposal=await page.evaluate(()=>state.flowChat.proposal);assert.equal(proposal.agent_drafts.length,2);assert.equal((await call('/api/agents')).agents.length,2);
  assert(proposal.agent_drafts.every(d=>d.source_agent_id===designer.id&&d.source_agent_revision===1));
  await shot('autonomous-agent-proposal');pass('模型可自主设计两个专用智能体，提案可审查且未提前写入目录');
  await page.locator('[data-adopt-flow]').click();await page.locator('[data-flow-agent-field=name]').fill('研究分析员');
  await page.locator('[data-flow-agent-field=prompt]').fill('明确区分事实、推断和信息缺口，向下游交付可核验的分析。');
  for(const theme of ['light','dark'])for(const width of [1024,1440,1920]){
   await page.setViewportSize({width,height:1000});await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
   const layout=await page.locator('#flow-inspector').evaluate(el=>({scroll:el.scrollWidth,width:el.clientWidth}));assert(layout.scroll<=layout.width+1);
   assert.equal(await page.locator('[data-flow-agent-field=name]').evaluate(e=>getComputedStyle(e).fontSize),'14px');
   if(width===1440)await shot('agent-editor-'+theme);
  }
  await page.setViewportSize({width:1440,height:1000});
  response=post('/api/workflows');await page.locator('#flow-editor-form [type=submit]').click();const saved=await (await response).json();await page.locator('#flow-editor-dialog').waitFor({state:'hidden'});
  assert.equal(saved.nodes.length,2);const agents=(await call('/api/agents')).agents;assert.equal(agents.length,4);
  for(const node of saved.nodes){const agent=agents.find(a=>a.id===node.agent_id);assert(agent);assert.equal(agent.runtime,'codex');assert.equal(agent.model,'review-model');assert.deepEqual(agent.mcp_servers,[]);assert.deepEqual(agent.skills,[]);}
  assert.equal(agents.find(a=>a.id===saved.nodes[0].agent_id).name,'研究分析员');
  const execution=await start(saved.id,true);assert(Object.values(execution.run.nodes).every(n=>n.status==='SUCCEEDED'));
  const downstream=execution.children[saved.nodes[1].id];assert(downstream);
  const task=await call('/api/tasks/'+downstream.run_id);
  assert.equal(task.run.task.workflow_inputs[0].node_id,saved.nodes[0].id);
  assert.equal(task.run.snapshot.agent_profile.id,saved.nodes[1].agent_id);
  await shot('specialist-workflow-completed');
  pass('审查修改后一次保存创建并绑定，两个新智能体按依赖传递上游结果完成执行');
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({checks,errors,workflowId:saved.id,runId:execution.run.id,manualId:manual.id},null,2));
 }catch(error){await shot('failure').catch(()=>{});fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({checks,errors,error:error.message,text:await page.locator('body').innerText()},null,2));throw error;}finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
