'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{chromium}=require('playwright');
const base=process.env.WORKFLOW_SAVE_URL;if(!base)throw Error('Use the disposable workflow-saves fixture.');
const out=process.env.WORKFLOW_SAVE_OUTPUT;fs.mkdirSync(out,{recursive:true});
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'}),checks=[],errors=[],writes=[],layouts=[];
 page.setDefaultTimeout(12000);page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.method()==='POST'&&new URL(r.url()).pathname.startsWith('/api/workflows'))writes.push({path:new URL(r.url()).pathname,body:r.postDataJSON()});});
 const pass=label=>{checks.push(label);console.log('PASS '+label);},call=(url,data)=>page.evaluate(({url,data})=>api(url,data),{url,data});
 const save=()=>page.locator('#flow-editor-form [type=submit]').click(),action=name=>page.locator('[data-flow-save-action="'+name+'"]'),ready=()=>page.waitForFunction(()=>flowSaveEditor&&!flowSaveEditor.busy);
 const open=async value=>{await page.evaluate(value=>openVisualFlowEditor(value),value);await page.locator('#flow-editor-dialog').waitFor({state:'visible'});await page.locator('#flow-metadata summary').click();};
 const edit=value=>({name:value.name,description:value.description,nodes:value.nodes,revision:value.revision,request_id:'external-'+Date.now()});
 try{
  await page.goto(base);await page.waitForFunction(()=>state.connected);
  const space=await call('/api/workspaces',{name:'保存恢复验收',description:'隔离数据',business:'测试',scenario:'工作流编辑',revision:0});
  await page.goto(base+'?workspace_id='+space.id+'#/workflows');await page.waitForFunction(()=>state.connected&&state.view==='workflows'&&!state.busy);
  await page.locator('[data-flow-new]').first().click();await page.locator('#flow-name').fill('丢失响应的流程');await page.locator('[data-flow-create-agent]').click();
  await page.locator('[data-flow-agent-field=name]').fill('资料整理员');await page.locator('[data-flow-agent-field=description]').fill('整理待审资料');await page.locator('[data-flow-agent-field=prompt]').fill('列出资料中的事实和待确认事项。');await page.locator('[data-design-field=goal]').fill('汇总输入材料');
  let lose=true;await page.route('**/api/workflows',async route=>{if(route.request().method()!=='POST')return route.continue();if(lose){lose=false;await route.fetch();await route.abort('failed');}else await route.continue();});
  await save();await page.locator('#flow-editor-error').waitFor({state:'visible'});await ready();
  let directory=await call('/api/workflows'),saved=directory.workflows[0];assert.equal(directory.workflows.length,1);assert.equal((await call('/api/agents')).agents.length,1);
  await page.locator('#flow-name').fill('响应丢失后的新名称');await page.locator('[data-design-field=goal]').fill('汇总材料并标出日期');const count=writes.length;await save();await ready();assert.equal(writes.length,count);
  await action('review').click();await ready();assert.equal(writes.length,count);assert.equal(await page.locator('#flow-name').inputValue(),'响应丢失后的新名称');assert((await page.locator('#flow-save-recovery').innerText()).includes('原提交已保存'));
  pass('丢失响应后修改名称和节点，不会另发保存；只读核对保留后续输入');
  await action('keep').click();await ready();assert.equal(await page.locator('[data-flow-agent-field=prompt]').count(),0);await save();await page.locator('#flow-editor-dialog').waitFor({state:'hidden'});
  saved=(await call('/api/workflows/'+saved.id));assert.equal(saved.revision,2);assert.equal(saved.name,'响应丢失后的新名称');assert.equal(saved.nodes[0].goal,'汇总材料并标出日期');assert.equal((await call('/api/workflows')).workflows.length,1);assert.equal((await call('/api/agents')).agents.length,1);
  pass('继续保存复用原流程和专用智能体，仅增加一个流程版本');
  await open(saved);await page.locator('#flow-description').fill('保留本页说明');let current=await call('/api/workflows/'+saved.id,{...edit(saved),name:'另一窗口命名'});
  await save();await page.locator('#flow-editor-error').waitFor({state:'visible'});await ready();await action('review').click();await ready();assert((await page.locator('#flow-save-recovery').innerText()).includes('v3'));
  await action('keep').click();await ready();current=await call('/api/workflows/'+saved.id,{...edit(current),description:'再次修改'});await save();await ready();assert.equal((await call('/api/workflows/'+saved.id)).revision,4);assert.equal(await page.locator('#flow-description').inputValue(),'保留本页说明');
  await action('review').click();await ready();await action('keep').click();await ready();await save();await page.locator('#flow-editor-dialog').waitFor({state:'hidden'});saved=await call('/api/workflows/'+saved.id);assert.equal(saved.revision,5);assert.equal(saved.description,'保留本页说明');
  pass('核对后再次发生并发修改，旧版本仍被拒绝；明确重新核对后才能保存');
  await open(saved);await page.locator('#flow-name').fill('本页想另存的流程');let lostEdit=true;
  const editPattern='**/api/workflows/'+saved.id;await page.route(editPattern,async route=>{if(route.request().method()!=='POST'||!lostEdit)return route.continue();lostEdit=false;await route.fetch();await route.abort('failed');});
  await save();await page.locator('#flow-editor-error').waitFor({state:'visible'});await ready();await page.unroute(editPattern);
  current=await call('/api/workflows/'+saved.id);assert.equal(current.revision,6);const archived=await call('/api/workflows/'+saved.id+'/archive',{revision:6,archived:true});assert.equal(archived.revision,7);
  await action('review').click();await ready();assert.equal(await action('keep').count(),0);assert((await page.locator('#flow-save-recovery').innerText()).includes('已归档'));
  assert(await page.locator('#flow-editor-error').isHidden());
  for(const summary of await page.locator('#flow-save-recovery > details > summary').all())await summary.click();
  let css='';await page.route(base+'/__workflow-save-text.css?**',route=>route.fulfill({contentType:'text/css',body:css}));
  for(const theme of ['light','dark'])for(const width of [1024,1440])for(const scale of [1,2]){
   await page.locator('#flow-save-recovery').evaluate(e=>{for(const d of e.querySelectorAll('details'))d.open=true;});
   await page.setViewportSize({width,height:1000});await page.evaluate(theme=>document.documentElement.dataset.theme=theme,theme);const button=action('copy'),baseline=await button.evaluate(e=>parseFloat(getComputedStyle(e).fontSize));
   if(scale===2){css='#flow-save-recovery *{font-size:'+(baseline*2)+'px!important;line-height:1.5!important}';await page.evaluate(url=>new Promise((resolve,reject)=>{const el=document.createElement('link');el.id='flow-save-scale';el.rel='stylesheet';el.href=url;el.onload=resolve;el.onerror=()=>reject(Error('scale failed'));document.head.append(el);}),base+'/__workflow-save-text.css?case='+layouts.length);}
   await button.evaluate(e=>e.scrollIntoView({block:'center',behavior:'instant'}));await button.focus();const bounds=await button.evaluate(e=>{const d=document.querySelector('#flow-editor-dialog'),r=e.getBoundingClientRect();return {root:document.documentElement.scrollWidth,width:innerWidth,dialogWidth:d.clientWidth,dialogScroll:d.scrollWidth,focused:document.activeElement===e,top:r.top,bottom:r.bottom,font:parseFloat(getComputedStyle(e).fontSize)};});
   assert(bounds.root<=width+1);assert(bounds.dialogScroll<=bounds.dialogWidth+1);assert(bounds.focused);assert(bounds.top>=0&&bounds.bottom<=1000);if(scale===2)assert(bounds.font>=baseline*1.9);layouts.push({theme,width,scale,bounds});
   if(width===1440&&scale===1){await page.locator('#flow-save-recovery').evaluate(e=>{for(const d of e.querySelectorAll('details'))d.open=false;e.scrollIntoView({block:'center',behavior:'instant'});});await page.screenshot({path:path.join(out,'workflow-save-'+theme+'.png'),animations:'disabled'});}
   await page.evaluate(()=>document.querySelector('#flow-save-scale')?.remove());
  }
  pass('保存核对在浅深主题、1024/1440 宽度和两倍文字下无横向溢出，操作可聚焦');
  await action('copy').click();await ready();const beforeCopy=writes.length;assert.equal((await call('/api/workflows')).workflows.length,1);await save();await page.locator('#flow-editor-dialog').waitFor({state:'hidden'});directory=await call('/api/workflows');assert.equal(directory.workflows.length,2);assert.equal((await call('/api/agents')).agents.length,1);assert.equal(writes.length,beforeCopy+1);assert.equal((await call('/api/workflows/'+saved.id)).revision,7);
  pass('已归档版本只能明确另存或载入；另存保留原归档记录并复用已有智能体');
  const copy=directory.workflows.find(w=>w.id!==saved.id);await open(copy);await page.locator('#flow-name').fill('延迟保存');let release,reached;
  const waiting=new Promise(resolve=>{reached=resolve;});const hold=new Promise(resolve=>{release=resolve;});const copyPattern='**/api/workflows/'+copy.id;
  await page.route(copyPattern,async route=>{if(route.request().method()!=='POST')return route.continue();const response=await route.fetch();reached();await hold;await route.fulfill({response});});
  // Force a new editor owner to exercise the delayed callback guard separately
  // from the normal UI's unfinished-draft opening protection.
  await save();await waiting;await page.evaluate(value=>openVisualFlowEditor(value,{replaceDraft:true}),saved);const responseWait=page.waitForResponse(r=>r.url().endsWith('/api/workflows/'+copy.id)&&r.request().method()==='POST');release();await responseWait;
  await page.waitForFunction(()=>!flowSaveEditor.busy);assert.equal(await page.locator('#flow-name').inputValue(),saved.name);assert(await page.locator('#flow-editor-dialog').isVisible());await page.unroute(copyPattern);
  pass('旧编辑窗口的延迟保存回调不会关闭或覆盖后来打开的工作流');
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({checks,layouts,errors,writes:writes.map(w=>({path:w.path,request_id:w.body.request_id,revision:w.body.revision}))},null,2));
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
