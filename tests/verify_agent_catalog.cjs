'use strict';
// Public APIs and actual UI paths, with synthetic skills in a temporary service.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright'),{waitFor}=require('./browser_poll.cjs'),H=require('./ui95_helpers.cjs');
const base=process.env.AGENT_CATALOG_URL;if(!base)throw Error('Set AGENT_CATALOG_URL to an isolated fixture.');
const output=process.env.AGENT_CATALOG_OUTPUT||'/private/tmp/agent-catalog';fs.mkdirSync(output,{recursive:true});
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});
 const checks=[],errors=[],catalogReads=[];page.setDefaultTimeout(15000);page.on('pageerror',error=>errors.push(error.message));
 page.on('response',response=>{const url=new URL(response.url());if(url.pathname==='/api/agents'&&url.searchParams.get('view')==='catalog')catalogReads.push(url.href);});
 const call=(url,data)=>page.evaluate(({url,data})=>api(url,data),{url,data});
 const pass=message=>{checks.push(message);console.log('PASS '+message);};
 const shot=async name=>{await page.evaluate(async()=>{window.scrollTo({top:0,behavior:'instant'});await document.fonts.ready;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});await page.screenshot({path:path.join(output,name+'.png'),fullPage:true,animations:'disabled'});};
 try{
  await page.goto(base);await page.waitForFunction(()=>state.connected&&!state.busy);
  const source='RESOURCE_V1_ONLY_'+('x'.repeat(49152));
  const first=await call('/api/skills',{folder:'catalog-evidence',revision:0,files:{
   'SKILL.md':{encoding:'utf-8',content:'---\nname: catalog-evidence\ndescription: 核对绑定版本的来源\n---\n\n# 绑定方法第一版\n\n先核对 [来源](references/source.md)，再给出结论。'},
   'references/source.md':{encoding:'utf-8',content:source}}});
  const published=await call('/api/skills/'+first.id+'/publish',{revision:first.revision,version:1});
  const definition=(await call('/api/agent-definition-default?domain=general-assistant%401.0.0')).definition;
  const agent=await call('/api/agents',{name:'目录性能验收助手',description:'保留固定工作方法与完整任务配置',runtime:'mock',model:'builtin',options:{},prompt:'根据输入完成目标，保留来源与信息缺口。',skills:[],mcp_servers:[],definition,revision:0,
   skill_bindings:[{skill_id:first.id,version:1,enabled:true}]});
  const second=await call('/api/skills/'+first.id,{folder:first.name,revision:published.revision,files:{
   'SKILL.md':{encoding:'utf-8',content:'---\nname: catalog-evidence\ndescription: 第二版工作方法\n---\n\n第二版方法，不能覆盖已固定的第一版。'},
   'references/source.md':{encoding:'utf-8',content:'RESOURCE_V2_ONLY'}}});
  await call('/api/skills/'+first.id+'/publish',{revision:second.revision,version:2});
  await H.nav(page,'agents');
  const catalog=await page.evaluate(id=>state.agents.find(a=>a.id===id),agent.id);
  assert(catalog.catalog_only);assert(!catalog.skill_packages);assert.equal(catalog.skill_summaries[0].version,1);
  assert(!catalog.skill_summaries[0].package.files);assert(catalog.skill_summaries[0].package.body.includes('第一版'));
  assert(!JSON.stringify(catalog).includes('RESOURCE_V1_ONLY'));assert(catalogReads.length>0);
  const full=(await call('/api/agents')).agents.find(a=>a.id===agent.id);assert.equal(full.skill_packages[0].package.files['references/source.md'].content,source);
  assert(JSON.stringify(catalog).length<JSON.stringify(full).length/10);
  pass('实际目录请求使用轻量视图，未传输技能资源正文；原完整列表仍返回全部冻结资源');

  await page.locator('#agent-search').fill('catalog-evidence');await page.locator('#agent-open-'+agent.id).click();await page.waitForFunction(id=>!state.busy&&state.selected===id,agent.id);
  await page.locator('#agent-detail-tab-skills').click();await page.waitForFunction(()=>!state.busy);
  await page.locator('.agent-skill-description summary').click();
  assert((await page.locator('.agent-detail-skills').innerText()).includes('绑定方法第一版'));
  assert(!(await page.locator('.agent-detail-skills').innerText()).includes('第二版方法'));await shot('pinned-method-catalog');
  pass('按绑定技能名称可搜索智能体，轻量详情继续显示第一版方法，不漂移到技能库第二版');

  const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/agents/'+agent.id&&r.request().method()==='GET');
  await page.locator('[data-agent-edit-section=skills]').click();const editing=await(await response).json();
  await page.locator('#agent-dialog[open]').waitFor();await page.waitForFunction(()=>!state.agentOpening&&!state.agentModelLoading);
  assert.equal(editing.skill_packages[0].package.files['references/source.md'].content,source);
  const save=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/agents/'+agent.id&&r.request().method()==='POST');
  await page.locator('#agent-save').click();const saved=await(await save).json();assert.equal(saved.revision,2);await page.locator('#agent-dialog').waitFor({state:'hidden'});
  assert.equal(saved.skill_packages[0].package.hash,full.skill_packages[0].package.hash);assert.equal(saved.skill_packages[0].package.files['references/source.md'].content,source);
  assert(!saved.catalog_only&&!saved.skill_summaries);
  pass('打开编辑器按需读取完整配置，保存仍保留原技能资源与摘要，目录标记没有进入配置');

  await H.nav(page,'agents',agent.id);await page.getByRole('button',{name:'开始任务',exact:true}).click();await page.locator('#create-dialog[open]').waitFor();
  await page.locator('#task-goal').fill('按已绑定的方法核对本次材料');
  const submitted=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/tasks'&&r.request().method()==='POST');
  await page.locator('#create-form [type=submit]').click();const task=await(await submitted).json();await page.locator('#create-dialog').waitFor({state:'hidden'});
  const frozen=task.run.snapshot.agent_profile;assert.equal(frozen.id,agent.id);assert.equal(frozen.revision,2);
  assert.equal(frozen.skill_packages[0].package.files['references/source.md'].content,source);
  assert.equal(frozen.skill_packages[0].version,1);assert(!frozen.catalog_only);
  await waitFor(async()=>(await call('/api/tasks/'+task.run.run_id)).run.status==='SUCCEEDED','Catalog-selected task did not finish');
  pass('从轻量目录选择智能体后，任务在服务端冻结完整第一版资源并执行完成');

  const workflow=await H.workflow(page,agent.id,'按绑定的来源核对方法整理材料');await H.nav(page,'workflows');
  const directory=await page.evaluate(id=>state.agents.find(a=>a.id===id),agent.id);assert(directory.catalog_only);
  await page.locator('[data-start-flow="'+workflow.id+'"]').click();
  const started=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/workflows/'+workflow.id+'/start'&&r.request().method()==='POST');
  await page.locator('#flow-start-form [type=submit]').click();const execution=await(await started).json();
  const profile=execution.run.snapshot.profiles[workflow.nodes[0].id];assert.equal(profile.skill_packages[0].package.files['references/source.md'].content,source);
  await waitFor(async()=>{const d=await call('/api/workflow-runs/'+execution.run.id);return d.run.status==='SUCCEEDED'&&!d.job?.active;},'Catalog-selected workflow did not finish');
  pass('工作流候选使用轻量目录，启动时仍冻结完整智能体和技能资源，节点执行完成');
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({checks,errors,catalogReadCount:catalogReads.length,fullBytes:Buffer.byteLength(JSON.stringify(full)),catalogBytes:Buffer.byteLength(JSON.stringify(catalog))},null,2));
 }catch(error){await shot('failure').catch(()=>{});fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({checks,errors,error:error.message,text:await page.locator('body').innerText()},null,2));throw error;}
 finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
