'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{chromium}=require('playwright');
const {waitFor}=require('./browser_poll.cjs');
const base=process.env.PROPOSAL_CAPACITY_URL,output=process.env.PROPOSAL_CAPACITY_OUTPUT;if(!base||!output)throw Error('Use the browser suite runner.');fs.mkdirSync(output,{recursive:true});
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true}),context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),design=await context.newPage(),learning=await context.newPage(),work=await context.newPage(),checks=[],errors=[],posts=[];
 for(const page of [design,learning,work]){page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));}
 const call=(page,url,data)=>page.evaluate(({url,data})=>api(url,data),{url,data});
 const nav=async(page,view)=>{await page.evaluate(view=>navigate(view),view);await page.waitForFunction(view=>state.view===view&&state.connected&&!state.busy,view);};
 const pass=message=>{checks.push(message);console.log('PASS '+message);};
 const gates=()=>call(work,'/__test/proposal-gates');
 const shot=name=>work.screenshot({path:path.join(output,name+'.png'),animations:'disabled'});
 try{
  await work.goto(base);await work.waitForFunction(()=>state.connected&&!state.busy);
  const workspace=await call(work,'/api/workspaces',{name:'生成并发页面验收',business:'隔离测试',scenario:'多页面工作',description:'合成数据',revision:0});
  await work.goto(base+'?workspace_id='+workspace.id+'#/workflows');await work.waitForFunction(()=>state.connected&&!state.busy);
  const definition=(await call(work,'/api/agent-definition-default?domain=general-assistant%401.0.0')).definition;
  const agent=await call(work,'/api/agents',{name:'并发验收助手',description:'离线执行',runtime:'mock',model:'builtin',options:{},prompt:'整理材料并保留来源',skills:[],mcp_servers:[],definition,revision:0});
  const source=await call(work,'/api/knowledge/assets',{title:'会议资料',content:{text:'会议纪要应明确负责人和原始来源。'}});
  for(const op of ['review','publish'])await call(work,'/api/knowledge/assets/'+encodeURIComponent(source.ref)+'/'+op,{});
  for(const [page,view] of [[design,'workflows'],[learning,'library'],[work,'workbench']]){await page.goto(base+'?workspace_id='+workspace.id+'#/'+view);await page.waitForFunction(()=>state.connected&&!state.busy);}
  await design.locator('[data-flow-chat]').first().click();await design.locator('#flow-chat-message').fill('fixture-hold-design 新建「会议整理员」负责整理会议纪要');await design.locator('#flow-chat-send').click();
  await learning.locator('#hub-tab-ontology').click();await learning.locator('[data-new-ontology]').first().click();await learning.locator('#learning-agent').selectOption(agent.id);await learning.locator('[data-ontology-source][value="'+source.ref+'"]').check();await learning.locator('#learning-instruction').fill('fixture-hold-learning');await learning.locator('[data-learning-generate]').click();
  await waitFor(async()=> (await gates()).active===2,'Both independent generators did not enter their fixture gates');
  assert.equal(await design.evaluate(()=>flowChatEditor.busy),true);assert.equal(await learning.evaluate(()=>learningRequestEditor.busy),true);
  pass('工作流设计和本体生成在两个页面同时受理，等待独立的离线生成结果');

  await work.evaluate(id=>newTask({agentId:id}),agent.id);await work.locator('#create-dialog').waitFor();
  const draft=work.waitForResponse(r=>r.url().endsWith('/api/task-draft')&&r.request().method()==='POST');await work.locator('#task-goal').fill('在两个提案等待时完成独立任务');assert.equal((await draft).status(),200);
  const submission=work.waitForResponse(r=>r.url().endsWith('/api/tasks')&&r.request().method()==='POST');await work.locator('#create-form [type=submit]').click();const accepted=await submission;assert.equal(accepted.status(),202);const task=await accepted.json();
  await work.waitForFunction(()=>state.detail?.run?.status==='SUCCEEDED');assert.equal((await gates()).active,2);
  pass('两个生成都未完成时，第三个页面自动保存目标并创建任务，任务实际执行成功');

  await nav(work,'workflows');await work.locator('[data-flow-chat]').first().click();await work.locator('#flow-chat-message').fill('新建「报告助手」负责形成报告');
  work.on('request',r=>{if(r.method()==='POST'&&r.url().endsWith('/api/workflow-chat'))posts.push(r.postDataJSON());});
  const full=work.waitForResponse(r=>r.url().endsWith('/api/workflow-chat')&&r.request().method()==='POST');await work.locator('#flow-chat-send').click();assert.equal((await full).status(),503);
  await work.locator('#flow-chat-recovery').getByText(/本次尚未受理/).waitFor();assert.equal((await gates()).calls.length,2);
  const action=name=>work.locator('[data-flow-chat-action="'+name+'"]');await action('review').click();await action('retry').waitFor();
  assert.equal((await call(work,'/api/workflow-chat')).conversations.length,0);
  for(const theme of ['light','dark']){await work.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);await work.waitForTimeout(180);await shot('proposal-capacity-'+theme);assert(await action('retry').isEnabled());}
  pass('生成名额已满时立即提示尚未受理；没有创建第三份请求或调用模型，页面保留原需求与核对入口');

  await call(work,'/__test/proposal-gates',{release:'design'});await design.locator('[data-adopt-flow]').waitFor();await design.waitForFunction(()=>!flowChatEditor.busy);
  await work.locator('#flow-chat-message').fill('释放名额后的后续修改');await action('retry').click();await action('result').waitFor();assert.deepEqual(posts[0],posts[1]);await action('result').click();
  assert.equal(await work.locator('#flow-chat-message').inputValue(),'释放名额后的后续修改');assert.equal((await call(work,'/api/workflow-chat')).conversations.length,2);
  await call(work,'/__test/proposal-gates',{release:'learning'});await learning.waitForFunction(()=>!learningUI.busy&&learningUI.current?.status==='DRAFT');
  const observed=await gates();assert.equal(observed.active,0);assert.equal(observed.maximum,2);assert.equal(observed.calls.length,3);assert.equal((await call(work,'/api/workflows')).workflows.length,0);
  pass('名额释放后沿用原编号重试成功，后续输入保留；两个原生成也完成，未自动保存或运行工作流');
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({checks,errors,workspace:workspace.id,taskId:task.run.run_id,generators:observed,requestIds:posts.map(p=>p.request_id)},null,2));
 }catch(error){await shot('failure').catch(()=>{});fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({checks,errors,error:error.message,text:await work.locator('body').innerText()},null,2));throw error;}
 finally{for(const release of ['design','learning'])await call(work,'/__test/proposal-gates',{release}).catch(()=>{});await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
