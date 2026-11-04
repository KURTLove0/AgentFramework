'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{chromium}=require('playwright');
const base=process.env.TASK_DRAFT_URL;if(!base)throw Error('Set TASK_DRAFT_URL.');
const output=process.env.TASK_DRAFT_OUTPUT||'/private/tmp/task-drafts';fs.mkdirSync(output,{recursive:true});
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true}),context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),a=await context.newPage(),b=await context.newPage(),checks=[],errors=[];
 for(const page of [a,b]){page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));await page.goto(base);await page.waitForFunction(()=>state.connected&&!state.busy);}
 const call=(page,url,data)=>page.evaluate(({url,data})=>api(url,data),{url,data});
 const save=(page,goal,revision,agent)=>call(page,'/api/task-draft',{revision,draft:{goal,agent_id:agent,domain_pack_ref:'general-assistant@1.0.0'}});
 const pass=message=>{checks.push(message);console.log('PASS '+message);};
 const shot=async name=>{await a.evaluate(async()=>{await document.fonts.ready;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});await a.screenshot({path:path.join(output,name+'.png'),animations:'disabled'});};
 try{
  const agent=await call(a,'/api/agents',{name:'草稿验收助手',description:'隔离验证草稿操作','runtime':'mock',model:'builtin',options:{},prompt:'按用户目标交付。',skills:[],mcp_servers:[],revision:0});assert(agent.id);
  let current=await call(a,'/api/task-draft');current=await save(a,'页面 A 最初保存的设置',current.revision,agent.id);
  await a.evaluate(()=>newTask({restoreDraft:true}));await a.locator('#create-dialog').waitFor();
  const newer=await save(b,'页面 B 更新的工作目标',current.revision,agent.id);
  await a.locator('#task-goal').fill('页面 A 仍在编辑的工作目标');await a.locator('#task-draft-status').getByText('设置草稿已在其他页面变化',{exact:true}).waitFor();
  assert.equal(await a.locator('#task-goal').inputValue(),'页面 A 仍在编辑的工作目标');assert.equal((await call(b,'/api/task-draft')).revision,newer.revision);
  await a.getByRole('button',{name:'查看已保存版本',exact:true}).click();await a.locator('#task-draft-status').getByText('页面 B 更新的工作目标',{exact:true}).waitFor();
  for(const theme of ['light','dark']){await a.setViewportSize({width:1024,height:1000});await a.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);assert(!(await a.evaluate(()=>document.documentElement.scrollWidth>innerWidth)));await shot('draft-conflict-'+theme);}
  const latest=await save(b,'页面 B 再次保存的新版本',newer.revision,agent.id);
  await a.getByRole('button',{name:'保留本页设置并保存',exact:true}).click();await a.locator('#task-draft-status').getByText('设置草稿已在其他页面变化',{exact:true}).waitFor();assert.equal((await call(b,'/api/task-draft')).revision,latest.revision);
  await a.getByRole('button',{name:'查看已保存版本',exact:true}).click();await a.locator('#task-draft-status').getByText('页面 B 再次保存的新版本',{exact:true}).waitFor();
  await a.getByRole('button',{name:'使用已保存设置',exact:true}).click();assert.equal(await a.locator('#task-goal').inputValue(),'页面 B 再次保存的新版本');pass('两页面保存冲突保留本页输入，核对后仍防止覆盖再次更新的草稿，显式选择才能替换设置');

  await a.locator('#create-dialog [data-close]').first().click();await a.locator('#create-dialog').waitFor({state:'hidden'});await a.evaluate(()=>discardSavedTaskDraft());await a.locator('#confirm-dialog').waitFor();
  const changed=await save(b,'确认框打开之后的新草稿',latest.revision,agent.id);
  await a.locator('#confirm-submit').click();await a.locator('#confirm-error').getByText(/其他页面更新/).waitFor();assert.equal((await call(b,'/api/task-draft')).revision,changed.revision);assert(await a.locator('#confirm-dialog').isVisible());
  await a.getByRole('button',{name:'重新检查草稿',exact:true}).click();await a.locator('#confirm-body').getByText('确认框打开之后的新草稿',{exact:true}).waitFor();assert((await call(b,'/api/task-draft')).draft);
  await a.locator('#confirm-submit').click();await a.locator('#confirm-dialog').waitFor({state:'hidden'});current=await call(b,'/api/task-draft');assert.equal(current.draft,null);assert(current.revision>changed.revision);pass('过期确认不能放弃新草稿，重新检查只读取内容，再次明确确认才会清理');

  current=await save(b,'提交任务时页面 A 所用草稿',current.revision,agent.id);await a.evaluate(()=>newTask({restoreDraft:true}));await a.locator('#create-dialog').waitFor();
  const preserved=await save(b,'其他页面需要保留的下一份草稿',current.revision,agent.id);
  await a.locator('#task-goal').fill('按页面 A 当前目标创建任务');await a.evaluate(()=>clearTimeout(taskJourney.draftTimer));
  const posted=a.waitForResponse(response=>response.url().endsWith('/api/tasks')&&response.request().method()==='POST');await a.locator('#create-form button[type=submit]').click();const response=await posted;assert.equal(response.status(),202,await response.text());const receipt=await response.json();
  await a.locator('#create-dialog').waitFor({state:'hidden'});assert.equal(receipt.run.task.goal,'按页面 A 当前目标创建任务');assert.equal(receipt.task_draft.revision,preserved.revision);assert.equal((await call(b,'/api/task-draft')).draft.goal,preserved.draft.goal);assert.equal(await a.evaluate(()=>state.savedTaskDraft.draft.goal),preserved.draft.goal);pass('提交过期草稿仍创建本页任务，同时保留其他页面的新草稿与界面回执');

  await a.evaluate(()=>newTask({restoreDraft:true}));await a.locator('#create-dialog').waitFor();await a.locator('#task-goal').fill('确认失败时本页输入仍保留');await a.evaluate(()=>clearTimeout(taskJourney.draftTimer));
  await a.locator('#create-dialog [data-close]').first().click();await a.locator('#confirm-dialog').waitFor();let dropped=false,releaseDiscard,committed;const commitObserved=new Promise(resolve=>committed=resolve);
  await a.route('**/api/task-draft/discard',async route=>{if(!dropped){dropped=true;await route.fetch();committed();await new Promise(resolve=>releaseDiscard=resolve);await route.abort('connectionreset');}else await route.continue();});
  await a.locator('#confirm-submit').click();await commitObserved;await a.keyboard.press('Escape');assert(await a.locator('#confirm-dialog').isVisible());await a.locator('#confirm-dialog [data-close]').first().click();assert(await a.locator('#confirm-dialog').isVisible());releaseDiscard();
  await a.locator('#confirm-error').waitFor({state:'visible'});assert(await a.locator('#create-dialog').isVisible());assert.equal(await a.locator('#task-goal').inputValue(),'确认失败时本页输入仍保留');
  const afterCommit=await call(b,'/api/task-draft');assert.equal(afterCommit.draft,null);const fresh=await save(b,'响应丢失后另一页面创建的草稿',afterCommit.revision,agent.id);
  await a.locator('#confirm-submit').click();await a.getByRole('button',{name:'重新检查草稿',exact:true}).waitFor();assert.equal((await call(b,'/api/task-draft')).revision,fresh.revision);await shot('discard-response-lost');pass('放弃已提交但回执丢失时保留输入，再次请求也不能清理后来创建的新草稿');
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({checks,errors,task:receipt.run.run_id},null,2));
 }catch(error){await shot('failure').catch(()=>{});fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({checks,errors,error:error.message,text:await a.locator('body').innerText()},null,2));throw error;}finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
