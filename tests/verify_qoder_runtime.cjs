'use strict';
// Use an isolated service with a synthetic Qoder model catalog; never run against daily data.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright');
const base=process.env.QODER_TEST_BASE_URL;
if(!base)throw Error('请通过 QODER_TEST_BASE_URL 指定隔离验证服务。');
const output=process.env.QODER_TEST_OUTPUT||'/private/tmp/agent-framework-qoder-ui/results';fs.mkdirSync(output,{recursive:true});
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),checks=[],errors=[];
 page.on('pageerror',error=>errors.push(error.message));const pass=message=>{checks.push(message);console.log('PASS '+message);};
 const call=(url,data)=>page.evaluate(({url,data})=>api(url,data),{url,data});
 try{
  await page.goto(base+'/#/runtimes');await page.locator('#runtime-form').waitFor();await page.locator('[data-provider="qoder"]').click();
  await page.waitForFunction(()=>document.querySelector('#qoder-model option[value="qoder-fixture-model"]'));
  assert.equal(await page.locator('[data-provider]').count(),4);assert((await page.locator('[data-runtime-fields="qoder"]').innerText()).includes('qodercli login'));
  await page.locator('[data-action="detect-runtime"]').click();await page.waitForFunction(()=>document.querySelector('#runtime-detection')?.textContent.includes('检测完成'));pass('运行时目录包含 Qoder，登录提示和本机版本检测可用');
  await page.locator('#qoder-model').selectOption('qoder-fixture-model');await page.locator('#qoder-timeout').fill('45');await page.locator('#qoder-attempts').selectOption('3');await page.locator('#default-runtime').selectOption('qoder');
  await page.locator('#runtime-save').click();await page.locator('#runtime-form-success').waitFor({state:'visible'});
  const config=await call('/api/runtime-config');assert.equal(config.settings.default_runtime,'qoder');assert.equal(config.settings.profiles.qoder.timeout,45);assert.equal(config.settings.profiles.qoder.max_attempts,3);assert.equal((await call('/api/runs')).counts.total,0);pass('Qoder 模型、超时、修复次数及默认运行时可保存，保存不创建任务');
  await page.reload();await page.locator('[data-runtime-fields="qoder"]:visible').waitFor();assert.equal(await page.locator('#default-runtime').inputValue(),'qoder');
  await page.locator('[data-action="runtime-create-agent"]').click();await page.locator('#agent-dialog[open]').waitFor();assert.equal(await page.locator('#agent-runtime').inputValue(),'qoder');assert.equal(await page.locator('#agent-name').inputValue(),'');await page.locator('#agent-name').fill('Qoder 界面验证助手');
  await page.locator('[data-agent-config-direction="1"]').click();await page.waitForFunction(()=>!state.agentModelLoading);assert(await page.locator('#agent-effort-label').isHidden());assert.equal(await page.locator('#agent-model').inputValue(),'qoder-fixture-model');
  await page.locator('[data-agent-config-direction="1"]').click();const response=page.waitForResponse(r=>r.url().endsWith('/api/agents')&&r.request().method()==='POST');await page.locator('#agent-save').click();const profile=await(await response).json();await page.locator('#agent-dialog').waitFor({state:'hidden'});
  assert.equal(profile.runtime,'qoder');assert.deepEqual(profile.options,{timeout:45,max_attempts:3});assert((await page.locator('.agent-detail-inspector').innerText()).includes('Qoder CLI'));pass('从运行时创建智能体，正确绑定 Qoder 模型与执行参数');
  const compiled=await call('/api/agents/'+profile.id+'/compile',{revision:profile.revision});assert.equal(compiled.compiled_agent.runtime.ref,'qoder-planner@1.0.0');
  await page.locator('[data-agent-saved-use]').first().click();await page.locator('#create-dialog[open]').waitFor();await page.locator('#task-goal').fill('核对变更证据并给出风险评估。');assert((await page.locator('#task-agent-info').innerText()).includes('Qoder CLI'));assert.equal(await page.locator('#task-review,#task-next').count(),0);
  // Snapshot verification through the compatibility API deliberately does not start a model call.
  const run=await call('/api/runs',{goal:'核对变更证据并给出风险评估。',agent_id:profile.id,agent_revision:profile.revision,consent:true,grant:false,start:false});
  assert.equal(run.run.snapshot.planner.ref,'qoder-planner@1.0.0');assert.equal(run.run.snapshot.planner.config.model,'qoder-fixture-model');assert.equal(run.run.status,'CREATED');pass('简化任务界面沿用 Qoder 智能体配置，模型与参数进入冻结快照');
  await page.locator('#create-dialog [data-close]').first().click();if(await page.locator('#confirm-dialog').isVisible())await page.locator('#confirm-submit').click();await page.locator('#create-dialog').waitFor({state:'hidden'});
  await page.goto(base+'/#/runtimes');await page.locator('[data-runtime-fields="qoder"]:visible').waitFor();
  const current=(await call('/api/runtime-config')).settings;await call('/api/runtime-config',{profiles:current.profiles,default_runtime:current.default_runtime,revision:current.revision});
  await page.locator('#qoder-timeout').fill('44');await page.locator('#runtime-save').click();await page.locator('#runtime-form-error').waitFor({state:'visible'});assert((await page.locator('#runtime-form-error').innerText()).includes('更新'));assert.equal(await page.locator('#qoder-timeout').inputValue(),'44');pass('配置并发冲突拒绝覆盖，并保留用户填写的参数');
  await page.locator('[data-action="reload-runtime"]').click();await page.locator('[data-runtime-fields="qoder"]:visible').waitFor();
  await page.route('**/api/runtime-config/models?provider=qoder*',route=>route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({error:'Qoder CLI 尚未登录，请在终端执行 qodercli login 后刷新模型。'})}));
  await page.locator('[data-action="reload-models"][data-model-target="qoder"]').click();await page.waitForFunction(()=>document.querySelector('[data-model-status="qoder"]').textContent.includes('尚未登录'));pass('模型目录读取失败时显示登录引导，保留原配置供重试');
  const layouts=[];for(const theme of ['light','dark'])for(const viewport of [{width:1440,height:1000},{width:375,height:812}]){
   await page.setViewportSize(viewport);await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:path.join(output,'qoder-'+theme+'-'+viewport.width+'.png'),animations:'disabled'});layouts.push({theme,...viewport});
  }pass('Qoder 配置在浅深色、桌面和手机尺寸均无水平溢出');
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(output,'results.json'),JSON.stringify({checks,errors,layouts},null,2));
 }catch(error){await page.screenshot({path:path.join(output,'failure.png'),animations:'disabled'}).catch(()=>{});fs.writeFileSync(path.join(output,'failure.json'),JSON.stringify({checks,errors,error:error.message},null,2));throw error;}
 finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1});
