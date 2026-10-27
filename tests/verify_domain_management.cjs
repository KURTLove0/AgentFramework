'use strict';
// Run only against a disposable local data directory, with DOMAIN_TEST_BASE_URL set.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright');
const base=process.env.DOMAIN_TEST_BASE_URL;
if(!base)throw Error('请通过 DOMAIN_TEST_BASE_URL 指定隔离测试服务，避免写入日常工作空间。');
const output=process.env.DOMAIN_TEST_OUTPUT||'/private/tmp/agent-framework-domain-management/results';
fs.mkdirSync(output,{recursive:true});
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[],checks=[];
 page.on('pageerror',e=>errors.push(e.message));
 const pass=message=>{checks.push(message);console.log('PASS '+message);};
 const call=(url,data)=>page.evaluate(({url,data})=>api(url,data),{url,data});
 const domains=()=>call('/api/agent-domains?include_archived=1');
 const waitDomain=id=>page.waitForFunction(id=>!state.agentRoleLoading&&state.agentSelectedDomain===id,id);
 const next=()=>page.locator('[data-agent-config-direction="1"]').click();
 const saveAgent=async id=>{
  await next();await next();const response=page.waitForResponse(r=>r.url().endsWith('/api/agents'+(id?'/'+id:''))&&r.request().method()==='POST');
  await page.locator('#agent-save').click();const saved=await(await response).json();await page.locator('#agent-dialog').waitFor({state:'hidden'});return saved;
 };
 const visit=async()=>{await page.goto(base+'/#/domains');await page.locator('.domains-page').waitFor();};
 try{
  await visit();assert.equal(await page.locator('[data-nav="domains"]').getAttribute('aria-current'),'page');
  assert.equal(await page.locator('.domain-builtin-grid article').count(),0);await page.screenshot({path:path.join(output,'domains-empty.png'),animations:'disabled'});pass('独立导航与领域空状态可用，执行模板不再充当业务领域');
  await page.locator('[data-domain-new]').first().click();await page.locator('#domain-save').click();assert.equal(await page.locator('#domain-name').getAttribute('aria-invalid'),'true');
  await page.locator('#domain-name').fill('客户支持');await page.locator('#domain-description').fill('回答客户产品、使用流程与售后问题。');assert.equal(await page.locator('#domain-method').evaluate(e=>e.tagName),'TEXTAREA');await page.locator('#domain-method').fill('先访谈用户，再梳理诉求\n按紧急程度输出处理建议。');
  await page.keyboard.press('Escape');await page.locator('#confirm-dialog[open]').waitFor();await page.locator('#confirm-dialog [data-close]').first().click();assert.equal(await page.locator('#domain-name').inputValue(),'客户支持');pass('领域表单校验和放弃更改确认保留输入');
  let posts=0;await page.route('**/api/agent-domains',async route=>{if(route.request().method()==='POST'){posts++;await new Promise(r=>setTimeout(r,200));await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'临时保存失败'})});}else await route.continue();});
  await page.locator('#domain-save').dblclick();await page.waitForFunction(()=>!state.domainEditorSaving);assert.equal(posts,1);assert.equal(await page.locator('#domain-name').inputValue(),'客户支持');assert(await page.locator('#domain-error').isVisible());await page.unroute('**/api/agent-domains');pass('重复保存只提交一次，失败保留表单可重试');
  await page.locator('#domain-save').click();await page.locator('#domain-dialog').waitFor({state:'hidden'});const first=(await domains()).domains.find(d=>d.name==='客户支持');assert(first);assert.equal(first.work_method,'先访谈用户，再梳理诉求\n按紧急程度输出处理建议。');assert(!('domain_pack_ref' in first));await page.locator('#domain-row-'+first.id).waitFor();
  await page.locator('#domain-search').fill('不存在的关键词');assert.equal(await page.locator('.domain-table tbody tr').count(),0);await page.locator('[data-domain-clear]').click();await page.locator('#domain-row-'+first.id).waitFor();pass('创建、搜索、清除筛选后显示持久记录');
  await page.locator('#domain-row-'+first.id+' [data-domain-use]').click();await page.locator('#agent-dialog[open]').waitFor();await waitDomain(first.id);assert.equal(await page.locator('#agent-name').inputValue(),'');
  await page.locator('#agent-name').fill('客户服务助手');await next();assert.equal(await page.locator('#agent-execution-template').count(),0);assert.equal(await page.evaluate(()=>state.roleDefinition.domain_pack_ref),'general-assistant@1.0.0');assert.equal(await page.locator('#agent-domain').inputValue(),first.id);pass('自由填写多行工作方式，通用执行配置保留原业务领域');const prompt='请核对来源后回答，材料不足时说明缺失内容。';await page.locator('#agent-prompt').fill(prompt);await page.locator('#agent-config-tab-identity').click();
  await page.locator('[data-manage-domains]').click();await page.locator('.domains-page').waitFor();await page.locator('[data-domain-return]').waitFor();assert(await page.locator('#agent-dialog').isHidden());
  await page.locator('[data-domain-new]').first().click();await page.locator('#domain-name').fill('产品研究');await page.locator('#domain-description').fill('整理研究资料，核对观点与引用依据。');await page.locator('#domain-method').fill('逐项比较候选方案，以证据支撑推荐。');await page.locator('#domain-save').click();await page.locator('#domain-dialog').waitFor({state:'hidden'});
  const second=(await domains()).domains.find(d=>d.name==='产品研究');await page.locator('#domain-feedback [data-domain-use]').click();await page.locator('#agent-dialog[open]').waitFor();await waitDomain(second.id);
  assert.equal(await page.locator('#agent-name').inputValue(),'客户服务助手');assert.equal(await page.locator('#agent-prompt').inputValue(),prompt);pass('从智能体前往管理、新建并选用返回，名称和手工指令保持原样');
  let profile=await saveAgent();assert.equal(profile.processing_domain.id,second.id);assert.equal(profile.processing_domain.revision,1);assert.equal(profile.definition.domain_pack_ref,'general-assistant@1.0.0');assert.equal(profile.processing_domain.work_method,'逐项比较候选方案，以证据支撑推荐。');pass('新建智能体显式保存所选领域版本');
  await visit();await page.locator('#domain-row-'+second.id+' [data-domain-agents]').click();await page.locator('#agent-directory-results').waitFor();assert.equal(await page.locator('.agent-directory-row').count(),1);assert.equal(await page.evaluate(()=>state.agentDomain),second.id);pass('关联数量准确，入口定位到筛选后的智能体');
  await visit();await page.locator('#domain-row-'+second.id+' [data-domain-edit]').click();assert(await page.locator('#domain-method').isEditable());await page.locator('#domain-method').fill('先识别研究问题，再对比数据并给出可执行建议。');await page.locator('#domain-name').fill('产品与市场研究');await page.locator('#domain-description').fill('产品和市场研究资料的归纳与来源核对。');await page.locator('#domain-save').click();await page.locator('#domain-dialog').waitFor({state:'hidden'});
  assert.equal((await call('/api/agents/'+profile.id)).processing_domain.revision,1);
  await page.evaluate(id=>openAgent(id),profile.id);await page.locator('#agent-dialog[open]').waitFor();assert((await page.locator('#agent-domain-version').innerText()).includes('最新 v2'));await page.locator('[data-domain-upgrade]').click();await page.waitForFunction(()=>state.agentProcessingDomain?.revision===2);profile=await saveAgent(profile.id);assert.equal(profile.processing_domain.revision,2);assert.equal(profile.processing_domain.work_method,'先识别研究问题，再对比数据并给出可执行建议。');assert.equal(profile.definition.domain_pack_ref,'general-assistant@1.0.0');pass('工作方式可编辑且不改变执行配置，领域编辑不改写已有配置，可主动采用最新版本');
  await visit();await page.locator('#domain-row-'+second.id+' [data-domain-archive]').click();await page.locator('#confirm-submit').click();await page.locator('#confirm-dialog').waitFor({state:'hidden'});assert(!(await call('/api/agent-domains')).domains.some(d=>d.id===second.id));
  await page.evaluate(id=>openAgent(id),profile.id);await page.locator('#agent-dialog[open]').waitFor();assert((await page.locator('#agent-domain-version').innerText()).includes('已归档'));await next();await page.locator('#agent-prompt').fill(prompt+' 请用简洁的中文。');await page.locator('[data-agent-config-direction="1"]').click();const edited=page.waitForResponse(r=>r.url().endsWith('/api/agents/'+profile.id)&&r.request().method()==='POST');await page.locator('#agent-save').click();assert.equal((await(await edited).json()).processing_domain.revision,2);await page.locator('#agent-dialog').waitFor({state:'hidden'});pass('归档停止新选用，已有智能体仍能保留领域版本并保存修改');
  await visit();await page.locator('[data-domain-status="archived"]').click();await page.locator('#domain-row-'+second.id+' [data-domain-archive]').click();await page.locator('#confirm-submit').click();await page.locator('#confirm-dialog').waitFor({state:'hidden'});assert((await call('/api/agent-domains')).domains.some(d=>d.id===second.id));pass('归档领域可以恢复，恢复后重新进入可用列表');
  await page.locator('[data-domain-new]').first().click();await page.locator('#domain-name').fill('客户支持');await page.locator('#domain-description').fill('不同用途');await page.locator('#domain-save').click();await page.waitForFunction(()=>!state.domainEditorSaving);assert((await page.locator('#domain-error').innerText()).includes('同名'));await page.locator('#domain-dialog [data-close]').first().click();await page.locator('#confirm-submit').click();await page.locator('#domain-dialog').waitFor({state:'hidden'});pass('同名冲突可见，失败不会关闭表单');
  const layouts=[];
  for(const theme of ['light','dark'])for(const viewport of [{width:1440,height:1000},{width:768,height:1024},{width:375,height:812}]){
   await page.setViewportSize(viewport);await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);await page.screenshot({path:path.join(output,'domains-'+theme+'-'+viewport.width+'.png'),animations:'disabled'});
   const size=await page.evaluate(()=>({scroll:document.documentElement.scrollWidth,width:innerWidth}));assert(size.scroll<=size.width,JSON.stringify({theme,viewport,size}));layouts.push({theme,...viewport});
  }
  await page.locator('[data-domain-new]').first().click();await page.locator('#domain-name').fill('移动端表单');await page.screenshot({path:path.join(output,'domain-editor-mobile.png'),animations:'disabled'});const box=await page.locator('#domain-save').boundingBox();assert(box.y>=0&&box.y+box.height<=812);assert(box.height>=44);pass('浅深色、桌面、平板和手机无水平溢出，保存按钮可见且可触达');
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({checks,errors,layouts},null,2));
 }catch(error){await page.screenshot({path:path.join(output,'failure.png')}).catch(()=>{});fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({checks,errors,error:error.message},null,2));throw error;}
 finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1});
