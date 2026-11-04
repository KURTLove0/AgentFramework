'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{chromium}=require('playwright');
const base=process.env.TASK_SUBMISSION_URL;if(!base)throw Error('Set TASK_SUBMISSION_URL.');
const output=process.env.TASK_SUBMISSION_OUTPUT||'/private/tmp/task-submissions';fs.mkdirSync(output,{recursive:true});
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true}),context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),a=await context.newPage(),b=await context.newPage(),checks=[],errors=[],posts=[];
 for(const page of [a,b]){page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>dialog.accept());await page.goto(base);await page.waitForFunction(()=>state.connected&&!state.busy);}
 a.on('request',request=>{if(request.method()==='POST'&&request.url().endsWith('/api/tasks'))posts.push(request.postDataJSON());});
 const call=(page,url,data)=>page.evaluate(({url,data})=>api(url,data),{url,data});
 const count=async()=> (await call(b,'/api/runs')).counts.total;
 const pass=message=>{checks.push(message);console.log('PASS '+message);};
 const shot=async name=>{await a.evaluate(async()=>{await document.fonts.ready;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});await a.screenshot({path:path.join(output,name+'.png'),animations:'disabled'});};
 const fill=async goal=>{await a.locator('#task-goal').fill(goal);await a.evaluate(()=>clearTimeout(taskJourney.draftTimer));};
 const open=async identity=>{await a.evaluate(identity=>newTask({agentId:identity}),identity);await a.locator('#create-dialog').waitFor();};
 const submit=async()=>{const response=a.waitForResponse(r=>r.url().endsWith('/api/tasks')&&r.request().method()==='POST');response.catch(()=>{});await a.locator('#create-form button[type=submit]').click();return response;};
 const change=async(identity,prompt)=>{const profile=await call(b,'/api/agents/'+identity),data={};for(const key of ['name','description','runtime','model','options','prompt','skills','mcp_servers','definition','revision','skill_bindings','evaluation_config'])if(profile[key]!==undefined)data[key]=profile[key];return call(b,'/api/agents/'+identity,{...data,prompt});};
 const unavailable=async()=>a.route('**/api/tasks',route=>route.request().method()==='POST'?route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'合成连接故障'})}):route.continue());
 const lose=async()=>{
  let accepted;await a.route('**/api/tasks',async route=>{if(route.request().method()==='POST'){const response=await route.fetch();assert.equal(response.status(),202,await response.text());accepted={receipt:await response.json(),payload:route.request().postDataJSON()};await route.abort('connectionreset');}else await route.continue();});
  await a.locator('#create-form button[type=submit]').click();await a.locator('#task-submission-status').getByText('提交结果需要核对',{exact:true}).waitFor();await a.unroute('**/api/tasks');assert(accepted);return accepted;
 };
 try{
  const template=await call(b,'/api/agent-definition-default?domain=general-assistant@1.0.0');
  const agent=await call(b,'/api/agents',{name:'提交恢复验收助手',description:'合成任务验收',runtime:'mock',model:'builtin',options:{},prompt:'按用户目标交付结果。',skills:[],mcp_servers:[],revision:0,definition:template.definition});
  const baseline=await count();await open(agent.id);await fill('回执丢失之前的原目标');const first=await lose();
  await fill('回执未知之后继续编辑的目标');assert(await a.locator('#create-form button[type=submit]').isDisabled());assert.equal(await count(),baseline+1);
  let releaseReview,reviewEntered;const entered=new Promise(resolve=>reviewEntered=resolve);
  await a.route('**/api/task-submissions/*',async route=>{reviewEntered();await new Promise(resolve=>releaseReview=resolve);await route.continue();});
  await a.getByRole('button',{name:'核对提交结果',exact:true}).click();await entered;
  await a.keyboard.press('Escape');await a.getByRole('button',{name:'创建或配置智能体',exact:true}).click();assert(await a.locator('#create-dialog').isVisible());assert(!(await a.locator('#agent-dialog').isVisible()));
  releaseReview();await a.locator('#task-submission-status').getByText('原任务已受理',{exact:true}).waitFor();await a.unroute('**/api/task-submissions/*');assert.equal(await a.locator('#task-goal').inputValue(),'回执未知之后继续编辑的目标');
  await a.evaluate(()=>document.documentElement.dataset.theme='light');await shot('accepted-light');await a.getByRole('button',{name:'查看已受理任务',exact:true}).click();await a.locator('#create-dialog').waitFor({state:'hidden'});await a.waitForFunction(identity=>state.selected===identity,first.receipt.run.run_id);assert.equal(await count(),baseline+1);pass('回执丢失后继续编辑不另建任务，核对并打开同一已受理记录');

  await open(agent.id);await fill('配置冲突后保留的目标');await unavailable();await submit();await a.locator('#task-submission-status').getByText('提交结果需要核对',{exact:true}).waitFor();await a.unroute('**/api/tasks');const secondToken=posts.at(-1).request_id;
  await change(agent.id,'其他页面更新后的指令');await a.getByRole('button',{name:'核对提交结果',exact:true}).click();await a.locator('#task-submission-status summary').getByText(/当前智能体配置 · v2/).waitFor();assert.equal(await a.locator('#task-goal').inputValue(),'配置冲突后保留的目标');
  await a.getByRole('button',{name:'使用所示配置，保留目标',exact:true}).click();await change(agent.id,'核对之后再次更新的指令');let response=await submit();assert.equal(response.status(),409);assert.equal(posts.at(-1).request_id,secondToken);
  await a.getByRole('button',{name:'核对提交结果',exact:true}).click();await a.locator('#task-submission-status summary').getByText(/当前智能体配置 · v3/).waitFor();await a.getByRole('button',{name:'使用所示配置，保留目标',exact:true}).click();response=await submit();assert.equal(response.status(),202);assert.equal(posts.at(-1).request_id,secondToken);await a.locator('#create-dialog').waitFor({state:'hidden'});assert.equal(await count(),baseline+2);pass('未受理时显式采用当前配置并保留目标，核对后再变化仍拒绝旧版本，重试编号不变');

  await open(agent.id);await fill('刷新后核对的原目标');const third=await lose();await a.reload();await a.waitForFunction(()=>state.connected&&!state.busy);await open(agent.id);assert.equal(await a.locator('#task-goal').inputValue(),'刷新后核对的原目标');assert(await a.locator('#create-form button[type=submit]').isDisabled());
  const beforeReview=posts.length;await a.getByRole('button',{name:'核对提交结果',exact:true}).click();await a.locator('#task-submission-status').getByText('原任务已受理',{exact:true}).waitFor();assert.equal(posts.length,beforeReview);
  await a.setViewportSize({width:1024,height:1000});await a.evaluate(()=>document.documentElement.dataset.theme='dark');assert(!(await a.evaluate(()=>document.documentElement.scrollWidth>innerWidth)));await shot('restored-dark');
  await a.evaluate(()=>{window.taskRecoveryFonts=[...document.querySelectorAll('#create-dialog *')].map(el=>[el,el.style.fontSize,parseFloat(getComputedStyle(el).fontSize)]);for(const [el,,size]of window.taskRecoveryFonts)el.style.fontSize=(size*2)+'px';});
  for(const width of [1024,1440]){await a.setViewportSize({width,height:1000});const button=a.getByRole('button',{name:'查看已受理任务',exact:true});await button.scrollIntoViewIfNeeded();assert(!(await a.evaluate(()=>document.documentElement.scrollWidth>innerWidth||$('#create-dialog').scrollWidth>$('#create-dialog').clientWidth+1)));assert(await button.evaluate(el=>{const r=el.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('button')===el;}));}
  await a.evaluate(()=>{for(const [el,value]of window.taskRecoveryFonts)el.style.fontSize=value;delete window.taskRecoveryFonts;});await a.setViewportSize({width:1024,height:1000});
  await a.getByRole('button',{name:'保留本页目标，另建任务',exact:true}).click();assert.equal(posts.length,beforeReview);response=await submit();assert.equal(response.status(),202);assert.notEqual(posts.at(-1).request_id,third.payload.request_id);await a.locator('#create-dialog').waitFor({state:'hidden'});assert.equal(await count(),baseline+4);pass('刷新后恢复待核对编号，读取不会提交，明确另建后才使用新编号创建任务');

  await open(agent.id);await fill('最初仍可能在途的目标');await unavailable();await submit();await a.locator('#task-submission-status').getByText('提交结果需要核对',{exact:true}).waitFor();await a.unroute('**/api/tasks');const original=posts.at(-1);
  await fill('希望继续提交的本页新目标');await a.getByRole('button',{name:'核对提交结果',exact:true}).click();await a.getByRole('button',{name:'使用所示配置，保留目标',exact:true}).waitFor();await a.getByRole('button',{name:'使用所示配置，保留目标',exact:true}).click();
  const late=await call(b,'/api/tasks',original);const beforeConflict=await count();response=await submit();assert.equal(response.status(),409);assert.equal(posts.at(-1).request_id,original.request_id);assert.equal(await count(),beforeConflict);
  await a.getByRole('button',{name:'核对提交结果',exact:true}).click();await a.locator('#task-submission-status').getByText('原任务已受理',{exact:true}).waitFor();assert.equal(await a.locator('#task-goal').inputValue(),'希望继续提交的本页新目标');assert.equal(await a.evaluate(()=>taskJourney.submissionIssue.receipt.run.run_id),late.run.run_id);pass('暂未找到之后原请求晚到受理，继续提交仍共用原编号，冲突后可查回原任务且不重复创建');
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({checks,errors,posts:posts.map(p=>({request_id:p.request_id,agent_revision:p.agent_revision})),total:await count()},null,2));
 }catch(error){await shot('failure').catch(()=>{});fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({checks,errors,error:error.message,state:await a.evaluate(()=>({saving:taskJourney.saving,draftSaving:taskJourney.draftSaving,issue:taskJourney.submissionIssue,goal:$('#task-goal').value,agent:$('#task-agent').value,valid:$('#create-form').checkValidity(),fields:[...$('#create-form').elements].filter(f=>f.validity&&!f.validity.valid).map(f=>({name:f.name,value:f.value,message:f.validationMessage}))})),text:await a.locator('body').innerText()},null,2));throw error;}finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
