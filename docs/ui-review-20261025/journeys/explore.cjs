'use strict';
const {chromium}=require('playwright');
const fs=require('node:fs');
const H=require('../../../tests/ui95_helpers.cjs');
const out='docs/ui-review-20261025/journeys';
const results={startedAt:new Date().toISOString(),checks:[],findings:[],errors:[]};
(async()=>{
 const b=await chromium.launch({channel:'chrome',headless:true});
 const p=await b.newPage({viewport:{width:1440,height:1000}});
 p.on('pageerror',e=>results.errors.push(e.message));
 const screenshot=async name=>{await p.screenshot({path:out+'/'+name+'.png',fullPage:true,animations:'disabled'});};
 const check=async(id,fn)=>{try{const detail=await fn();results.checks.push({id,passed:true,detail});console.log('PASS '+id+' '+JSON.stringify(detail));}catch(e){results.checks.push({id,passed:false,error:e.message});await screenshot(id+'-failure').catch(()=>{});console.log('FAIL '+id+' '+e.message);}finally{await H.closeAll(p);await p.evaluate(()=>{taskJourney.returnToTask=false;taskJourney.initial='';state.skillManagementReturn=null;});}fs.writeFileSync(out+'/results.json',JSON.stringify(results,null,2));};
 try{
  const w=await H.workspace(p,'动线独立探索');results.workspace=w;
  const a=await H.agent(p,'change-assessment@2.0.0','动线评估助手');results.agent=a;
  await check('skill-copy-close',async()=>{
   await H.nav(p,'skills');const original=await p.evaluate(()=>state.skills.find(s=>s.builtin));
   await p.locator('#skill-card-'+original.id+' summary').click();await p.locator('[data-skill-copy="'+original.id+'"]').click();
   await p.locator('#skill-editor-dialog[open]').waitFor();const copied=await p.locator('#skill-folder').inputValue();
   if(!copied.endsWith('-copy'))throw Error('复制名称未派生');
   await p.locator('#skill-file-content').fill((await p.locator('#skill-file-content').inputValue())+'\n复制后未保存的说明');
   await p.locator('#skill-editor-dialog .dialog-head [data-close]').click();await p.locator('#confirm-dialog[open]').waitFor();
   await p.locator('#confirm-dialog [data-close]').first().click();await p.locator('#confirm-dialog').waitFor({state:'hidden'});
   await p.waitForFunction(()=>document.activeElement.id==='skill-file-content');const retained=await p.locator('#skill-file-content').inputValue();const focus=await p.evaluate(()=>document.activeElement.id);
   if(!retained.endsWith('复制后未保存的说明')||focus!=='skill-file-content')throw Error('取消放弃后内容或焦点未还原');
   await p.keyboard.press('Escape');await p.locator('#confirm-dialog[open]').waitFor();await p.locator('#confirm-submit').click();await p.locator('#skill-editor-dialog').waitFor({state:'hidden'});
   const saved=await p.evaluate(id=>api('/api/skills/'+id),original.id);
   if(saved.package.files['SKILL.md'].content.includes('复制后未保存的说明'))throw Error('复制改动泄漏到原包');
   return {original:original.name,copy:copied,cancelFocus:focus,originalUnchanged:true};
  });
  await check('private-preference-json-lifecycle',async()=>{
   await H.nav(p,'library');await p.locator('[data-hub-tab=memory]').click();await p.locator('[data-new-preference]').first().click();
   await p.locator('#asset-name').fill('动线中文风格偏好');await p.locator('#asset-content').fill('{broken');
   const isPrivate=await p.locator('#asset-visibility').inputValue(),isLocked=await p.locator('#asset-visibility').isDisabled();
   await p.locator('#asset-save').click();await p.locator('#asset-error').waitFor();const message=await p.locator('#asset-error').textContent();
   if(!message.includes('JSON'))throw Error('JSON 错误不明确');
   await p.locator('#asset-content').fill('{"language":"zh","report_style":"concise"}');
   const save=p.waitForResponse(r=>r.url().includes('/api/knowledge/assets')&&r.request().method()==='POST');await p.locator('#asset-save').click();const asset=await(await save).json();await p.locator('#asset-dialog').waitFor({state:'hidden'});await p.locator('[data-asset-op=review][data-ref="'+asset.ref+'"]').first().waitFor();
   await p.locator('[data-asset-op=review][data-ref="'+asset.ref+'"]').first().click();await p.locator('[data-asset-op=publish][data-ref="'+asset.ref+'"]').first().waitFor();await p.waitForFunction(()=>libraryPendingOperations.size===0);await p.locator('[data-asset-op=publish][data-ref="'+asset.ref+'"]').first().click();await p.locator('[data-asset-op=withdraw][data-ref="'+asset.ref+'"]').first().waitFor();await p.waitForFunction(()=>libraryPendingOperations.size===0);
   await p.locator('[data-asset-op=withdraw][data-ref="'+asset.ref+'"]').first().click();await p.waitForFunction(ref=>state.library.memory.preferences.find(a=>a.ref===ref)?.status==='WITHDRAWN',asset.ref);
   const row=p.locator('[id="library-asset-'+asset.ref+'"]');const status=await row.locator('.pill').first().textContent();
   if(isPrivate!=='PRIVATE'||!isLocked||!status.includes('撤回'))throw Error('私有锁定或撤回状态错误');
   await row.locator('[data-revise-asset]').click();const prior=await p.locator('#asset-content').inputValue();await p.locator('#asset-dialog [data-close]').first().click();
   return {privateValue:isPrivate,locked:isLocked,invalidJSON:message,ref:asset.ref,status,revisionPrefilled:prior};
  });
  await check('skill-search-composition',async()=>{
   await H.nav(p,'skills');await p.locator('#skill-search').focus();
   const during=await p.evaluate(()=>{const el=document.querySelector('#skill-search');el.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:'发布'}));el.value='发布';el.dispatchEvent(new InputEvent('input',{bubbles:true,data:'发布',inputType:'insertCompositionText',isComposing:true}));return {sameNode:el===document.querySelector('#skill-search'),focus:document.activeElement===el,value:el.value};});
   const after=await p.evaluate(()=>{const el=document.querySelector('#skill-search');el.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'发布'}));return new Promise(resolve=>queueMicrotask(()=>resolve({focus:document.activeElement.id,value:document.querySelector('#skill-search').value,query:state.skillQuery,composing:state.composing})));});
   if(!during.sameNode||!during.focus||!after.focus||after.value!=='发布')throw Error('组合输入节点或焦点丢失');
   await p.locator('[data-skill-clear]').first().click();return {during,after};
  });
  await check('task-agent-skill-roundtrip',async()=>{
   await H.nav(p,'agents');await p.locator('[data-agent-new-task="'+a.id+'"]').click();await p.locator('#task-goal').fill('保留目标并配置新的技能');await p.locator('#task-next').click();
   await p.locator('[data-action=open-runtime-config]').first().click();await p.locator('#agent-dialog[open]').waitFor();
   const manage=p.locator('#agent-dialog [data-manage-skills]:visible').first();await p.locator('#agent-config-tab-advanced').click();await p.locator('#agent-review-skills > summary').click();await manage.click();
   await p.locator('#agent-dialog').waitFor({state:'hidden'});await p.locator('[data-skill-return-agent]').waitFor();await p.locator('[data-skill-return-agent]').click();await p.locator('#agent-dialog[open]').waitFor();
   await p.locator('#agent-dialog .dialog-head [data-close]').click();await p.locator('#agent-dialog').waitFor({state:'hidden'});await p.getByRole('button',{name:'返回任务',exact:true}).click();await p.locator('#create-dialog[open]').waitFor();
   const value=await p.locator('#task-goal').inputValue(),grant=await p.locator('#create-form [name=grant]').isChecked();if(value!=='保留目标并配置新的技能'||grant)throw Error('配置往返目标或许可错误');
   await p.locator('#create-dialog .dialog-head [data-close]').click();await p.locator('#confirm-dialog[open]').waitFor();await p.locator('#confirm-submit').click();return {goal:value,writeGrant:grant};
  });
  let run;
  await check('evaluation-record-return-link',async()=>{
   await H.closeAll(p);run=await H.run(p,a.id,{scenario:'read-fails',expected:'FAILED'});results.run=run;
   await H.nav(p,'evaluations');await p.locator('[data-operation=evaluate-history]').click();await p.waitForFunction(()=>!state.busy);
   const record=p.locator('[data-view-evaluation]').first();await record.waitFor();await record.click();await p.locator('#operations-dialog[open]').waitFor();
   await p.locator('#operations-dialog a[href="#/workbench/'+run+'"]').click();await p.waitForFunction(()=>state.view==='workbench'&&!state.busy);
   const snapshot=await p.evaluate(()=>({view:state.view,selected:state.selected,openDialogs:[...document.querySelectorAll('dialog[open]')].map(d=>d.id),body:document.querySelector('#operations-dialog')?.innerText}));
   await screenshot('evaluation-return-link');
   if(snapshot.openDialogs.length){results.findings.push({id:'evaluation-modal-link-stays-open',impact:'评测记录中的查看原执行记录已更改页面，但模态记录仍遮住运行详情，且焦点保持在旧弹窗。',steps:['运行一个失败的 Mock Agent 任务','进入岗位评测并打开提醒的评测记录','点击弹窗内“查看原执行记录”'],expected:'关闭评测弹窗后展示所选原运行详情，并把焦点移到运行详情标题。',actual:snapshot,files:['agent_framework/webui/operations.js:69','agent_framework/webui/operations.js:26']});throw Error('原执行记录链接没有关闭评测弹窗');}return snapshot;
  });
  await H.closeAll(p);
  await check('daily-blocked-next-step',async()=>{
   await H.nav(p,'daily');await p.locator('[data-operation=schedule-edit]').first().click();await p.locator('#daily-task-add').click();await p.locator('#daily-goal-0').fill('每日派发受阻动线');await p.locator('#operations-form [type=submit]').click();await p.locator('#operations-dialog').waitFor({state:'hidden'});
   await p.locator('[data-operation=plan-generate]').click();await p.locator('[data-dispatch-plan]').first().waitFor();
   await p.evaluate(async id=>{const profile=await api('/api/agents/'+id);await api('/api/agents/'+id+'/archive',{revision:profile.revision,archived:true});},a.id);
   await p.locator('[data-dispatch-plan]').first().click();await p.waitForFunction(()=>state.dailyOperations?.plans[0]?.items.some(i=>i.status==='BLOCKED'));
   const snapshot=await p.locator('.daily-plan').first().innerText();await screenshot('daily-blocked-next-step');return {copy:snapshot,links:await p.locator('.daily-plan').first().locator('a').allTextContents()};
  });
  await check('all-eleven-routes',async()=>{const views=['workbench','runs','agents','daily','evaluations','workspaces','workflows','skills','library','registry','runtimes'],visited=[];for(const view of views){await p.locator('[data-nav="'+view+'"]').click();await p.waitForFunction(v=>state.view===v&&!state.busy,view);const h=await p.locator('#content h1').first().textContent();visited.push({view,h});}return visited;});
 }finally{results.finishedAt=new Date().toISOString();fs.writeFileSync(out+'/results.json',JSON.stringify(results,null,2));await b.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
